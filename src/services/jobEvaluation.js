import { db } from '../db/connection.js';
import { audit } from '../audit/log.js';
import { notifyUser, notifyUserJe, sendNotificationEmail } from '../notify/mailer.js';
import { userHas } from '../rbac/permissions.js';
import { activeRuleset, getRulesetBundle, referenceReady } from '../je/reference.js';
import { computeOutcome, matchProfile } from '../je/scoring.js';
import { runJeChecks } from '../je/checks.js';
import { evaluateLimits } from '../je/deadlines.js';
import { rankGaps } from '../je/gaps.js';
import { assessJeSignals } from '../safety/jeUrgency.js';
import {
  CHECKLIST_VERSION, CHECKLIST_ITEMS, AMEND_REASON_CODES,
  scanForbidden, shareBlockers, secondOpinionRequired,
} from '../je/guard.js';
import { QUESTIONS, QUESTION_CODES, QUESTION_GROUPS, QUESTION_SET_VERSION } from '../je/questions.js';

// Job evaluation & banding: the standalone review lifecycle. Business logic
// lives here (thin routers, assistant tools and the pipeline all call in);
// every mutation audits ids/codes only — never evidence text.

export const REVIEW_KINDS = ['band_review', 'job_match', 'new_post', 'appeal', 'equal_pay'];
export const DOC_ROLES = ['jd', 'person_spec', 'org_chart', 'appraisal', 'rota', 'payslip', 'comparator_jd', 'outcome_letter', 'other'];
export const CONSENT_VERSION = 'je-consent-v1';

export const STAGES = [
  'draft', 'member_submitted', 'analysing', 'advisor_review', 'report_ready',
  'submitted_to_employer', 'employer_review', 'outcome_received',
  'appeal_lodged', 'appeal_outcome', 'closed',
];

const STAGE_TRANSITIONS = {
  draft: ['member_submitted', 'closed'],
  member_submitted: ['analysing', 'advisor_review', 'closed'],
  analysing: ['advisor_review', 'member_submitted', 'closed'],
  advisor_review: ['report_ready', 'analysing', 'member_submitted', 'closed'],
  report_ready: ['submitted_to_employer', 'advisor_review', 'closed'],
  submitted_to_employer: ['employer_review', 'outcome_received', 'closed'],
  employer_review: ['outcome_received', 'closed'],
  outcome_received: ['appeal_lodged', 'closed'],
  appeal_lodged: ['appeal_outcome', 'closed'],
  appeal_outcome: ['closed', 'advisor_review'],
  closed: ['advisor_review'],
};

// Plain-English stage labels for members (no process jargon).
export const MEMBER_STAGE_LABELS = {
  draft: 'Getting started',
  member_submitted: 'Sent to Kelly',
  analysing: 'Being prepared',
  advisor_review: 'Kelly is working through it',
  report_ready: 'Your report is ready',
  submitted_to_employer: 'With your employer',
  employer_review: 'With your employer',
  outcome_received: 'Outcome received',
  appeal_lodged: 'Appeal in progress',
  appeal_outcome: 'Appeal outcome received',
  closed: 'Closed',
};

const nowStamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const todayIso = () => new Date().toISOString().slice(0, 10);

function advisorUserIds() {
  return db
    .prepare(`SELECT DISTINCT u.id FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = 'advisor' AND u.status = 'active'`)
    .all()
    .map((r) => r.id);
}

function touch(reviewId) {
  db.prepare(`UPDATE je_reviews SET updated_at = datetime('now') WHERE id = ?`).run(reviewId);
}

// Member may only load their own review; advisors may load any.
// 404 (never 403) so existence is not revealed.
export function loadReviewAuthorised(user, reviewId) {
  const review = db.prepare('SELECT * FROM je_reviews WHERE id = ?').get(Number(reviewId));
  if (!review) return { error: 'Review not found.', status: 404 };
  const isOwner = review.member_id === user.id;
  const isAdvisor = userHas(user, 'je.review');
  if (!isOwner && !isAdvisor) return { error: 'Review not found.', status: 404 };
  return { review, isOwner, isAdvisor };
}

// ── Creation & the member path ────────────────────────────────────────────

export function createReview(actor, fields) {
  const kind = REVIEW_KINDS.includes(fields.kind) ? fields.kind : 'band_review';
  const jobTitle = String(fields.jobTitle || '').trim().slice(0, 120);
  if (jobTitle.length < 2) return { error: 'Please tell us your job title.', status: 400 };
  if (fields.riskAcknowledged !== true) {
    return { error: 'Please read and acknowledge how a band review can turn out before starting.', status: 400 };
  }
  const active = activeRuleset('afc');
  const info = db
    .prepare(
      `INSERT INTO je_reviews (member_id, kind, job_title, employer, staff_group_code, current_band, claimed_band,
         in_post_since, duties_changed_since, ruleset_id, question_set_version, risk_acknowledged_at, consent_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`
    )
    .run(
      actor.id, kind, jobTitle,
      String(fields.employer || '').trim().slice(0, 120),
      String(fields.staffGroupCode || '').trim().slice(0, 60),
      String(fields.currentBand || '').trim().slice(0, 8),
      String(fields.claimedBand || '').trim().slice(0, 8),
      dateOrNull(fields.inPostSince), dateOrNull(fields.dutiesChangedSince),
      active?.id || null, QUESTION_SET_VERSION, CONSENT_VERSION
    );
  const reviewId = info.lastInsertRowid;
  // One assessment row per factor, created up front so the three writer
  // column-groups (member / AI / advisor) always have a home row.
  if (active) {
    const bundle = getRulesetBundle(active.id);
    const stmt = db.prepare('INSERT INTO je_factor_assessments (review_id, factor_code) VALUES (?, ?)');
    for (const f of bundle.factors) stmt.run(reviewId, f.code);
  }
  audit(actor.id, 'je.review_created', 'je_review', reviewId, { kind, rulesetId: active?.id || null });
  return { ok: true, reviewId, questions: questionPayload(), stage: 'draft' };
}

function dateOrNull(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
}

export function questionPayload() {
  return { version: QUESTION_SET_VERSION, groups: QUESTION_GROUPS, questions: QUESTIONS.map(({ code, group, prompt, cue, optional }) => ({ code, group, prompt, cue, optional: !!optional })) };
}

export function listReviewsForMember(userId) {
  const rows = db
    .prepare(`SELECT * FROM je_reviews WHERE member_id = ? ORDER BY updated_at DESC`)
    .all(userId);
  return { ok: true, reviews: rows.map(memberReviewCard) };
}

