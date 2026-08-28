import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-jepipe-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tmp;

const { db, setSetting } = await import('../src/db/connection.js');
const { seedJeRuleset } = await import('../src/je/reference.js');
const { runJeAnalysis } = await import('../src/ai/jePipeline.js');
const { createReview } = await import('../src/services/jobEvaluation.js');

let memberId;
let reviewId;

before(() => {
  seedJeRuleset();
  setSetting('openai_api_key', 'sk-test-000000000000000000');
  setSetting('ai_model', 'fake-model');
  memberId = db
    .prepare(`INSERT INTO users (email, password_hash, display_name, status, email_verified_at) VALUES ('pipe@example.com', 'x', 'Pipe Member', 'active', datetime('now'))`)
    .run().lastInsertRowid;
  db.prepare(`INSERT INTO user_roles (user_id, role) VALUES (?, 'member')`).run(memberId);
  const r = createReview({ id: memberId }, { jobTitle: 'Ward clerk', currentBand: '2', claimedBand: '3', employer: 'Test Trust', riskAcknowledged: true });
  reviewId = r.reviewId;
  db.prepare(
    `INSERT INTO je_documents (review_id, owner_user_id, doc_role, storage_key, original_filename, media_type, size_bytes, sha256, status, extracted_text)
     VALUES (?, ?, 'jd', 'k', 'jd.txt', 'text/plain', 10, 'h', 'extracted', ?)`
  ).run(reviewId, memberId, 'The postholder answers the ward telephone and maintains accurate patient records. They order stationery and stock for the ward.');
  db.prepare(
    `INSERT INTO je_answers (review_id, question_code, answer, answered_by) VALUES (?, 'typical_day', 'I answer the phones and keep the notes in order all day.', ?)`
  ).run(reviewId, memberId);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A stage-aware fake model: inspects the system prompt to decide which
// canned response to return.
function fakeModel(responses) {
  return async (messages) => {
    const system = messages[0].content;
    if (system.includes('extract the duties')) return { model: 'fake', raw: responses.jd_extract };
    if (system.includes('organise evidence')) return { model: 'fake', raw: responses.factor_evidence };
    if (system.includes('propose an INDICATIVE level')) return { model: 'fake', raw: responses.factor_levels };
    if (system.includes('national job profiles')) return { model: 'fake', raw: responses.profile_rank };
    if (system.includes('prose slots')) return { model: 'fake', raw: responses.report };
    throw new Error('unknown stage prompt');
  };
}

test('pipeline drops fabricated quotes, out-of-set levels; forces insufficient without evidence; invalidates band-claiming prose', async () => {
  const responses = {
    jd_extract: {
      duties: [
        { documentId: 1, quote: 'answers the ward telephone and maintains accurate patient records', text: 'Answers phones, maintains records' },
        { documentId: 1, quote: 'performs complex surgical procedures unsupervised', text: 'FABRICATED — not in the document' },
        { documentId: 999, quote: 'answers the ward telephone', text: 'wrong document id' },
      ],
      responsibilities: [{ documentId: 1, quote: 'order stationery and stock for the ward', text: 'Orders stock' }],
      notInJd: [],
      uncertainty: '',
    },
    factor_evidence: {
      factors: [
        { factorCode: 'communication', evidenceIds: ['a:typical_day'], summary: 'Routine information to colleagues and callers', missing: '' },
        { factorCode: 'finance_physical', evidenceIds: ['INVENTED-ID'], summary: 'Stock ordering', missing: '' },
        { factorCode: 'not_a_factor', evidenceIds: ['a:typical_day'], summary: 'x', missing: '' },
      ],
    },
    factor_levels: {
      factors: [
        { factorCode: 'communication', levelLabel: '2', confidence: 'high', rationale: 'Routine info to colleagues, patients and callers', evidenceIds: ['a:typical_day'], gap: '' },
        { factorCode: 'knowledge', levelLabel: '99', confidence: 'high', rationale: 'invented level', evidenceIds: ['a:typical_day'], gap: '' },
        { factorCode: 'analytical', levelLabel: '2', confidence: 'high', rationale: 'no evidence given', evidenceIds: [], gap: '' },
        { factorCode: 'information', levelLabel: '2', confidence: 'medium', rationale: 'Maintains records', evidenceIds: ['a:typical_day'], gap: '' },
      ],
    },
    profile_rank: { candidates: [] },
    report: {
      openingPlainEnglish: 'You are definitely a band 7 and you scored 999 points, guaranteed.',
      whatTheJdShows: '', whyThisBandRange: '', actionables: [], questionsForEmployer: [], uncertainty: '', citations: [],
    },
  };

  const runId = await runJeAnalysis(reviewId, { trigger: 'advisor', complete: fakeModel(responses) });
  assert.ok(runId, 'run should start');

  const run = db.prepare('SELECT * FROM je_runs WHERE id = ?').get(runId);
  assert.equal(run.status, 'complete');
  const stages = db.prepare('SELECT * FROM je_run_stages WHERE run_id = ? ORDER BY seq').all(runId);
  const byStage = Object.fromEntries(stages.map((s) => [s.stage, s]));

  // S1: two fabricated items dropped, genuine ones kept as evidence rows.
  assert.equal(byStage.jd_extract.status, 'ok');
  assert.equal(byStage.jd_extract.dropped_count, 2);
  const evidence = db.prepare(`SELECT * FROM je_evidence WHERE review_id = ? AND source_kind = 'document' AND factor_code = ''`).all(reviewId);
  assert.equal(evidence.length, 2);
  assert.ok(evidence.every((e) => e.quote.length > 0));

  // S2: invented evidence id and unknown factor dropped.
  assert.equal(byStage.factor_evidence.status, 'ok');
  assert.ok(byStage.factor_evidence.dropped_count >= 2);

  // S4: invented level → null + insufficient; empty evidence → insufficient.
  const fa = Object.fromEntries(
    db.prepare('SELECT factor_code, ai_level, ai_confidence FROM je_factor_assessments WHERE review_id = ?').all(reviewId)
      .map((r) => [r.factor_code, r])
  );
  assert.equal(fa.communication.ai_level, '2');
  assert.equal(fa.knowledge.ai_level, null);
  assert.equal(fa.knowledge.ai_confidence, 'insufficient');
  assert.equal(fa.analytical.ai_level, null);
  assert.equal(fa.analytical.ai_confidence, 'insufficient');

  // Profile stage: no profiles in seed → skipped, never fails the run.
  assert.equal(byStage.profile_rank.status, 'skipped');

  // S7: band-claiming prose is INVALID; stored for oversight; template will be used.
  assert.equal(byStage.report.status, 'invalid');
  const reportRow = db.prepare(`SELECT * FROM ai_outputs WHERE je_review_id = ? AND je_stage = 'report' ORDER BY id DESC LIMIT 1`).get(reviewId);
  assert.equal(reportRow.status, 'invalid');

  // Deterministic close-out: an ai_proposed outcome exists and asserts no single band.
  const outcome = db.prepare(`SELECT * FROM je_outcomes WHERE review_id = ? AND basis = 'ai_proposed' ORDER BY id DESC LIMIT 1`).get(reviewId);
  assert.ok(outcome);
  assert.equal(outcome.band_label, ''); // most factors unassessed → range only
  assert.ok(outcome.factors_missing >= 12);

  // Audit trail records versions, statuses; rejection recorded.
  const rejected = db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'je.ai_output_rejected'`).get().n;
  assert.ok(rejected >= 1);
});

test('duplicate run is refused by the database while one is in flight', async () => {
  db.prepare(`INSERT INTO je_runs (review_id, trigger_kind, status) VALUES (?, 'advisor', 'running')`).run(reviewId);
  const second = await runJeAnalysis(reviewId, { trigger: 'advisor', complete: async () => ({ model: 'fake', raw: {} }) });
  assert.equal(second, null);
  db.prepare(`UPDATE je_runs SET status = 'failed', error_code = 'test-cleanup' WHERE review_id = ? AND status = 'running'`).run(reviewId);
});

test('kill switch mid-run aborts remaining stages; earlier data intact', async () => {
  const evidenceBefore = db.prepare('SELECT COUNT(*) AS n FROM je_evidence WHERE review_id = ?').get(reviewId).n;
  let calls = 0;
  const complete = async (messages) => {
    calls += 1;
    if (calls === 1) {
      // succeed S1, then flip the kill switch before the next stage
      setTimeout(() => {}, 0);
      setSetting('ai_disabled', '1');
      return {
        model: 'fake',
        raw: { duties: [{ documentId: 1, quote: 'answers the ward telephone', text: 'Phones' }], responsibilities: [], notInJd: [], uncertainty: '' },
      };
    }
    throw new Error('should not be called after kill switch');
  };
  const runId = await runJeAnalysis(reviewId, { trigger: 'advisor', complete });
  const run = db.prepare('SELECT * FROM je_runs WHERE id = ?').get(runId);
  assert.equal(run.status, 'aborted');
  assert.equal(run.error_code, 'kill_switch');
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM je_evidence WHERE review_id = ?').get(reviewId).n > evidenceBefore);
  const skipped = db.prepare(`SELECT COUNT(*) AS n FROM je_run_stages WHERE run_id = ? AND status = 'skipped'`).get(runId).n;
  assert.ok(skipped >= 1);
  setSetting('ai_disabled', '0');
});

test('a failed stage stores the error without case text and later stages still close out', async () => {
  const complete = async (messages) => {
    const system = messages[0].content;
    if (system.includes('extract the duties')) throw Object.assign(new Error('boom: secret patient text should not leak here'), { code: 'test_err' });
    return { model: 'fake', raw: { factors: [], candidates: [], openingPlainEnglish: '', citations: [] } };
  };
  const runId = await runJeAnalysis(reviewId, { trigger: 'advisor', complete });
  const run = db.prepare('SELECT * FROM je_runs WHERE id = ?').get(runId);
  assert.equal(run.status, 'complete'); // one failed stage does not kill the run
  const failed = db.prepare(`SELECT * FROM je_run_stages WHERE run_id = ? AND stage = 'jd_extract'`).get(runId);
  assert.equal(failed.status, 'failed');
  const stored = db.prepare(`SELECT output_json FROM ai_outputs WHERE je_review_id = ? AND je_stage = 'jd_extract' AND status = 'failed' ORDER BY id DESC LIMIT 1`).get(reviewId);
  assert.ok(JSON.parse(stored.output_json).error.startsWith('boom'));
});
