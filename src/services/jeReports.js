import { db } from '../db/connection.js';
import { audit } from '../audit/log.js';
import { notifyUserJe, sendNotificationEmail } from '../notify/mailer.js';
import { computeOutcome } from '../je/scoring.js';
import { evaluateLimits } from '../je/deadlines.js';
import { rankGaps } from '../je/gaps.js';
import { runJeChecks } from '../je/checks.js';
import { scanForbidden, shareBlockers, CHECKLIST_VERSION } from '../je/guard.js';
import { assembleState, loadReviewAuthorised, computeAndStoreOutcome } from './jobEvaluation.js';

// Report generation and issue. The numbers in every report are rendered
// server-side from computed outcomes — prose (template or AI) can never
// contradict them. Nothing reaches the member without sign-off + approval.

export const AUDIENCES = ['member', 'advisor', 'employer_submission'];
export const DISCLAIMER_VERSION = 'je-disclaimer-v1';

export const STANDARD_SENTENCE =
  'This is an indicative assessment prepared to help you gather and organise evidence. It is not a job evaluation and it does not decide your band. Only your employer’s job matching or job evaluation panel — which includes staff-side representatives — can determine a band.';

const todayIso = () => new Date().toISOString().slice(0, 10);

function factorName(bundle, code) {
  return bundle.factors.find((f) => f.code === code)?.name || code;
}

function confirmedLevels(state) {
  const levels = {};
  const confidence = {};
  for (const f of state.factors) {
    const usable = f.confirmed_decision && ['agree', 'amend'].includes(f.confirmed_decision);
    levels[f.factor_code] = usable ? f.confirmed_level : null;
    confidence[f.factor_code] = usable ? 'high' : 'insufficient';
  }
  return { levels, confidence };
}

function evidenceForFactor(state, code) {
  return state.evidence.filter((e) => e.factor_code === code && e.strength !== 'rejected');
}

function parseDutyLog(state) {
  const raw = state.answers.find((a) => a.question_code === 'duty_log')?.answer || '';
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr.slice(0, 30).map((d) => ({
        duty: String(d?.duty || '').slice(0, 300),
        since: String(d?.since || '').slice(0, 40),
        frequency: String(d?.frequency || '').slice(0, 60),
        evidence: String(d?.evidence || '').slice(0, 200),
      })).filter((d) => d.duty);
    }
  } catch { /* free text fallback */ }
  return raw
    ? raw.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 30).map((duty) => ({ duty: duty.slice(0, 300), since: '', frequency: '', evidence: '' }))
    : [];
}

// Latest valid AI report prose (stage 'report'), if any. Already validated
// by the pipeline before storage; forbidden-phrase-scanned again on merge.
function aiReportProse(reviewId) {
  const row = db
    .prepare(`SELECT output_json FROM ai_outputs WHERE je_review_id = ? AND je_stage = 'report' AND status = 'ok' ORDER BY id DESC LIMIT 1`)
    .get(Number(reviewId));
  if (!row) return null;
  try { return JSON.parse(row.output_json); } catch { return null; }
}