function memberReviewCard(r) {
  const answered = db.prepare('SELECT COUNT(*) AS n FROM je_answers WHERE review_id = ? AND length(answer) > 0').get(r.id).n;
  return {
    id: r.id, kind: r.kind, stage: r.stage, stageLabel: MEMBER_STAGE_LABELS[r.stage] || r.stage,
    jobTitle: r.job_title, employer: r.employer, currentBand: r.current_band,
    answered, questionCount: QUESTIONS.length,
    memberEditable: !!r.member_editable, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// Member view: stage, own answers/claims, questions from Kelly, documents,
// APPROVED reports only. Never AI proposals, never advisor working data.
export function getReviewForMember(user, reviewId) {
  const loaded = loadReviewAuthorised(user, reviewId);
  if (loaded.error) return loaded;
  const { review, isOwner } = loaded;
  if (!isOwner) return { error: 'Review not found.', status: 404 };

  const answers = db.prepare('SELECT question_code, answer, updated_at FROM je_answers WHERE review_id = ?').all(review.id);
  const documents = db
    .prepare('SELECT id, doc_role, original_filename, media_type, size_bytes, status, document_dated, created_at FROM je_documents WHERE review_id = ? ORDER BY id')
    .all(review.id);
  const comparators = db.prepare('SELECT * FROM je_comparators WHERE review_id = ? ORDER BY id').all(review.id);
  const messages = db
    .prepare(`SELECT id, author_user_id, kind, content, created_at FROM je_messages WHERE review_id = ? AND visibility = 'member' ORDER BY id`)
    .all(review.id);
  const reports = db
    .prepare(`SELECT id, audience, report_version, status, includes_band_range, body_json, approved_at, issued_at FROM je_reports WHERE review_id = ? AND status IN ('approved', 'issued') ORDER BY id DESC`)
    .all(review.id)
    .map((r) => ({ ...r, body: JSON.parse(r.body_json), body_json: undefined }));
  const claims = db
    .prepare('SELECT factor_code, claimed_level, claimed_note FROM je_factor_assessments WHERE review_id = ?')
    .all(review.id);

  return {
    ok: true,
    review: {
      ...memberReviewCard(review),
      answersVersion: review.answers_version,
      claimedBand: review.claimed_band,
      inPostSince: review.in_post_since,
      dutiesChangedSince: review.duties_changed_since,
      staffGroupCode: review.staff_group_code,
    },
    answers: Object.fromEntries(answers.map((a) => [a.question_code, a.answer])),
    questions: questionPayload(),
    documents, comparators, messages, reports, claims,
  };
}

// Delta answer save with optimistic locking. A stale write returns 409 with
// the server's current state so the client can merge, never silently lose.
export function saveAnswers(actor, reviewId, { expectedVersion, answers }) {
  const loaded = loadReviewAuthorised(actor, reviewId);
  if (loaded.error) return loaded;
  const { review, isOwner } = loaded;
  if (!isOwner) return { error: 'Review not found.', status: 404 };
  if (!review.member_editable) return { error: 'Kelly is reviewing this right now — editing is paused. Message her if something needs changing.', status: 409 };
  if (review.stage === 'closed') return { error: 'This review is closed.', status: 400 };
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return { error: 'No answers received.', status: 400 };

  if (Number(expectedVersion) !== review.answers_version) {
    const current = db.prepare('SELECT question_code, answer FROM je_answers WHERE review_id = ?').all(review.id);
    return {
      error: 'These answers were changed somewhere else since this device last saved.',
      status: 409,
      answersVersion: review.answers_version,
      answers: Object.fromEntries(current.map((a) => [a.question_code, a.answer])),
    };
  }

  const entries = Object.entries(answers).filter(([code]) => QUESTION_CODES.has(code) || code === 'duty_log');
  if (entries.length === 0) return { error: 'No recognisable answers received.', status: 400 };
  const stmt = db.prepare(
    `INSERT INTO je_answers (review_id, question_code, answer, answered_by, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(review_id, question_code) DO UPDATE SET answer = excluded.answer, answered_by = excluded.answered_by, updated_at = datetime('now')`
  );
  for (const [code, value] of entries) {
    stmt.run(review.id, code, String(value ?? '').slice(0, 8000), actor.id);
  }
  db.prepare(`UPDATE je_reviews SET answers_version = answers_version + 1, updated_at = datetime('now') WHERE id = ?`).run(review.id);
  audit(actor.id, 'je.answers_saved', 'je_review', review.id, { count: entries.length });
  return { ok: true, answersVersion: review.answers_version + 1 };
}

export function setClaimedLevel(actor, reviewId, factorCode, { claimedLevel, claimedNote }) {
  const loaded = loadReviewAuthorised(actor, reviewId);
  if (loaded.error) return loaded;
  if (!loaded.isOwner) return { error: 'Review not found.', status: 404 };
  const info = db
    .prepare(
      `UPDATE je_factor_assessments SET claimed_level = ?, claimed_note = ?, updated_at = datetime('now')
       WHERE review_id = ? AND factor_code = ?`
    )
    .run(String(claimedLevel || '').slice(0, 4) || null, String(claimedNote || '').slice(0, 2000), loaded.review.id, String(factorCode));
  if (info.changes !== 1) return { error: 'Unknown factor.', status: 404 };
  touch(loaded.review.id);
  return { ok: true };
}

export function addComparator(actor, reviewId, fields) {
  const loaded = loadReviewAuthorised(actor, reviewId);
  if (loaded.error) return loaded;
  const { review, isOwner, isAdvisor } = loaded;
  if (!isOwner && !isAdvisor) return { error: 'Review not found.', status: 404 };
  const ref = String(fields.comparatorRef || '').trim().slice(0, 120);
  if (!ref) return { error: 'Describe the comparator (for example "A colleague in my team, Band 6") — no name is needed.', status: 400 };
  const kinds = ['colleague', 'same_employer_other_post', 'other_employer', 'national_profile', 'advert'];
  const bases = ['like_work', 'work_rated_as_equivalent', 'equal_value'];
  const info = db
    .prepare(
      `INSERT INTO je_comparators (review_id, comparator_ref, kind, same_employer, band_label, basis, is_actual_person, named_consent, similarity_note, difference_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      review.id, ref,
      kinds.includes(fields.kind) ? fields.kind : 'colleague',
      fields.sameEmployer === false ? 0 : 1,
      String(fields.bandLabel || '').trim().slice(0, 8),
      bases.includes(fields.basis) ? fields.basis : 'like_work',
      fields.isActualPerson === false ? 0 : 1,
      fields.namedConsent === true ? 1 : 0,
      String(fields.similarityNote || '').slice(0, 2000),
      String(fields.differenceNote || '').slice(0, 2000)
    );
  touch(review.id);
  audit(actor.id, 'je.comparator_added', 'je_review', review.id, { comparatorId: info.lastInsertRowid, kind: fields.kind || 'colleague', namedConsent: fields.namedConsent === true });
  return { ok: true, comparatorId: info.lastInsertRowid };
}

export function postMessage(actor, reviewId, { content, kind = 'message', visibility = 'member' }) {
  const loaded = loadReviewAuthorised(actor, reviewId);
  if (loaded.error) return loaded;
  const { review, isOwner, isAdvisor } = loaded;
  const text = String(content || '').trim();
  if (!text) return { error: 'Message is empty.', status: 400 };
  if (review.stage === 'closed') return { error: 'This review is closed.', status: 400 };

  let vis = 'member';
  let k = 'message';
  let approvedBy = null;
  if (isAdvisor && !isOwner) {
    vis = visibility === 'advisor_private' ? 'advisor_private' : 'member';
    k = ['message', 'question', 'note'].includes(kind) ? kind : 'message';
    if (vis === 'member') {
      const forbidden = scanForbidden(text);
      if (forbidden.length > 0) {
        return { error: 'That message asserts an outcome this service must not assert (a band, a guarantee, or an expired deadline). Please reword.', status: 400 };
      }
      approvedBy = actor.id;
    }
  }
  const info = db
    .prepare(`INSERT INTO je_messages (review_id, author_user_id, visibility, kind, content, approved_by) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(review.id, actor.id, vis, k, text.slice(0, 8000), approvedBy);
  touch(review.id);

  if (isAdvisor && !isOwner && vis === 'member') {
    if (k === 'question') db.prepare(`UPDATE je_reviews SET member_editable = 1 WHERE id = ?`).run(review.id);
    notifyUserJe(review.member_id, 'je_question', k === 'question' ? 'Kelly has questions about your band review' : 'Kelly has replied on your band review', review.id);
    sendNotificationEmail(review.member_id, 'Kelly Online: there is an update on your band review', 'Sign in to Kelly Online to read the update on your band review.');
  } else if (isOwner) {
    for (const advisorId of advisorUserIds()) {
      notifyUserJe(advisorId, 'je_message', `Member replied on band review #${review.id}`, review.id);
    }
  }
  audit(actor.id, `je.${isOwner ? 'member' : 'advisor'}_message`, 'je_review', review.id, { kind: k, visibility: vis });
  return { ok: true, messageId: info.lastInsertRowid };
}

// Idempotent submit: only fires from draft; a double-tap cannot re-notify.
export function submitReview(actor, reviewId) {
  const loaded = loadReviewAuthorised(actor, reviewId);
  if (loaded.error) return loaded;
  const { review, isOwner } = loaded;
  if (!isOwner) return { error: 'Review not found.', status: 404 };
  if (review.stage !== 'draft') return { ok: true, stage: review.stage, alreadySubmitted: true };

  // Deterministic signals over the member's own words.
  const answerText = db.prepare('SELECT answer FROM je_answers WHERE review_id = ?').all(review.id).map((a) => a.answer).join('\n');
  const signals = assessJeSignals(answerText);
  const urgency = signals.urgency;

  const info = db
    .prepare(`UPDATE je_reviews SET stage = 'member_submitted', urgency = ?, urgency_reason = ?, updated_at = datetime('now') WHERE id = ? AND stage = 'draft'`)
    .run(urgency, signals.triggers.map((t) => t.reason).join('; ') || null, review.id);
  if (info.changes !== 1) return { ok: true, stage: 'member_submitted', alreadySubmitted: true };

  for (const t of signals.triggers) {
    db.prepare(`INSERT INTO je_flags (review_id, rule_id, severity, reason, detected_by) VALUES (?, ?, ?, ?, 'rules')`)
      .run(review.id, t.id, t.severity, t.reason);
  }
  runChecksAndFlags(review.id);

  for (const advisorId of advisorUserIds()) {
    notifyUserJe(advisorId, 'je_submitted', urgency !== 'normal' ? `Band review #${review.id} needs attention` : `New band review #${review.id}`, review.id);
    if (urgency !== 'normal') sendNotificationEmail(advisorId, 'Kelly Online: a band review needs attention', 'A band review has triggered urgency rules. Sign in to view it.');
  }
  audit(actor.id, 'je.submitted', 'je_review', review.id, { urgency, triggers: signals.triggers.map((t) => t.id) });
  return { ok: true, stage: 'member_submitted', urgency };
}

// ── Assembled state, outcomes and checks ─────────────────────────────────

export function assembleState(reviewId) {
  const review = db.prepare('SELECT * FROM je_reviews WHERE id = ?').get(Number(reviewId));
  if (!review) return null;
  const bundle = review.ruleset_id ? getRulesetBundle(review.ruleset_id) : null;
  const factors = db.prepare('SELECT * FROM je_factor_assessments WHERE review_id = ? ORDER BY factor_code').all(review.id);
  const evidence = db.prepare('SELECT * FROM je_evidence WHERE review_id = ? ORDER BY id').all(review.id);
  const documents = db.prepare('SELECT * FROM je_documents WHERE review_id = ? ORDER BY id').all(review.id);
  const comparators = db.prepare('SELECT * FROM je_comparators WHERE review_id = ? ORDER BY id').all(review.id);
  const decisions = db.prepare('SELECT * FROM je_decisions WHERE review_id = ? ORDER BY id').all(review.id);
  const flags = db.prepare('SELECT * FROM je_flags WHERE review_id = ? ORDER BY id').all(review.id);
  const answers = db.prepare('SELECT * FROM je_answers WHERE review_id = ?').all(review.id);
  const signoff = db.prepare(`SELECT * FROM je_signoffs WHERE review_id = ? AND review_role = 'primary' ORDER BY id DESC LIMIT 1`).get(review.id) || null;
  const secondOpinion = db.prepare(`SELECT * FROM je_signoffs WHERE review_id = ? AND review_role = 'second_opinion' ORDER BY id DESC LIMIT 1`).get(review.id) || null;
  return { review, bundle, factors, evidence, documents, comparators, decisions, flags, answers, signoff, secondOpinion };
}

function levelsForBasis(state, basis) {
  const levels = {};
  const confidence = {};
  for (const f of state.factors) {
    if (basis === 'claimed') {
      levels[f.factor_code] = f.claimed_level || null;
      confidence[f.factor_code] = f.claimed_level ? 'medium' : 'insufficient';
    } else if (basis === 'ai_proposed') {
      levels[f.factor_code] = f.ai_level || null;
      confidence[f.factor_code] = f.ai_confidence || (f.ai_level ? 'medium' : 'insufficient');
    } else {
      // confirmed: advisor decision wins; insufficient/not_applicable stay unknown
      const usable = f.confirmed_decision && ['agree', 'amend'].includes(f.confirmed_decision);
      levels[f.factor_code] = usable ? f.confirmed_level : null;
      confidence[f.factor_code] = usable ? 'high' : 'insufficient';
    }
  }
  return { levels, confidence };
}

function baseDatesFor(state) {
  const dates = {};
  const outcome = state.decisions.filter((d) => d.kind === 'outcome_issued').pop();
  if (outcome?.decision_date) dates.outcome_issued = outcome.decision_date;
  return dates;
}

function priorConfirmedStats(review) {
  // Cross-review consistency: confirmed levels for the same employer + job
  // title across other members' reviews. Aggregate only — no ids, no text.
  if (!review.employer || !review.job_title) return { varianceFactors: [] };
  const rows = db
    .prepare(
      `SELECT fa.factor_code, fa.confirmed_level, fa.review_id FROM je_factor_assessments fa
       JOIN je_reviews r ON r.id = fa.review_id
       WHERE r.employer = ? AND r.job_title = ? AND r.id != ? AND fa.confirmed_level IS NOT NULL
         AND fa.confirmed_decision IN ('agree', 'amend')`
    )
    .all(review.employer, review.job_title, review.id);
  if (rows.length === 0) return { varianceFactors: [] };
  const mine = db
    .prepare(`SELECT factor_code, confirmed_level FROM je_factor_assessments WHERE review_id = ? AND confirmed_level IS NOT NULL`)
    .all(review.id);
  const varianceFactors = [];
  for (const m of mine) {
    const others = rows.filter((r) => r.factor_code === m.factor_code);
    if (others.length === 0) continue;
    const diff = others.some((o) => o.confirmed_level !== m.confirmed_level);
    if (diff) varianceFactors.push(m.factor_code);
  }
  return { varianceFactors, comparatorReviews: new Set(rows.map((r) => r.review_id)).size };
}

// Compute an outcome for a basis, run checks, store both (append-only),
// and sync high/critical check flags into je_flags.
export function computeAndStoreOutcome(reviewId, basis, actorId = null) {
  const state = assembleState(reviewId);
  if (!state) return { error: 'Review not found.', status: 404 };
  if (!state.bundle) {
    // Try to freeze the active ruleset now (it may have been loaded since creation).
    const active = activeRuleset('afc');
    if (!active) return { error: 'No approved reference ruleset is loaded — scoring is unavailable.', status: 503 };
    db.prepare('UPDATE je_reviews SET ruleset_id = ? WHERE id = ?').run(active.id, state.review.id);
    const stmt = db.prepare('INSERT OR IGNORE INTO je_factor_assessments (review_id, factor_code) VALUES (?, ?)');
    for (const f of getRulesetBundle(active.id).factors) stmt.run(state.review.id, f.code);
    return computeAndStoreOutcome(reviewId, basis, actorId);
  }

  const { levels, confidence } = levelsForBasis(state, basis);
  const outcome = computeOutcome(state.bundle, levels, confidence);
  const limits = evaluateLimits(state.bundle.limitationRules, baseDatesFor(state), todayIso());
  const checks = runJeChecks({ ...state, outcome, limits, priorConfirmedStats: priorConfirmedStats(state.review) });

  const prev = db.prepare('SELECT id FROM je_outcomes WHERE review_id = ? AND basis = ? ORDER BY id DESC LIMIT 1').get(reviewId, basis);
  const info = db
    .prepare(
      `INSERT INTO je_outcomes (review_id, ruleset_id, ruleset_checksum, basis, total_points, band_label,
         points_low, points_high, band_low, band_high, confidence, factors_missing, computation_json, checks_json, supersedes_id, computed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      reviewId, state.bundle.ruleset.id, state.bundle.ruleset.checksum, basis,
      outcome.totalPoints, outcome.bandLabel, outcome.pointsLow, outcome.pointsHigh,
      outcome.bandLow, outcome.bandHigh, outcome.confidence, outcome.factorsMissing,
      JSON.stringify({ levels, confidence, perFactor: outcome.perFactor, missing: outcome.missing }),
      JSON.stringify(checks), prev?.id || null, actorId
    );

  syncCheckFlags(reviewId, checks);
  audit(actorId, 'je.outcome_computed', 'je_review', reviewId, {
    outcomeId: info.lastInsertRowid, basis, points: outcome.totalPoints,
    band: outcome.bandLabel || `${outcome.bandLow}-${outcome.bandHigh}`, rulesetId: state.bundle.ruleset.id,
  });
  return { ok: true, outcomeId: info.lastInsertRowid, outcome, checks, limits };
}

function syncCheckFlags(reviewId, checks) {
  const open = db.prepare('SELECT * FROM je_flags WHERE review_id = ? AND resolved_at IS NULL').all(reviewId);
  for (const check of checks) {
    if (check.severity === 'notice') continue;
    if (!open.some((f) => f.rule_id === check.id)) {
      db.prepare(`INSERT INTO je_flags (review_id, rule_id, severity, reason, detected_by) VALUES (?, ?, ?, ?, 'rules')`)
        .run(reviewId, check.id, check.severity, check.message.slice(0, 400));
      if (check.severity === 'critical') {
        for (const advisorId of advisorUserIds()) {
          notifyUserJe(advisorId, 'je_flag_critical', `Band review #${reviewId} has a critical flag`, reviewId);
        }
      }
    }
  }
  // Auto-resolve rule flags that no longer apply (advisor-raised ones stay).
  for (const f of open) {
    if (f.detected_by === 'rules' && !checks.some((c) => c.id === f.rule_id) && !isSignalFlag(f.rule_id)) {
      db.prepare(`UPDATE je_flags SET resolved_at = datetime('now') WHERE id = ?`).run(f.id);
    }
  }
}

