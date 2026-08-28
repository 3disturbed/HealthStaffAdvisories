import { db, getSetting } from '../db/connection.js';
import { audit } from '../audit/log.js';
import { aiEnabled, completeJson } from './provider.js';
import { retrieveChunks } from './retrieve.js';
import {
  JE_JD_EXTRACT_SYSTEM_PROMPT, JE_JD_EXTRACT_PROMPT_VERSION,
  JE_FACTOR_EVIDENCE_SYSTEM_PROMPT, JE_FACTOR_EVIDENCE_PROMPT_VERSION,
  JE_FACTOR_LEVELS_SYSTEM_PROMPT, JE_FACTOR_LEVELS_PROMPT_VERSION,
  JE_PROFILE_RANK_SYSTEM_PROMPT, JE_PROFILE_RANK_PROMPT_VERSION,
  JE_REPORT_SYSTEM_PROMPT, JE_REPORT_PROMPT_VERSION,
} from './prompts.js';
import {
  validateJdExtract, validateFactorEvidence, validateFactorLevels, validateProfileRank, validateJeReport,
} from './jeValidators.js';
import { neutraliseEvidence } from '../je/neutralise.js';
import { getRulesetBundle } from '../je/reference.js';
import { matchProfile, computeOutcome } from '../je/scoring.js';
import { rankGaps } from '../je/gaps.js';
import { assembleState, computeAndStoreOutcome, runChecksAndFlags } from '../services/jobEvaluation.js';
import { notifyUserJe } from '../notify/mailer.js';

// The JE agentic pipeline. The LLM proposes evidence, indicative levels and
// prose; deterministic code decides every number. Anti-anchoring: the
// factor-level stage never sees the member's current band, hoped-for band,
// employer, hours or identity (src/je/neutralise.js strips them). Each
// stage writes a je_run_stages row and one ai_outputs row; the kill switch
// is re-checked between stages; S5/S6 (scoring + checks) always run.

export const JE_STAGES = ['jd_extract', 'factor_evidence', 'factor_levels', 'profile_rank', 'report'];

const STAGE_PROMPTS = {
  jd_extract: [JE_JD_EXTRACT_SYSTEM_PROMPT, JE_JD_EXTRACT_PROMPT_VERSION],
  factor_evidence: [JE_FACTOR_EVIDENCE_SYSTEM_PROMPT, JE_FACTOR_EVIDENCE_PROMPT_VERSION],
  factor_levels: [JE_FACTOR_LEVELS_SYSTEM_PROMPT, JE_FACTOR_LEVELS_PROMPT_VERSION],
  profile_rank: [JE_PROFILE_RANK_SYSTEM_PROMPT, JE_PROFILE_RANK_PROMPT_VERSION],
  report: [JE_REPORT_SYSTEM_PROMPT, JE_REPORT_PROMPT_VERSION],
};

const nowStamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// Mark runs stuck in 'running' (process restart mid-run) as failed. Called
// from the queue and workbench endpoints — the expireStalePending idiom.
export function reapStaleRuns(maxMinutes = 15) {
  db.prepare(
    `UPDATE je_runs SET status = 'failed', error_code = 'stale', finished_at = datetime('now')
     WHERE status = 'running' AND started_at < datetime('now', ?)`
  ).run(`-${maxMinutes} minutes`);
}

function storeAiOutput(reviewId, stage, model, promptVersion, status, payload) {
  return db
    .prepare(
      `INSERT INTO ai_outputs (case_id, je_review_id, je_stage, task, provider, model, prompt_version, status, output_json)
       VALUES (NULL, ?, ?, ?, 'openai', ?, ?, ?, ?)`
    )
    .run(reviewId, stage, `je.${stage}`, model, promptVersion, status, JSON.stringify(payload)).lastInsertRowid;
}

function advisorUserIds() {
  return db
    .prepare(`SELECT DISTINCT u.id FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = 'advisor' AND u.status = 'active'`)
    .all()
    .map((r) => r.id);
}