function buildActions(state, outcome, checks, gaps, bundle) {
  const actions = [];
  for (const gap of gaps) {
    actions.push({
      title: `Strengthen the evidence on ${gap.factorName.toLowerCase()}`,
      why: gap.reason === 'no_level'
        ? 'This area is currently unassessed, and resolving it could move the overall picture the most.'
        : 'The evidence here is thin, and firming it up could move the overall picture the most.',
      evidenceNeeded: 'Concrete examples, dates, or a document that shows this part of the job.',
      who: 'You, with Kelly',
      when: '',
    });
    if (actions.length >= 2) break;
  }
  for (const check of checks) {
    if (actions.length >= 5) break;
    if (['no_jd', 'jd_stale', 'appeal_window', 'time_limit_watch'].includes(check.id)) {
      actions.push({
        title: check.id === 'no_jd' ? 'Get a copy of your current job description'
          : check.id === 'jd_stale' ? 'Ask for your job description to be updated'
          : check.id === 'appeal_window' ? 'Check the appeal window in your employer’s JE procedure'
          : 'Confirm the key dates with Kelly',
        why: check.message,
        evidenceNeeded: '',
        who: check.id === 'no_jd' || check.id === 'jd_stale' ? 'You — ask your manager or HR' : 'You and Kelly',
        when: check.id === 'appeal_window' || check.id === 'time_limit_watch' ? 'Now' : '',
      });
    }
  }
  if (actions.length < 5) {
    actions.push({
      title: 'Talk the next formal step through with Kelly',
      why: 'The formal request is strongest when it goes in complete, through the right local procedure.',
      evidenceNeeded: '',
      who: 'You and Kelly',
      when: '',
    });
  }
  return actions.slice(0, 5);
}

function footerFor(state, signoff) {
  const r = state.bundle?.ruleset;
  return {
    standardSentence: STANDARD_SENTENCE,
    rulesetLabel: r?.label || 'No reference ruleset',
    rulesetChecksum: r ? r.checksum.slice(0, 12) : '',
    rulesetOrigin: r?.origin || '',
    rulesetVerified: !!r?.verified_at,
    disclaimerVersion: DISCLAIMER_VERSION,
    checklistVersion: signoff?.checklist_version || null,
    secondOpinion: state.secondOpinion
      ? 'recorded'
      : signoff?.second_opinion_required
        ? (signoff.second_opinion_waived_reason ? `waived: ${signoff.second_opinion_waived_reason}` : 'outstanding')
        : 'not required',
    datesNote: 'Dates shown are indicative and must be confirmed before you rely on them.',
  };
}

// ── Template renderers ────────────────────────────────────────────────────

function renderMemberBody(state, outcome, checks, gaps, limits) {
  const bundle = state.bundle;
  const ai = aiReportProse(state.review.id);
  const strongFactors = state.factors
    .filter((f) => ['agree', 'amend'].includes(f.confirmed_decision) && f.confirmed_level)
    .map((f) => ({ f, ev: evidenceForFactor(state, f.factor_code) }))
    .filter((x) => x.ev.length > 0)
    .sort((a, b) => b.ev.length - a.ev.length)
    .slice(0, 5);
  const insufficient = state.factors.filter((f) => f.confirmed_decision === 'insufficient');

  const why = strongFactors.map(({ f, ev }) => {
    const quote = ev.find((e) => e.quote)?.quote || '';
    return {
      area: factorName(bundle, f.factor_code),
      text: quote
        ? `You told us: “${quote.slice(0, 200)}” — this is exactly the kind of evidence that carries weight.`
        : `The evidence for ${factorName(bundle, f.factor_code).toLowerCase()} is well documented.`,
    };
  });

  const cleanAi = (text) => {
    const t = String(text || '').trim();
    return t && scanForbidden(t).length === 0 ? t : '';
  };

  return {
    audience: 'member',
    headline: {
      bandLow: outcome.bandLow, bandHigh: outcome.bandHigh, bandLabel: outcome.bandLabel,
      confidence: outcome.confidence, currentBand: state.review.current_band,
    },
    opening: cleanAi(ai?.openingPlainEnglish)
      || (outcome.bandLabel
        ? `Taken together, the evidence Kelly has confirmed points towards Band ${outcome.bandLabel}.`
        : outcome.bandLow
          ? `Taken together, the evidence Kelly has confirmed points towards the Band ${outcome.bandLow}–${outcome.bandHigh} range.`
          : 'There is not yet enough confirmed evidence to indicate a band.'),
    standardSentence: STANDARD_SENTENCE,
    whatWeLookedAt: `${state.documents.length} document(s), your answers to ${state.answers.filter((a) => a.answer).length} questions, and ${state.evidence.filter((e) => e.strength !== 'rejected').length} evidence points, reviewed area by area by Kelly.`,
    why,
    strong: strongFactors.length
      ? `The strongest parts of your case: ${strongFactors.map(({ f }) => factorName(bundle, f.factor_code).toLowerCase()).join('; ')}.`
      : 'Kelly will talk you through where your case is strongest.',
    thin: insufficient.length
      ? `Where more would help (an opportunity, not a failing): ${insufficient.map((f) => factorName(bundle, f.factor_code).toLowerCase()).join('; ')}.`
      : 'No major gaps — the evidence covers every area.',
    actions: buildActions(state, outcome, checks, gaps, bundle),
    dates: limits
      .filter((l) => l.limitDate || l.status === 'no_date')
      .map((l) => ({ label: l.label, date: l.limitDate, status: l.status, note: 'Indicative — confirm with Kelly before relying on this.' })),
    uncertainty: cleanAi(ai?.uncertainty) || '',
    footer: footerFor(state, state.signoff),
  };
}