function isSignalFlag(ruleId) {
  return ['downbanding_risk', 'equal_pay', 'banding_outcome_issued', 'wages_deduction', 'je_interest', 'jd_outdated', 'superseded_ruleset'].includes(ruleId);
}

export function runChecksAndFlags(reviewId) {
  const state = assembleState(reviewId);
  if (!state || !state.bundle) return;
  const { levels, confidence } = levelsForBasis(state, 'confirmed');
  const outcome = computeOutcome(state.bundle, levels, confidence);
  const limits = evaluateLimits(state.bundle.limitationRules, baseDatesFor(state), todayIso());
  const checks = runJeChecks({ ...state, outcome, limits, priorConfirmedStats: priorConfirmedStats(state.review) });
  syncCheckFlags(reviewId, checks);
}

// ── Advisor workbench ─────────────────────────────────────────────────────

export const QUEUE_VIEWS = ['needs_review', 'analysing', 'report_ready', 'awaiting_employer', 'appeal', 'all'];

const QUEUE_STAGE_MAP = {
  needs_review: ['member_submitted', 'advisor_review'],
  analysing: ['analysing'],
  report_ready: ['report_ready'],
  awaiting_employer: ['submitted_to_employer', 'employer_review'],
  appeal: ['outcome_received', 'appeal_lodged', 'appeal_outcome'],
  all: STAGES.filter((s) => s !== 'closed'),
};