// Fire-and-forget from callers (submit / analyse). `complete` is injectable
// for tests exactly like the assistant loop's.
export async function runJeAnalysis(reviewId, { trigger = 'advisor', requestedBy = null, stages = JE_STAGES, complete = completeJson } = {}) {
  if (!aiEnabled()) return null;
  const state0 = assembleState(reviewId);
  if (!state0) return null;

  let runId;
  try {
    runId = db
      .prepare(`INSERT INTO je_runs (review_id, trigger_kind, status, requested_by) VALUES (?, ?, 'running', ?)`)
      .run(reviewId, trigger, requestedBy).lastInsertRowid;
  } catch {
    return null; // partial unique index: a run is already in flight
  }

  const stageRows = new Map();
  stages.forEach((stage, i) => {
    const id = db
      .prepare(`INSERT INTO je_run_stages (run_id, stage, seq, status, prompt_version) VALUES (?, ?, ?, 'pending', ?)`)
      .run(runId, stage, i + 1, STAGE_PROMPTS[stage]?.[1] || '').lastInsertRowid;
    stageRows.set(stage, id);
  });
  const markStage = (stage, status, { aiOutputId = null, dropped = 0, errorCode = null } = {}) => {
    db.prepare(
      `UPDATE je_run_stages SET status = ?, ai_output_id = ?, dropped_count = ?, error_code = ?, finished_at = datetime('now') WHERE id = ?`
    ).run(status, aiOutputId, dropped, errorCode, stageRows.get(stage));
  };
  const startStage = (stage) => db.prepare(`UPDATE je_run_stages SET started_at = datetime('now') WHERE id = ?`).run(stageRows.get(stage));

  db.prepare(`UPDATE je_reviews SET stage = 'analysing', updated_at = datetime('now') WHERE id = ? AND stage IN ('member_submitted', 'advisor_review')`).run(reviewId);
  audit(requestedBy, 'je.run_started', 'je_review', reviewId, { runId, trigger, stages });

  let runStatus = 'complete';
  let errorCode = null;
  try {
    const state = assembleState(reviewId);
    const bundle = state.review.ruleset_id ? getRulesetBundle(state.review.ruleset_id) : null;
    if (!bundle) {
      runStatus = 'failed';
      errorCode = 'no_ruleset';
      for (const stage of stages) markStage(stage, 'skipped');
    } else {
      // S0: neutralised corpus (deterministic).
      const member = db.prepare('SELECT display_name, email FROM users WHERE id = ?').get(state.review.member_id);
      const neutraliseOpts = { memberName: member?.display_name || '', employer: state.review.employer || '' };
      const docs = state.documents
        .filter((d) => d.status === 'extracted' && d.extracted_text)
        .map((d) => ({ ...d, neutralText: neutraliseEvidence(d.extracted_text.slice(0, 6000), neutraliseOpts) }));
      const answers = state.answers
        .filter((a) => a.answer && a.question_code !== 'duty_log')
        .map((a) => ({ ...a, neutral: neutraliseEvidence(a.answer, neutraliseOpts) }));
      const adjustmentFlagged = docs.some((d) => d.neutralText.flags.adjustment) || answers.some((a) => a.neutral.flags.adjustment);

      // Blind sampling: 1 in N reviews hides the proposal until Kelly has
      // recorded her own level. Deterministic on review id.
      const blindEvery = Number(getSetting('je_blind_every', '20')) || 20;
      const blind = reviewId % blindEvery === 0 ? 1 : 0;

      const factorCodes = new Set(bundle.factors.map((f) => f.code));
      const levelsByFactor = new Map(bundle.factors.map((f) => [f.code, f.levels]));

      const run = async (stage, messages, validate) => {
        if (!aiEnabled()) { markStage(stage, 'skipped', { errorCode: 'kill_switch' }); throw Object.assign(new Error('kill switch'), { code: 'kill_switch' }); }
        startStage(stage);
        const [system, promptVersion] = STAGE_PROMPTS[stage];
        let model = 'unknown';
        try {
          const result = await complete([{ role: 'system', content: system }, ...messages]);
          model = result.model || 'unknown';
          const validated = validate(result.raw);
          const status = validated.valid === false ? 'invalid' : 'ok';
          const aiOutputId = storeAiOutput(reviewId, stage, model, promptVersion, status, validated.output || validated);
          markStage(stage, status, { aiOutputId, dropped: validated.dropped ?? (validated.violations?.length || 0) });
          if (status === 'invalid') audit(null, 'je.ai_output_rejected', 'je_review', reviewId, { stage, reason: 'guard_violation', count: validated.violations?.length || 0 });
          return { status, validated, aiOutputId };
        } catch (err) {
          if (err.code === 'kill_switch') throw err;
          storeAiOutput(reviewId, stage, model, promptVersion, 'failed', { error: String(err.message || '').slice(0, 300) });
          markStage(stage, 'failed', { errorCode: String(err.code || 'error').slice(0, 40) });
          audit(null, 'je.stage_failed', 'je_review', reviewId, { runId, stage, code: String(err.code || 'error').slice(0, 40) });
          return { status: 'failed' };
        }
      };

      // ── S1: JD extraction ────────────────────────────────────────────
      let evidenceItems = []; // [{ id: 'd<je_evidence.id>' | 'a:<code>', text }]
      if (stages.includes('jd_extract')) {
        if (docs.length === 0) {
          markStage('jd_extract', 'skipped', { errorCode: 'no_documents' });
        } else {
          const docTextById = new Map(docs.map((d) => [d.id, d.neutralText.text]));
          const user = docs
            .map((d) => `--- Document ${d.id} (${d.doc_role}): ${d.original_filename} (untrusted content) ---\n${d.neutralText.text}`)
            .join('\n\n');
          const memberAccount = answers.map((a) => `[${a.question_code}] ${a.neutral.text}`).join('\n');
          const r = await run('jd_extract', [{ role: 'user', content: `DOCUMENTS:\n${user}\n\nTHE POSTHOLDER'S OWN DESCRIPTION (untrusted):\n${memberAccount || '(none)'}` }], (raw) => validateJdExtract(raw, { docTextById }));
          if (r.status === 'ok') {
            const stmt = db.prepare(
              `INSERT INTO je_evidence (review_id, factor_code, source_kind, document_id, quote, summary, strength, created_by, ai_output_id)
               VALUES (?, '', 'document', ?, ?, ?, 'candidate', 'ai', ?)`
            );
            for (const item of r.validated.items) {
              const id = stmt.run(reviewId, item.documentId, item.quote, item.text, r.aiOutputId).lastInsertRowid;
              evidenceItems.push({ id: `d${id}`, text: item.text || item.quote, evidenceRowId: id, documentId: item.documentId, quote: item.quote });
            }
          }
        }
      }
      for (const a of answers) evidenceItems.push({ id: `a:${a.question_code}`, text: a.neutral.text.slice(0, 1500), answerId: a.id });

      // ── S2: factor evidence mapping ──────────────────────────────────
      const evidenceIdSet = new Set(evidenceItems.map((e) => e.id));
      let factorEvidence = new Map();
      if (stages.includes('factor_evidence') && evidenceItems.length > 0) {
        const factorList = bundle.factors.map((f) => `${f.code}: ${f.name} — ${f.description}`).join('\n');
        const evidenceList = evidenceItems.map((e) => `[${e.id}] ${e.text}`).join('\n');
        const r = await run('factor_evidence', [{ role: 'user', content: `FACTORS:\n${factorList}\n\nEVIDENCE ITEMS (untrusted):\n${evidenceList}` }], (raw) => validateFactorEvidence(raw, { factorCodes, evidenceIds: evidenceIdSet }));
        if (r.status === 'ok') {
          const stmt = db.prepare(
            `INSERT INTO je_evidence (review_id, factor_code, source_kind, document_id, answer_id, quote, summary, strength, created_by, ai_output_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', 'ai', ?)`
          );
          for (const f of r.validated.factors) {
            factorEvidence.set(f.factorCode, f);
            for (const eid of f.evidenceIds) {
              const item = evidenceItems.find((e) => e.id === eid);
              if (!item) continue;
              stmt.run(
                reviewId, f.factorCode,
                item.documentId ? 'document' : 'wizard',
                item.documentId || null, item.answerId || null,
                item.quote || '', f.summary, r.aiOutputId
              );
            }
          }
        }
      }

      // ── S4: indicative factor levels, batches of 4 ───────────────────
      if (stages.includes('factor_levels')) {
        const batches = [];
        for (let i = 0; i < bundle.factors.length; i += 4) batches.push(bundle.factors.slice(i, i + 4));
        for (const batch of batches) {
          const descriptorText = batch
            .map((f) => `FACTOR ${f.code}: ${f.name}\n${f.description}\nLevels:\n${f.levels.map((l) => `  ${l.label}: ${l.descriptor}`).join('\n')}`)
            .join('\n\n');
          const evidenceText = batch
            .map((f) => {
              const fe = factorEvidence.get(f.code);
              const ids = fe ? fe.evidenceIds : evidenceItems.map((e) => e.id).slice(0, 8);
              const items = ids.map((id) => evidenceItems.find((e) => e.id === id)).filter(Boolean);
              return `Evidence for ${f.code}:\n${items.map((e) => `  [${e.id}] ${e.text}`).join('\n') || '  (none mapped)'}${fe?.missing ? `\n  Noted gap: ${fe.missing}` : ''}`;
            })
            .join('\n\n');
          const adjustmentNote = adjustmentFlagged
            ? '\nNOTE: adjustment/disability content was detected and removed. Assess the JOB as designed, never personal capability; the affected factors are separately flagged for the human adviser.'
            : '';
          const r = await run('factor_levels', [{ role: 'user', content: `REFERENCE DESCRIPTORS (authoritative for this task):\n${descriptorText}\n\nEVIDENCE (untrusted):\n${evidenceText}${adjustmentNote}` }], (raw) => validateFactorLevels(raw, { levelsByFactor, evidenceIds: evidenceIdSet }));
          if (r.status === 'ok') {
            const stmt = db.prepare(
              `UPDATE je_factor_assessments SET ai_level = ?, ai_confidence = ?, ai_alternative_level = ?, ai_rationale = ?, ai_output_id = ?, gap_note = ?, blind = ?,
                 adjustment_flag = CASE WHEN ? = 1 AND factor_code IN ('physical_skills', 'physical_effort', 'working_conditions') THEN 1 ELSE adjustment_flag END,
                 status = CASE WHEN ? IS NULL THEN 'insufficient_evidence' ELSE 'evidenced' END,
                 updated_at = datetime('now')
               WHERE review_id = ? AND factor_code = ? AND confirmed_decision IS NULL`
            );
            for (const f of r.validated.factors) {
              if (!batch.some((b) => b.code === f.factorCode)) continue; // stay in batch
              stmt.run(f.levelLabel, f.confidence, f.alternativeLevel, f.rationale, r.aiOutputId, f.gap, blind, adjustmentFlagged ? 1 : 0, f.levelLabel, reviewId, f.factorCode);
            }
          }
        }
      }

      // ── Deterministic: outcome on the AI basis ───────────────────────
      computeAndStoreOutcome(reviewId, 'ai_proposed', null);

      // ── S3: profile shortlist (deterministic) + rank commentary ──────
      if (stages.includes('profile_rank')) {
        const shortlist = shortlistProfiles(bundle, state.review, bundle.matchRules.shortlistLimit || 8);
        if (shortlist.length === 0) {
          markStage('profile_rank', 'skipped', { errorCode: 'no_profiles' });
        } else {
          const aiLevels = {};
          for (const row of db.prepare('SELECT factor_code, ai_level FROM je_factor_assessments WHERE review_id = ?').all(reviewId)) {
            aiLevels[row.factor_code] = row.ai_level;
          }
          db.prepare('DELETE FROM je_profile_matches WHERE review_id = ? AND selected_by IS NULL').run(reviewId);
          const profileIds = new Set(shortlist.map((p) => p.id));
          const matches = shortlist.map((p) => {
            const profileLevels = {};
            for (const pl of db.prepare('SELECT factor_code, level_min, level_max FROM je_profile_levels WHERE profile_id = ?').all(p.id)) {
              profileLevels[pl.factor_code] = [pl.level_min, pl.level_max];
            }
            return { profile: p, ...matchProfile(bundle, profileLevels, aiLevels, bundle.matchRules) };
          });
          const profileText = matches
            .map((m) => `[profileId ${m.profile.id}] ${m.profile.title} (band ${m.profile.band_label}, ${m.profile.job_family}) — computed fit: ${m.fit}; factors outside range: ${m.factorsOutside.map((f) => f.factorCode).join(', ') || 'none'}`)
            .join('\n');
          const r = await run('profile_rank', [{ role: 'user', content: `JOB TITLE: ${state.review.job_title}\n\nSHORTLISTED PROFILES:\n${profileText}\n\nComment on fit and mismatches only.` }], (raw) => validateProfileRank(raw, { profileIds }));
          const commentById = new Map((r.status === 'ok' ? r.validated.candidates : []).map((c) => [c.profileId, c]));
          const insert = db.prepare(
            `INSERT INTO je_profile_matches (review_id, profile_id, rank, fit, factors_outside_json, ai_rationale, ai_output_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          );
          matches
            .sort((a, b) => (a.fit === b.fit ? a.factorsOutside.length - b.factorsOutside.length : fitRank(a.fit) - fitRank(b.fit)))
            .forEach((m, i) => {
              const c = commentById.get(m.profile.id);
              insert.run(reviewId, m.profile.id, i + 1, m.fit, JSON.stringify(m.factorsOutside), c ? [c.fitComment, ...c.mismatches].filter(Boolean).join(' | ') : '', r.aiOutputId || null);
            });
        }
      }

      // ── S7: report prose ─────────────────────────────────────────────
      if (stages.includes('report')) {
        const levels = {};
        const confidence = {};
        for (const row of db.prepare('SELECT factor_code, ai_level, ai_confidence FROM je_factor_assessments WHERE review_id = ?').all(reviewId)) {
          levels[row.factor_code] = row.ai_level;
          confidence[row.factor_code] = row.ai_confidence || 'insufficient';
        }
        const outcome = computeOutcome(bundle, levels, confidence);
        const gaps = rankGaps(bundle, levels, confidence);
        const chunks = retrieveChunks(`job evaluation banding ${state.review.job_title} ${state.review.kind}`, 6);
        const chunkIds = new Set(chunks.map((k) => k.chunk_id));
        const extracts = chunks.map((k) => `[Extract ${k.chunk_id}] ${k.title} (${k.publisher})\n${k.content}`).join('\n\n') || '(no knowledge extracts matched — do not cite anything)';
        const allowedBandTokens = new Set([outcome.bandLow, outcome.bandHigh, outcome.bandLabel, state.review.current_band].filter(Boolean).map((b) => String(b).toLowerCase()));
        const allowedNumbers = new Set([outcome.totalPoints, outcome.pointsLow, outcome.pointsHigh].filter((n) => Number.isInteger(n)));
        const facts = [
          `COMPUTED FACTS (fixed — restate only, never recalculate):`,
          outcome.bandLabel ? `Indicative band: ${outcome.bandLabel}` : outcome.bandLow ? `Indicative band range: ${outcome.bandLow} to ${outcome.bandHigh}` : 'Indicative band: not determinable yet (insufficient assessed factors)',
          `Factors without enough information: ${outcome.factorsMissing}`,
          `Postholder's current band: ${state.review.current_band || 'not given'}`,
          `Top evidence gaps: ${gaps.map((g) => g.factorName).join('; ') || 'none'}`,
        ].join('\n');
        await run('report', [{ role: 'user', content: `${facts}\n\nKNOWLEDGE EXTRACTS (numbered, approved sources):\n${extracts}` }], (raw) => validateJeReport(raw, { providedChunkIds: chunkIds, allowedBandTokens, allowedNumbers }));
      }
    }
  } catch (err) {
    if (err.code === 'kill_switch') {
      runStatus = 'aborted';
      errorCode = 'kill_switch';
    } else {
      runStatus = 'failed';
      errorCode = String(err.code || 'error').slice(0, 40);
      console.error(`JE pipeline error for review ${reviewId}: ${err.message}`);
    }
  }

  // Deterministic close-out always runs: checks/flags refresh, stage move.
  try { runChecksAndFlags(reviewId); } catch { /* checks must never kill the run record */ }
  db.prepare(`UPDATE je_runs SET status = ?, error_code = ?, finished_at = datetime('now') WHERE id = ?`).run(runStatus, errorCode, runId);
  db.prepare(`UPDATE je_reviews SET stage = 'advisor_review', updated_at = datetime('now') WHERE id = ? AND stage = 'analysing'`).run(reviewId);
  const promptVersions = Object.fromEntries(JE_STAGES.filter((s) => stages.includes(s)).map((s) => [s, STAGE_PROMPTS[s][1]]));
  audit(requestedBy, 'je.run_completed', 'je_review', reviewId, { runId, status: runStatus, promptVersions });
  if (runStatus === 'complete') {
    for (const advisorId of advisorUserIds()) {
      notifyUserJe(advisorId, 'je_analysis_ready', `Analysis ready on band review #${reviewId}`, reviewId);
    }
  }
  return runId;
}

function fitRank(fit) {
  return fit === 'match' ? 0 : fit === 'partial' ? 1 : 2;
}

// Deterministic FTS shortlist over the ruleset's profile library.
function shortlistProfiles(bundle, review, limit) {
  const terms = `${review.job_title} ${review.staff_group_code}`
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  if (terms.length === 0) return [];
  const ftsQuery = [...new Set(terms)].slice(0, 12).map((t) => `"${t}"`).join(' OR ');
  try {
    return db
      .prepare(
        `SELECT p.* FROM je_profiles_fts f
         JOIN je_profiles p ON p.id = f.rowid
         WHERE je_profiles_fts MATCH ? AND p.ruleset_id = ? AND p.status = 'current'
         ORDER BY rank LIMIT ?`
      )
      .all(ftsQuery, bundle.ruleset.id, limit);
  } catch {
    return [];
  }
}