function renderAdvisorBody(state, outcome, checks, limits) {
  const bundle = state.bundle;
  return {
    audience: 'advisor',
    summary: {
      member: state.review.member_id,
      jobTitle: state.review.job_title,
      currentBand: state.review.current_band,
      kind: state.review.kind,
      recommendation: state.signoff?.recommendation || null,
      totalPoints: outcome.totalPoints,
      bandLow: outcome.bandLow, bandHigh: outcome.bandHigh, bandLabel: outcome.bandLabel,
      amended: state.factors.filter((f) => f.confirmed_decision === 'amend').length,
      insufficient: state.factors.filter((f) => f.confirmed_decision === 'insufficient').length,
    },
    factorTable: state.factors.map((f) => ({
      factor: factorName(bundle, f.factor_code),
      factorCode: f.factor_code,
      claimed: f.claimed_level, ai: f.ai_level, aiConfidence: f.ai_confidence,
      confirmed: f.confirmed_level, decision: f.confirmed_decision, reasonCode: f.confirmed_reason_code,
      note: f.confirm_note,
      evidence: evidenceForFactor(state, f.factor_code).map((e) => ({ quote: e.quote, sourceKind: e.source_kind, documentId: e.document_id })),
    })),
    checks, limits,
    comparators: state.comparators,
    outcomeComputation: outcome,
    footer: footerFor(state, state.signoff),
  };
}

function renderEmployerBody(state, outcome, { includesBandRange = false } = {}) {
  const bundle = state.bundle;
  const duties = parseDutyLog(state);
  return {
    audience: 'employer_submission',
    request: {
      jobTitle: state.review.job_title,
      employer: state.review.employer,
      currentBand: state.review.current_band,
      kind: state.review.kind,
      date: todayIso(),
      text: `This is a request for the banding of the post of ${state.review.job_title} to be reviewed under the employer’s job evaluation procedure. The postholder asks that the post be considered against the duties as currently performed, set out below, with the attached evidence.`,
    },
    basis: state.review.duties_changed_since
      ? `The duties of the post have changed materially since ${state.review.duties_changed_since}. The role as now performed is set out in the duties table below, with evidence references.`
      : 'The postholder considers that the banding of the post does not reflect the duties as performed. The role as performed is set out in the duties table below, with evidence references.',
    dutiesTable: duties,
    factorTable: state.factors.map((f) => {
      const submitted = ['agree', 'amend'].includes(f.confirmed_decision) ? f.confirmed_level : null;
      const ev = evidenceForFactor(state, f.factor_code);
      return {
        factor: factorName(bundle, f.factor_code),
        levelSubmitted: submitted || 'No change claimed',
        justification: submitted
          ? (ev.find((e) => e.summary)?.summary || ev.find((e) => e.quote)?.quote || '').slice(0, 300)
          : '',
        evidenceRef: ev.length ? ev.map((e, i) => (e.document_id ? `Doc ${e.document_id}` : `Statement ${i + 1}`)).slice(0, 3).join(', ') : '',
      };
    }),
    // Anonymised unless the colleague explicitly consented to be named.
    comparators: state.comparators
      .filter((c) => c.status !== 'rejected')
      .map((c) => ({
        reference: c.named_consent ? c.comparator_ref : anonymiseComparator(c),
        band: c.band_label, basis: c.basis, sameEmployer: !!c.same_employer,
        similarity: c.similarity_note.slice(0, 300),
      })),
    ...(includesBandRange && (outcome.bandLow || outcome.bandLabel)
      ? { indicativeRange: { bandLow: outcome.bandLow, bandHigh: outcome.bandHigh, bandLabel: outcome.bandLabel } }
      : {}),
    outcomeSought: 'The postholder requests that the post be re-evaluated (or matched) against the duties as currently performed, and that the outcome, with reasons, be communicated in writing together with details of the review/appeal route.',
    annexes: [
      'A — Job description as currently held',
      'B — Duty log and evidence list',
      'C — Postholder’s statement',
    ],
    footer: footerFor(state, state.signoff),
  };
}