export function queue(view = 'needs_review') {
  const v = QUEUE_VIEWS.includes(view) ? view : 'needs_review';
  const counts = {};
  for (const name of QUEUE_VIEWS) {
    const stages = QUEUE_STAGE_MAP[name];
    counts[name] = db
      .prepare(`SELECT COUNT(*) AS n FROM je_reviews WHERE stage IN (${stages.map(() => '?').join(',')})`)
      .get(...stages).n;
  }
  const stages = QUEUE_STAGE_MAP[v];
  const rows = db
    .prepare(
      `SELECT r.*, u.display_name, u.email,
         (SELECT COUNT(*) FROM je_flags f WHERE f.review_id = r.id AND f.resolved_at IS NULL AND f.severity IN ('critical','high')) AS open_flags,
         (SELECT COUNT(*) FROM je_factor_assessments fa WHERE fa.review_id = r.id AND fa.confirmed_decision IS NOT NULL) AS confirmed_count,
         (SELECT COUNT(*) FROM je_factor_assessments fa WHERE fa.review_id = r.id) AS factor_count
       FROM je_reviews r JOIN users u ON u.id = r.member_id
       WHERE r.stage IN (${stages.map(() => '?').join(',')})
       ORDER BY CASE r.urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
         r.next_important_at IS NULL, r.next_important_at, r.updated_at DESC`
    )
    .all(...stages);
  return {
    ok: true, view: v, counts,
    reviews: rows.map((r) => ({
      id: r.id, kind: r.kind, stage: r.stage, urgency: r.urgency, urgencyReason: r.urgency_reason,
      jobTitle: r.job_title, employer: r.employer, currentBand: r.current_band,
      member: r.display_name || r.email, openFlags: r.open_flags,
      confirmedCount: r.confirmed_count, factorCount: r.factor_count,
      createdAt: r.created_at, updatedAt: r.updated_at,
    })),
  };
}

export function getWorkbench(user, reviewId) {
  const loaded = loadReviewAuthorised(user, reviewId);
  if (loaded.error) return loaded;
  if (!loaded.isAdvisor) return { error: 'Review not found.', status: 404 };
  const state = assembleState(reviewId);
  const member = db.prepare('SELECT id, display_name, email FROM users WHERE id = ?').get(state.review.member_id);
  const outcomes = db.prepare('SELECT * FROM je_outcomes WHERE review_id = ? ORDER BY id DESC LIMIT 20').all(state.review.id);
  const reports = db.prepare('SELECT * FROM je_reports WHERE review_id = ? ORDER BY id DESC').all(state.review.id);
  const matches = db
    .prepare(
      `SELECT m.*, p.title AS profile_title, p.band_label AS profile_band, p.job_family
       FROM je_profile_matches m JOIN je_profiles p ON p.id = m.profile_id
       WHERE m.review_id = ? ORDER BY m.rank`
    )
    .all(state.review.id);
  const runs = db
    .prepare(
      `SELECT r.*,
         (SELECT json_group_array(json_object('stage', s.stage, 'status', s.status, 'promptVersion', s.prompt_version, 'dropped', s.dropped_count, 'error', s.error_code))
          FROM je_run_stages s WHERE s.run_id = r.id ORDER BY s.seq) AS stages_json
       FROM je_runs r WHERE r.review_id = ? ORDER BY r.id DESC LIMIT 10`
    )
    .all(state.review.id);
  const messages = db
    .prepare(`SELECT id, author_user_id, visibility, kind, content, approved_by, created_at FROM je_messages WHERE review_id = ? ORDER BY id`)
    .all(state.review.id);
  const limits = state.bundle ? evaluateLimits(state.bundle.limitationRules, baseDatesFor(state), todayIso()) : [];
  const { levels, confidence } = state.bundle ? levelsForBasis(state, 'confirmed') : { levels: {}, confidence: {} };
  const liveOutcome = state.bundle ? computeOutcome(state.bundle, levels, confidence) : null;
  const aiLevels = state.bundle ? levelsForBasis(state, 'ai_proposed') : { levels: {}, confidence: {} };
  const gaps = state.bundle ? rankGaps(state.bundle, mergedLevels(state), mergedConfidence(state)) : [];
  const checks = state.bundle
    ? runJeChecks({ ...state, outcome: liveOutcome, limits, priorConfirmedStats: priorConfirmedStats(state.review) })
    : [{ id: 'no_approved_ruleset', severity: 'critical', message: 'No approved reference ruleset is loaded.', actionable: 'Load reference data in Admin → Job evaluation.' }];
  const secondOp = state.bundle
    ? secondOpinionRequired({
        bundle: state.bundle, outcome: liveOutcome, review: state.review, flags: state.flags,
        disagreementCount: state.factors.filter((f) => f.confirmed_decision === 'amend').length,
      })
    : { required: false, reasons: [] };
  return {
    ok: true,
    review: { ...state.review, memberEditable: !!state.review.member_editable },
    member: { id: member.id, name: member.display_name || member.email },
    bundle: state.bundle && {
      rulesetId: state.bundle.ruleset.id, label: state.bundle.ruleset.label,
      status: state.bundle.ruleset.status, origin: state.bundle.ruleset.origin,
      verifiedAt: state.bundle.ruleset.verified_at, checksum: state.bundle.ruleset.checksum,
      factors: state.bundle.factors, bands: state.bundle.bands, matchRules: state.bundle.matchRules,
    },
    factors: state.factors.map(maskBlindFactor), evidence: state.evidence, documents: state.documents,
    comparators: state.comparators, decisions: state.decisions, flags: state.flags,
    answers: Object.fromEntries(state.answers.map((a) => [a.question_code, a.answer])),
    questions: questionPayload(),
    outcomes, reports: reports.map((r) => ({ ...r, body: JSON.parse(r.body_json), body_json: undefined })),
    matches, runs: runs.map((r) => ({ ...r, stages: JSON.parse(r.stages_json || '[]'), stages_json: undefined })),
    messages, limits, liveOutcome, aiOutcomePreview: state.bundle ? computeOutcome(state.bundle, aiLevels.levels, aiLevels.confidence) : null,
    gaps, checks, secondOpinion: secondOp,
    signoff: state.signoff, secondOpinionRecord: state.secondOpinion,
    checklist: { version: CHECKLIST_VERSION, items: CHECKLIST_ITEMS },
    amendReasonCodes: AMEND_REASON_CODES,
    shareBlockers: shareBlockers({
      ...state,
      report: db.prepare(`SELECT * FROM je_reports WHERE review_id = ? AND audience = 'member' AND status IN ('approved','issued') ORDER BY id DESC LIMIT 1`).get(state.review.id) || null,
    }),
  };
}

// Blind sampling: on a blind-sampled review the AI proposal is hidden until
// the advisor has recorded their own decision — so sighted agreement can be
// compared against blind agreement (deference detection).
function maskBlindFactor(f) {
  if (!f.blind || f.confirmed_decision) return f;
  return { ...f, ai_level: null, ai_confidence: null, ai_alternative_level: null, ai_rationale: '', gap_note: f.gap_note, aiMasked: true };
}