function anonymiseComparator(c) {
  // Strip anything that looks like a personal name down to a neutral label.
  return c.comparator_ref.replace(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g, 'A colleague');
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

export function generateReport(actor, reviewId, { audience, includesBandRange, includeRangeReason } = {}) {
  const loaded = loadReviewAuthorised(actor, reviewId);
  if (loaded.error) return loaded;
  if (!loaded.isAdvisor) return { error: 'Review not found.', status: 404 };
  if (!AUDIENCES.includes(audience)) return { error: 'Unknown report audience.', status: 400 };
  const state = assembleState(reviewId);
  if (!state.bundle) return { error: 'No reference ruleset — reports are unavailable.', status: 503 };
  if (audience !== 'advisor' && !state.signoff) {
    return { error: 'Sign off the assessment before generating a member or employer report.', status: 400 };
  }

  const { levels, confidence } = confirmedLevels(state);
  const outcome = computeOutcome(state.bundle, levels, confidence);
  const limits = evaluateLimits(state.bundle.limitationRules, {}, todayIso());
  const checks = runJeChecks({ ...state, outcome, limits, priorConfirmedStats: { varianceFactors: [] } });
  const gaps = rankGaps(state.bundle, levels, confidence);

  // Employer submissions exclude the indicative range unless Kelly opts in
  // with a recorded reason — publishing a self-assessed band to a panel
  // usually weakens the member's position.
  const includeRange = audience === 'employer_submission' ? includesBandRange === true : true;
  if (audience === 'employer_submission' && includeRange && !String(includeRangeReason || '').trim()) {
    return { error: 'Including the indicative range in an employer submission needs a recorded reason.', status: 400 };
  }

  const body =
    audience === 'member' ? renderMemberBody(state, outcome, checks, gaps, limits)
    : audience === 'advisor' ? renderAdvisorBody(state, outcome, checks, limits)
    : renderEmployerBody(state, outcome, { includesBandRange: includeRange });

  const version = (db
    .prepare('SELECT MAX(report_version) AS v FROM je_reports WHERE review_id = ? AND audience = ?')
    .get(state.review.id, audience).v || 0) + 1;
  const latestOutcome = db
    .prepare(`SELECT id FROM je_outcomes WHERE review_id = ? AND basis = 'confirmed' ORDER BY id DESC LIMIT 1`)
    .get(state.review.id) || computeAndStoreOutcomeRef(state.review.id, actor.id);
  const info = db
    .prepare(
      `INSERT INTO je_reports (review_id, outcome_id, audience, report_version, status, includes_band_range, include_range_reason, body_json, generated_by)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`
    )
    .run(
      state.review.id, latestOutcome?.id || null, audience, version,
      includeRange ? 1 : 0, String(includeRangeReason || '').trim().slice(0, 300),
      JSON.stringify(body), aiReportProse(state.review.id) ? 'ai' : 'template'
    );
  audit(actor.id, 'je.report_generated', 'je_review', state.review.id, {
    reportId: info.lastInsertRowid, audience, version, includesBandRange: includeRange,
  });
  return { ok: true, reportId: info.lastInsertRowid, audience, version, body };
}

function computeAndStoreOutcomeRef(reviewId, actorId) {
  const r = computeAndStoreOutcome(reviewId, 'confirmed', actorId);
  return r.ok ? { id: r.outcomeId } : null;
}

// Editable prose fields per audience (numbers are never editable — they are
// re-rendered from outcomes).
const EDITABLE_FIELDS = {
  member: ['opening', 'strong', 'thin', 'uncertainty'],
  employer_submission: ['basis', 'outcomeSought'],
  advisor: [],
};

// Approve-and-issue with the claim-then-execute idiom: a lost race returns
// 410, never a double-issue. Member reports must pass the share gate.
export function approveReport(actor, reportId, { edits } = {}) {
  const report = db.prepare('SELECT * FROM je_reports WHERE id = ?').get(Number(reportId));
  if (!report) return { error: 'Report not found.', status: 404 };
  const loaded = loadReviewAuthorised(actor, report.review_id);
  if (loaded.error) return loaded;
  if (!loaded.isAdvisor) return { error: 'Report not found.', status: 404 };

  const body = JSON.parse(report.body_json);
  const allowed = EDITABLE_FIELDS[report.audience] || [];
  if (edits && typeof edits === 'object') {
    for (const [field, value] of Object.entries(edits)) {
      if (!allowed.includes(field)) return { error: `Field "${field}" is not editable.`, status: 400 };
      const text = String(value || '').trim().slice(0, 3000);
      const forbidden = scanForbidden(text);
      if (forbidden.length > 0) return { error: `The edited ${field} asserts an outcome this service must not assert. Please reword.`, status: 400 };
      body[field] = text;
    }
  }

  // The share gate, simulated with this report approved.
  if (report.audience !== 'advisor') {
    const state = assembleState(report.review_id);
    const blockers = shareBlockers({ ...state, report: { ...report, status: 'approved' } });
    if (blockers.length > 0) return { error: `Cannot approve yet: ${blockers.join(' ')}`, status: 400, blockers };
  }

  const claimed = db
    .prepare(`UPDATE je_reports SET status = 'approved', approved_by = ?, approved_at = datetime('now'), body_json = ? WHERE id = ? AND status = 'draft'`)
    .run(actor.id, JSON.stringify(body), report.id);
  if (claimed.changes !== 1) return { error: 'This report was already handled elsewhere.', status: 410 };

  let messageId = null;
  if (report.audience === 'member') {
    const info = db
      .prepare(`INSERT INTO je_messages (review_id, author_user_id, visibility, kind, content, approved_by, meta) VALUES (?, ?, 'member', 'report', ?, ?, ?)`)
      .run(report.review_id, actor.id, 'Your band review report is ready. Open it from this review.', actor.id, JSON.stringify({ reportId: report.id }));
    messageId = info.lastInsertRowid;
    db.prepare(`UPDATE je_reports SET status = 'issued', issued_at = datetime('now'), je_message_id = ? WHERE id = ?`).run(messageId, report.id);
    const review = loaded.review;
    notifyUserJe(review.member_id, 'je_report_ready', 'Your band review report is ready', review.id);
    sendNotificationEmail(review.member_id, 'Kelly Online: your band review report is ready', 'Sign in to Kelly Online to read your band review report.');
  }
  audit(actor.id, 'je.report_approved', 'je_review', report.review_id, {
    reportId: report.id, audience: report.audience, edited: !!edits && Object.keys(edits).length > 0, messageId,
  });
  return { ok: true, reportId: report.id, status: report.audience === 'member' ? 'issued' : 'approved', messageId };
}

// Issued reports are never mutated — withdrawal supersedes them.
export function withdrawReport(actor, reportId) {
  const report = db.prepare('SELECT * FROM je_reports WHERE id = ?').get(Number(reportId));
  if (!report) return { error: 'Report not found.', status: 404 };
  const loaded = loadReviewAuthorised(actor, report.review_id);
  if (loaded.error) return loaded;
  if (!loaded.isAdvisor) return { error: 'Report not found.', status: 404 };
  if (!['approved', 'issued'].includes(report.status)) return { error: 'Only an approved or issued report can be withdrawn.', status: 400 };
  db.prepare(`UPDATE je_reports SET status = 'withdrawn' WHERE id = ?`).run(report.id);
  audit(actor.id, 'je.report_withdrawn', 'je_review', report.review_id, { reportId: report.id, audience: report.audience });
  return { ok: true };
}

// Plain-markdown render of an employer submission — something Kelly can
// paste into an email or Word without fighting a PDF.
export function submissionMarkdown(body) {
  const lines = [];
  lines.push(`# Request for job evaluation review — ${body.request.jobTitle}`);
  lines.push('');
  lines.push(`**Employer:** ${body.request.employer || '—'}  `);
  lines.push(`**Current band:** ${body.request.currentBand || '—'}  `);
  lines.push(`**Date:** ${body.request.date}`);
  lines.push('');
  lines.push('## 1. Request');
  lines.push(body.request.text);
  lines.push('');
  lines.push('## 2. Basis of the request');
  lines.push(body.basis);
  lines.push('');
  lines.push('## 3. Duties as currently performed');
  lines.push('');
  lines.push('| Duty | Frequency | In post since | Evidence |');
  lines.push('| --- | --- | --- | --- |');
  for (const d of body.dutiesTable) {
    lines.push(`| ${md(d.duty)} | ${md(d.frequency)} | ${md(d.since)} | ${md(d.evidence)} |`);
  }
  if (body.dutiesTable.length === 0) lines.push('| (see attached statement) | | | |');
  lines.push('');
  lines.push('## 4. Factor-level submission');
  lines.push('');
  lines.push('| Factor | Level submitted | Justification | Evidence ref |');
  lines.push('| --- | --- | --- | --- |');
  for (const f of body.factorTable) {
    lines.push(`| ${md(f.factor)} | ${md(f.levelSubmitted)} | ${md(f.justification)} | ${md(f.evidenceRef)} |`);
  }
  lines.push('');
  if ((body.comparators || []).length > 0) {
    lines.push('## 5. Comparators');
    lines.push('');
    for (const c of body.comparators) {
      lines.push(`- ${md(c.reference)} — Band ${md(c.band) || '—'} (${md(c.basis).replace(/_/g, ' ')}${c.sameEmployer ? ', same employer' : ''}). ${md(c.similarity)}`);
    }
    lines.push('');
  }
  if (body.indicativeRange) {
    lines.push(`> Indicative assessment range prepared with the postholder's adviser: Band ${body.indicativeRange.bandLow}–${body.indicativeRange.bandHigh}. This is indicative only; the panel's evaluation governs.`);
    lines.push('');
  }
  lines.push('## 6. Outcome sought');
  lines.push(body.outcomeSought);
  lines.push('');
  lines.push('## Annexes');
  for (const a of body.annexes) lines.push(`- ${a}`);
  lines.push('');
  lines.push('---');
  lines.push(`*${body.footer.standardSentence}*`);
  lines.push('');
  lines.push(`*Reference data: ${body.footer.rulesetLabel} (${body.footer.rulesetChecksum}${body.footer.rulesetVerified ? ', verified' : ', not yet verified'}). ${body.footer.datesNote}*`);
  return lines.join('\n');
}

function md(v) {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