// Best-available levels: confirmed wins, then AI, then claimed.
function mergedLevels(state) {
  const levels = {};
  for (const f of state.factors) {
    const usable = f.confirmed_decision && ['agree', 'amend'].includes(f.confirmed_decision);
    levels[f.factor_code] = usable ? f.confirmed_level : f.ai_level || f.claimed_level || null;
  }
  return levels;
}
function mergedConfidence(state) {
  const conf = {};
  for (const f of state.factors) {
    const usable = f.confirmed_decision && ['agree', 'amend'].includes(f.confirmed_decision);
    conf[f.factor_code] = usable ? 'high' : f.ai_level ? (f.ai_confidence || 'medium') : f.claimed_level ? 'low' : 'insufficient';
  }
  return conf;
}

// Advisor confirms one factor. Amend requires a reason code. A proposal with
// no supporting evidence cannot be agreed — the structural anti-hallucination
// gate.
export function confirmFactor(actor, reviewId, factorCode, { decision, level, reasonCode, note }) {
  const loaded = loadReviewAuthorised(actor, reviewId);
  if (loaded.error) return loaded;
  if (!loaded.isAdvisor) return { error: 'Review not found.', status: 404 };
  const { review } = loaded;
  const row = db.prepare('SELECT * FROM je_factor_assessments WHERE review_id = ? AND factor_code = ?').get(review.id, String(factorCode));
  if (!row) return { error: 'Unknown factor.', status: 404 };
  if (!['agree', 'amend', 'insufficient', 'not_applicable'].includes(decision)) {
    return { error: 'Decision must be agree, amend, insufficient or not_applicable.', status: 400 };
  }

  let confirmedLevel = null;
  if (decision === 'agree') {
    if (!row.ai_level && !level) return { error: 'There is no proposed level to agree with — set a level (amend) or mark it as not enough information.', status: 400 };
    confirmedLevel = String(level || row.ai_level);
    const hasEvidence = db
      .prepare(`SELECT COUNT(*) AS n FROM je_evidence WHERE review_id = ? AND factor_code = ? AND strength != 'rejected'`)
      .get(review.id, row.factor_code).n > 0;
    if (row.ai_level && !hasEvidence) {
      return { error: 'This proposal has no supporting evidence item, so it cannot be confirmed. Gather evidence or mark the factor as not having enough information.', status: 400 };
    }
  } else if (decision === 'amend') {
    if (!level) return { error: 'Set the level you are amending to.', status: 400 };
    if (!AMEND_REASON_CODES.includes(reasonCode)) return { error: 'A reason code is required when changing a level.', status: 400 };
    confirmedLevel = String(level);
  }

  if (confirmedLevel !== null) {
    const bundle = review.ruleset_id ? getRulesetBundle(review.ruleset_id) : null;
    const factor = bundle?.factors.find((f) => f.code === row.factor_code);
    if (!factor || !factor.levels.some((l) => String(l.label) === confirmedLevel)) {
      return { error: `Level "${confirmedLevel}" does not exist for this factor in the pinned ruleset.`, status: 400 };
    }
  }

  if (['member_submitted', 'analysing'].includes(review.stage)) {
    db.prepare(`UPDATE je_reviews SET stage = 'advisor_review' WHERE id = ?`).run(review.id);
  }
  db.prepare(
    `UPDATE je_factor_assessments SET confirmed_level = ?, confirmed_decision = ?, confirmed_reason_code = ?,
       confirmed_by = ?, confirmed_at = datetime('now'), confirm_note = ?,
       status = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    confirmedLevel, decision, decision === 'amend' ? reasonCode : null,
    actor.id, String(note || '').slice(0, 2000),
    decision === 'insufficient' ? 'insufficient_evidence' : decision === 'not_applicable' ? 'confirmed' : 'confirmed',
    row.id
  );
  touch(review.id);
  audit(actor.id, 'je.factor_confirmed', 'je_review', review.id, {
    factorCode: row.factor_code, decision,
    agreed: decision === 'agree', aiLevel: row.ai_level || null, level: confirmedLevel,
    reasonCode: decision === 'amend' ? reasonCode : null, blind: !!row.blind,
  });

  const result = computeAndStoreOutcome(review.id, 'confirmed', actor.id);
  return result.error ? result : { ok: true, outcome: result.outcome, checks: result.checks };
}

export function confirmEvidence(actor, reviewId, evidenceId, action) {
  const loaded = loadReviewAuthorised(actor, reviewId);
  if (loaded.error) return loaded;
  if (!loaded.isAdvisor) return { error: 'Review not found.', status: 404 };
  const strength = action === 'reject' ? 'rejected' : 'confirmed';
  const info = db
    .prepare(`UPDATE je_evidence SET strength = ?, confirmed_by = ? WHERE id = ? AND review_id = ?`)
    .run(strength, actor.id, Number(evidenceId), loaded.review.id);
  if (info.changes !== 1) return { error: 'Evidence item not found.', status: 404 };
  audit(actor.id, 'je.evidence_reviewed', 'je_review', loaded.review.id, { evidenceId: Number(evidenceId), strength });
  return { ok: true };
}

export function selectProfile(actor, reviewId, matchId) {
  const loaded = loadReviewAuthorised(actor, reviewId);
  if (loaded.error) return loaded;
  if (!loaded.isAdvisor) return { error: 'Review not found.', status: 404 };
  db.prepare('UPDATE je_profile_matches SET selected_by = NULL WHERE review_id = ?').run(loaded.review.id);
  const info = db.prepare('UPDATE je_profile_matches SET selected_by = ? WHERE id = ? AND review_id = ?').run(actor.id, Number(matchId), loaded.review.id);
  if (info.changes !== 1) return { error: 'Profile match not found.', status: 404 };
  audit(actor.id, 'je.profile_selected', 'je_review', loaded.review.id, { matchId: Number(matchId) });
  return { ok: true };
}

export function verifyComparator(actor, reviewId, comparatorId, action) {
  const loaded = loadReviewAuthorised(actor, reviewId);
  if (loaded.error) return loaded;
  if (!loaded.isAdvisor) return { error: 'Review not found.', status: 404 };
  const status = action === 'reject' ? 'rejected' : 'verified';
  const info = db
    .prepare(`UPDATE je_comparators SET status = ?, verified_by = ? WHERE id = ? AND review_id = ?`)
    .run(status, actor.id, Number(comparatorId), loaded.review.id);
  if (info.changes !== 1) return { error: 'Comparator not found.', status: 404 };
  audit(actor.id, 'je.comparator_reviewed', 'je_review', loaded.review.id, { comparatorId: Number(comparatorId), status });
  return { ok: true };
}

export function setMemberEditable(actor, reviewId, memberEditable) {
  const loaded = loadReviewAuthorised(actor, reviewId);
  if (loaded.error) return loaded;
  if (!loaded.isAdvisor) return { error: 'Review not found.', status: 404 };
  db.prepare('UPDATE je_reviews SET member_editable = ? WHERE id = ?').run(memberEditable ? 1 : 0, loaded.review.id);
  audit(actor.id, 'je.lock_changed', 'je_review', loaded.review.id, { memberEditable: !!memberEditable });
  return { ok: true };
}

export function acknowledgeFlag(actor, reviewId, flagId) {
  const loaded = loadReviewAuthorised(actor, reviewId);
  if (loaded.error) return loaded;
  if (!loaded.isAdvisor) return { error: 'Review not found.', status: 404 };
  const info = db
    .prepare(`UPDATE je_flags SET acknowledged_by = ?, acknowledged_at = datetime('now') WHERE id = ? AND review_id = ? AND acknowledged_at IS NULL`)
    .run(actor.id, Number(flagId), loaded.review.id);
  if (info.changes !== 1) return { error: 'Flag not found or already acknowledged.', status: 404 };
  audit(actor.id, 'je.flag_acknowledged', 'je_review', loaded.review.id, { flagId: Number(flagId) });
  return { ok: true };
}

export function setStage(actor, reviewId, stage) {
  const loaded = loadReviewAuthorised(actor, reviewId);
  if (loaded.error) return loaded;
  if (!loaded.isAdvisor) return { error: 'Review not found.', status: 404 };
  const { review } = loaded;
  if (!STAGES.includes(stage)) return { error: 'Unknown stage.', status: 400 };
  if (!STAGE_TRANSITIONS[review.stage]?.includes(stage)) {
    return { error: `Cannot move from ${review.stage} to ${stage}.`, status: 400 };
  }
  db.prepare(`UPDATE je_reviews SET stage = ?, closed_at = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(stage, stage === 'closed' ? nowStamp() : null, review.id);
  audit(actor.id, 'je.stage_changed', 'je_review', review.id, { from: review.stage, to: stage });
  return { ok: true, stage };
}

// ── Sign-off (Kelly) ──────────────────────────────────────────────────────

export function signOff(actor, reviewId, { checklist, recommendation, secondOpinionWaivedReason, reviewRole = 'primary' }) {
  const loaded = loadReviewAuthorised(actor, reviewId);
  if (loaded.error) return loaded;
  if (!loaded.isAdvisor) return { error: 'Review not found.', status: 404 };
  const state = assembleState(reviewId);
  if (!state.bundle) return { error: 'No reference ruleset — scoring is unavailable.', status: 503 };

  const unresolved = state.factors.filter((f) => !f.confirmed_decision);
  if (unresolved.length > 0) {
    return { error: `${unresolved.length} factor(s) are not yet resolved.`, status: 400, factors: unresolved.map((f) => f.factor_code) };
  }
  const unacked = state.flags.filter((f) => ['critical', 'high'].includes(f.severity) && !f.acknowledged_at && !f.resolved_at);
  if (unacked.length > 0) {
    return { error: `${unacked.length} check flag(s) must be acknowledged first.`, status: 400, flags: unacked.map((f) => f.rule_id) };
  }
  const ticked = checklist && typeof checklist === 'object' ? checklist : {};
  const missingItems = CHECKLIST_ITEMS.filter((i) => ticked[i.code] !== true);
  if (missingItems.length > 0) {
    return { error: 'Every fairness checklist item must be actively confirmed.', status: 400, missing: missingItems.map((i) => i.code) };
  }
  const recs = ['supports', 'supports_in_part', 'not_supported', 'more_information'];
  if (!recs.includes(recommendation)) return { error: 'Choose an outcome recommendation.', status: 400 };

  const { levels, confidence } = levelsForBasis(state, 'confirmed');
  const outcome = computeOutcome(state.bundle, levels, confidence);
  const disagreementCount = state.factors.filter((f) => f.confirmed_decision === 'amend').length;
  const secondOp = secondOpinionRequired({
    bundle: state.bundle, outcome, review: state.review, flags: state.flags, disagreementCount,
  });
  if (reviewRole === 'primary' && secondOp.required && !state.secondOpinion) {
    if (!String(secondOpinionWaivedReason || '').trim()) {
      return {
        error: 'This assessment requires a second opinion before it can be shared. Record one, or explicitly waive it with a reason.',
        status: 400, secondOpinionReasons: secondOp.reasons,
      };
    }
  }

  const info = db
    .prepare(
      `INSERT INTO je_signoffs (review_id, reviewer_user_id, review_role, checklist_version, checklist_json,
         recommendation, disagreement_count, band_low, band_high, second_opinion_required, second_opinion_waived_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      state.review.id, actor.id, reviewRole === 'second_opinion' ? 'second_opinion' : 'primary',
      CHECKLIST_VERSION, JSON.stringify(Object.fromEntries(CHECKLIST_ITEMS.map((i) => [i.code, true]))),
      recommendation, disagreementCount, outcome.bandLow, outcome.bandHigh,
      secondOp.required ? 1 : 0, String(secondOpinionWaivedReason || '').trim().slice(0, 400)
    );
  let stageNow = state.review.stage;
  if (reviewRole !== 'second_opinion' && ['member_submitted', 'analysing', 'advisor_review'].includes(state.review.stage)) {
    db.prepare(`UPDATE je_reviews SET stage = 'report_ready', updated_at = datetime('now') WHERE id = ?`).run(state.review.id);
    stageNow = 'report_ready';
  }
  audit(actor.id, 'je.signed_off', 'je_review', state.review.id, {
    signoffId: info.lastInsertRowid, reviewRole, recommendation, disagreementCount,
    bandLow: outcome.bandLow, bandHigh: outcome.bandHigh,
    secondOpinionRequired: secondOp.required, secondOpinionReasons: secondOp.reasons,
    waived: !!String(secondOpinionWaivedReason || '').trim(),
  });
  return { ok: true, signoffId: info.lastInsertRowid, secondOpinion: secondOp, stage: stageNow };
}

// ── Decisions (the only entry point for a real band) ─────────────────────

export function recordDecision(actor, reviewId, fields) {
  const loaded = loadReviewAuthorised(actor, reviewId);
  if (loaded.error) return loaded;
  if (!loaded.isAdvisor) return { error: 'Review not found.', status: 404 };
  const { review } = loaded;
  const kinds = ['request_submitted', 'panel_matched', 'panel_evaluated', 'outcome_issued', 'appeal_lodged', 'appeal_heard', 'appeal_outcome', 'back_pay_agreed', 'withdrawn'];
  if (!kinds.includes(fields.kind)) return { error: 'Unknown decision kind.', status: 400 };
  const deciders = ['employer', 'matching_panel', 'appeal_panel', 'member', 'advisor'];
  const info = db
    .prepare(
      `INSERT INTO je_decisions (review_id, kind, decision_date, decided_by, band_awarded, effective_from,
         back_pay_from, back_pay_to, detail, source, date_confirmed, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      review.id, fields.kind, dateOrNull(fields.decisionDate),
      deciders.includes(fields.decidedBy) ? fields.decidedBy : 'employer',
      String(fields.bandAwarded || '').trim().slice(0, 8),
      dateOrNull(fields.effectiveFrom), dateOrNull(fields.backPayFrom), dateOrNull(fields.backPayTo),
      String(fields.detail || '').slice(0, 2000),
      ['member_reported', 'document', 'advisor'].includes(fields.source) ? fields.source : 'advisor',
      fields.dateConfirmed === true ? 1 : 0, actor.id
    );

  const stageByKind = {
    request_submitted: 'submitted_to_employer',
    panel_matched: 'employer_review',
    panel_evaluated: 'employer_review',
    outcome_issued: 'outcome_received',
    appeal_lodged: 'appeal_lodged',
    appeal_outcome: 'appeal_outcome',
  };
  const next = stageByKind[fields.kind];
  if (next && STAGE_TRANSITIONS[review.stage]?.includes(next)) {
    db.prepare(`UPDATE je_reviews SET stage = ?, updated_at = datetime('now') WHERE id = ?`).run(next, review.id);
  }
  if (fields.kind === 'outcome_issued' || fields.kind === 'appeal_outcome') {
    notifyUserJe(review.member_id, 'je_outcome_recorded', 'An outcome has been recorded on your band review', review.id);
  }
  runChecksAndFlags(review.id);
  audit(actor.id, 'je.decision_recorded', 'je_review', review.id, {
    decisionId: info.lastInsertRowid, kind: fields.kind, band: String(fields.bandAwarded || '') || null, dateConfirmed: fields.dateConfirmed === true,
  });
  return { ok: true, decisionId: info.lastInsertRowid };
}

// ── Oversight metrics (aggregate only — no narrative, no names) ──────────

export function oversightMetrics() {
  const awaiting = db
    .prepare(`SELECT COUNT(*) AS n FROM je_reviews WHERE stage IN ('member_submitted','advisor_review')`)
    .get().n;
  const byStage = db.prepare('SELECT stage, COUNT(*) AS n FROM je_reviews GROUP BY stage').all();

  // AI-vs-confirmed agreement per factor: the bias alarm. A persistent
  // negative delta on caring factors with a neutral delta on technical ones
  // is exactly the signal this exists to catch.
  const perFactor = db
    .prepare(
      `SELECT factor_code,
         COUNT(*) AS decided,
         SUM(CASE WHEN confirmed_decision = 'agree' THEN 1 ELSE 0 END) AS agreed,
         SUM(CASE WHEN confirmed_decision = 'amend' THEN 1 ELSE 0 END) AS amended,
         SUM(CASE WHEN confirmed_decision = 'insufficient' THEN 1 ELSE 0 END) AS insufficient,
         SUM(CASE WHEN blind = 1 THEN 1 ELSE 0 END) AS blind_count,
         SUM(CASE WHEN blind = 1 AND confirmed_decision = 'agree' THEN 1 ELSE 0 END) AS blind_agreed
       FROM je_factor_assessments
       WHERE confirmed_decision IS NOT NULL AND ai_level IS NOT NULL
       GROUP BY factor_code ORDER BY factor_code`
    )
    .all();

  const amendReasons = db
    .prepare(
      `SELECT confirmed_reason_code AS code, COUNT(*) AS n FROM je_factor_assessments
       WHERE confirmed_decision = 'amend' AND confirmed_reason_code IS NOT NULL GROUP BY confirmed_reason_code ORDER BY n DESC`
    )
    .all();

  const waivers = db
    .prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN second_opinion_waived_reason != '' THEN 1 ELSE 0 END) AS waived FROM je_signoffs WHERE second_opinion_required = 1`)
    .get();

  const pipeline = db
    .prepare(
      `SELECT s.stage, s.status, COUNT(*) AS n, SUM(s.dropped_count) AS dropped
       FROM je_run_stages s GROUP BY s.stage, s.status ORDER BY s.stage`
    )
    .all();

  const flags = db
    .prepare(`SELECT rule_id, severity, COUNT(*) AS n FROM je_flags WHERE resolved_at IS NULL GROUP BY rule_id, severity ORDER BY n DESC`)
    .all();

  // Anchoring check: how often the member's hoped-for band fell inside the
  // confirmed indicative range (latest confirmed outcome per review).
  const anchoring = db
    .prepare(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN r.claimed_band != '' AND o.band_low != '' AND o.band_high != ''
                   AND EXISTS (SELECT 1 FROM je_band_boundaries bb WHERE bb.ruleset_id = o.ruleset_id AND bb.band_label = r.claimed_band
                               AND bb.seq >= (SELECT seq FROM je_band_boundaries WHERE ruleset_id = o.ruleset_id AND band_label = o.band_low)
                               AND bb.seq <= (SELECT seq FROM je_band_boundaries WHERE ruleset_id = o.ruleset_id AND band_label = o.band_high))
             THEN 1 ELSE 0 END) AS inside
       FROM je_reviews r
       JOIN je_outcomes o ON o.id = (SELECT id FROM je_outcomes WHERE review_id = r.id AND basis = 'confirmed' ORDER BY id DESC LIMIT 1)
       WHERE r.claimed_band != ''`
    )
    .get();

  const reference = db
    .prepare(`SELECT id, label, status, origin, verified_at, checksum FROM je_rulesets ORDER BY id DESC LIMIT 5`)
    .all();

  return {
    ok: true,
    awaiting, byStage,
    perFactor: perFactor.map((f) => ({
      factorCode: f.factor_code, decided: f.decided,
      agreementRate: f.decided ? Math.round((f.agreed / f.decided) * 100) : null,
      amended: f.amended, insufficient: f.insufficient,
      blindDecided: f.blind_count,
      blindAgreementRate: f.blind_count ? Math.round((f.blind_agreed / f.blind_count) * 100) : null,
    })),
    amendReasons, waivers, pipeline, flags, anchoring, reference,
  };
}

// Re-pin a review to the currently approved ruleset (explicit advisor act;
// prior outcomes remain byte-identical — recompute appends).
export function rebaseRuleset(actor, reviewId) {
  const loaded = loadReviewAuthorised(actor, reviewId);
  if (loaded.error) return loaded;
  if (!loaded.isAdvisor) return { error: 'Review not found.', status: 404 };
  const active = activeRuleset('afc');
  if (!active) return { error: 'No approved ruleset to rebase onto.', status: 503 };
  if (active.id === loaded.review.ruleset_id) return { ok: true, rulesetId: active.id, unchanged: true };
  db.prepare('UPDATE je_reviews SET ruleset_id = ? WHERE id = ?').run(active.id, loaded.review.id);
  const stmt = db.prepare('INSERT OR IGNORE INTO je_factor_assessments (review_id, factor_code) VALUES (?, ?)');
  for (const f of getRulesetBundle(active.id).factors) stmt.run(loaded.review.id, f.code);
  db.prepare(`UPDATE je_flags SET resolved_at = datetime('now') WHERE review_id = ? AND rule_id = 'superseded_ruleset' AND resolved_at IS NULL`).run(loaded.review.id);
  audit(actor.id, 'je.ruleset_rebased', 'je_review', loaded.review.id, { rulesetId: active.id });
  return { ok: true, rulesetId: active.id };
}
