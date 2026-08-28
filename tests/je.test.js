import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolated environment must be set before the app is imported.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-je-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tmp;
process.env.ADMIN_INITIAL_PASSWORD = 'admin-test-password-1';

const { app } = await import('../src/server.js');
const { db } = await import('../src/db/connection.js');
const { seedJeRuleset } = await import('../src/je/reference.js');
const { CHECKLIST_ITEMS } = await import('../src/je/guard.js');

let server;
let base;

before(async () => {
  seedJeRuleset();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        'x-requested-with': 'fetch',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  };
  call.raw = (pathname) => fetch(base + pathname, { headers: { 'x-requested-with': 'fetch', ...(cookie ? { cookie } : {}) } });
  return call;
}

async function registerAndVerify(api, email, name) {
  await api('/api/auth/register', { method: 'POST', body: { email, password: 'longpassword-1', displayName: name, payBand: 'band_5' } });
  const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  db.prepare(`UPDATE users SET status = 'active', email_verified_at = datetime('now') WHERE id = ?`).run(userId);
  await api('/api/auth/login', { method: 'POST', body: { email, password: 'longpassword-1' } });
  return userId;
}

const admin = client(); // main admin: advisor + admin roles, every permission
const memberA = client();
const memberB = client();
let memberAId;
let reviewId;

test('setup: sign in users', async () => {
  const login = await admin('/api/auth/login', { method: 'POST', body: { email: 'mapadocrew@gmail.com', password: 'admin-test-password-1' } });
  assert.equal(login.status, 200);
  memberAId = await registerAndVerify(memberA, 'je-a@example.com', 'Member A');
  await registerAndVerify(memberB, 'je-b@example.com', 'Member B');
});

test('status reports seeded reference data and the offer', async () => {
  const r = await memberA('/api/je/status');
  assert.equal(r.status, 200);
  assert.equal(r.data.ready, true);
  assert.equal(r.data.offer.priceGbp, 395);
  assert.equal(r.data.offer.vatApplies, true);
  assert.equal(r.data.offer.inclusions.length, 6);
});

test('creating a review requires the risk acknowledgement', async () => {
  const missing = await memberA('/api/je/reviews', { method: 'POST', body: { jobTitle: 'Healthcare assistant' } });
  assert.equal(missing.status, 400);
  const r = await memberA('/api/je/reviews', {
    method: 'POST',
    body: { jobTitle: 'Healthcare assistant', kind: 'band_review', currentBand: '3', claimedBand: '4', employer: 'Test Trust', riskAcknowledged: true },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  reviewId = r.data.reviewId;
  assert.ok(r.data.questions.questions.length > 0);
  // factor assessment rows exist for every seeded factor
  const n = db.prepare('SELECT COUNT(*) AS n FROM je_factor_assessments WHERE review_id = ?').get(reviewId).n;
  assert.equal(n, 16);
});

test('member B gets 404 on member A review — read and every mutation', async () => {
  for (const [method, url, body] of [
    ['GET', `/api/je/reviews/${reviewId}`],
    ['PATCH', `/api/je/reviews/${reviewId}/answers`, { expectedVersion: 0, answers: { typical_day: 'x' } }],
    ['PATCH', `/api/je/reviews/${reviewId}/factors/communication`, { claimedLevel: '3' }],
    ['POST', `/api/je/reviews/${reviewId}/comparators`, { comparatorRef: 'A colleague, Band 6' }],
    ['POST', `/api/je/reviews/${reviewId}/messages`, { content: 'hello' }],
    ['POST', `/api/je/reviews/${reviewId}/submit`],
  ]) {
    const r = await memberB(url, { method, body });
    assert.equal(r.status, 404, `${method} ${url} → ${r.status}`);
  }
});

test('member cannot reach advisor, oversight or reference routes', async () => {
  for (const url of ['/api/je/queue', `/api/je/reviews/${reviewId}/workbench`, '/api/je/oversight', '/api/je/reference', '/api/je/metrics']) {
    const r = await memberA(url);
    assert.equal(r.status, 403, `${url} → ${r.status}`);
  }
  const conf = await memberA(`/api/je/reviews/${reviewId}/factors/communication/confirm`, { method: 'PATCH', body: { decision: 'agree' } });
  assert.equal(conf.status, 403);
  const off = await memberA('/api/je/offer', { method: 'POST', body: { priceGbp: 1 } });
  assert.equal(off.status, 403);
});

test('answers save with optimistic locking; stale write returns 409 with server state', async () => {
  const ok = await memberA(`/api/je/reviews/${reviewId}/answers`, {
    method: 'PATCH',
    body: { expectedVersion: 0, answers: { typical_day: 'I run the ward stores, order stock and train new starters.', communication_who: 'Distressed relatives every week; I de-escalate.' } },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.answersVersion, 1);
  const stale = await memberA(`/api/je/reviews/${reviewId}/answers`, {
    method: 'PATCH', body: { expectedVersion: 0, answers: { typical_day: 'overwrite attempt' } },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.answers.typical_day, 'I run the ward stores, order stock and train new starters.');
  const unknown = await memberA(`/api/je/reviews/${reviewId}/answers`, {
    method: 'PATCH', body: { expectedVersion: 1, answers: { not_a_question: 'x' } },
  });
  assert.equal(unknown.status, 400);
});

test('submit is idempotent and notifies advisors once', async () => {
  const first = await memberA(`/api/je/reviews/${reviewId}/submit`, { method: 'POST' });
  assert.equal(first.status, 200);
  assert.equal(first.data.stage, 'member_submitted');
  const again = await memberA(`/api/je/reviews/${reviewId}/submit`, { method: 'POST' });
  assert.equal(again.status, 200);
  assert.equal(again.data.alreadySubmitted, true);
  const notes = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE type = 'je_submitted' AND je_review_id = ?`).get(reviewId).n;
  assert.equal(notes, 1); // one advisor (main admin), notified exactly once
});

test('advisor workbench loads; member view hides advisor data', async () => {
  const wb = await admin(`/api/je/reviews/${reviewId}/workbench`);
  assert.equal(wb.status, 200, JSON.stringify(wb.data).slice(0, 300));
  assert.equal(wb.data.factors.length, 16);
  assert.ok(wb.data.bundle.bands.length >= 2);
  assert.ok(Array.isArray(wb.data.checks));
  const mv = await memberA(`/api/je/reviews/${reviewId}`);
  assert.equal(mv.status, 200);
  assert.equal(mv.data.reports.length, 0); // nothing approved yet
  assert.equal(JSON.stringify(mv.data).includes('ai_level'), false);
});

test('advisor member-visible message is guarded against outcome assertions', async () => {
  const bad = await admin(`/api/je/reviews/${reviewId}/messages/advisor`, {
    method: 'POST', body: { content: 'Good news — your job is band 6, guaranteed.' },
  });
  assert.equal(bad.status, 400);
  const good = await admin(`/api/je/reviews/${reviewId}/messages/advisor`, {
    method: 'POST', body: { kind: 'question', content: 'Could you tell me who checks your work day to day?' },
  });
  assert.equal(good.status, 200);
});

test('factor confirmation: amend requires a reason code; unknown level rejected; recompute appends', async () => {
  const noReason = await admin(`/api/je/reviews/${reviewId}/factors/communication/confirm`, {
    method: 'PATCH', body: { decision: 'amend', level: '3' },
  });
  assert.equal(noReason.status, 400);
  const badLevel = await admin(`/api/je/reviews/${reviewId}/factors/communication/confirm`, {
    method: 'PATCH', body: { decision: 'amend', level: '9', reasonCode: 'under_scored' },
  });
  assert.equal(badLevel.status, 400);
  const outcomesBefore = db.prepare('SELECT COUNT(*) AS n FROM je_outcomes WHERE review_id = ?').get(reviewId).n;
  const ok = await admin(`/api/je/reviews/${reviewId}/factors/communication/confirm`, {
    method: 'PATCH', body: { decision: 'amend', level: '3', reasonCode: 'under_scored', note: 'JD supports level 3' },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const outcomesAfter = db.prepare('SELECT COUNT(*) AS n FROM je_outcomes WHERE review_id = ?').get(reviewId).n;
  assert.equal(outcomesAfter, outcomesBefore + 1); // append-only
});

test('sign-off is blocked until every factor is resolved and flags acknowledged', async () => {
  const checklist = Object.fromEntries(CHECKLIST_ITEMS.map((i) => [i.code, true]));
  const early = await admin(`/api/je/reviews/${reviewId}/signoff`, {
    method: 'POST', body: { checklist, recommendation: 'supports' },
  });
  assert.equal(early.status, 400);
  // Resolve all remaining factors as "insufficient" except the one confirmed.
  const rows = db.prepare(`SELECT factor_code FROM je_factor_assessments WHERE review_id = ? AND confirmed_decision IS NULL`).all(reviewId);
  for (const row of rows) {
    const r = await admin(`/api/je/reviews/${reviewId}/factors/${row.factor_code}/confirm`, {
      method: 'PATCH', body: { decision: 'insufficient' },
    });
    assert.equal(r.status, 200, `${row.factor_code}: ${JSON.stringify(r.data)}`);
  }
  // Acknowledge open high/critical flags.
  const flags = db.prepare(`SELECT id FROM je_flags WHERE review_id = ? AND severity IN ('critical','high') AND resolved_at IS NULL AND acknowledged_at IS NULL`).all(reviewId);
  for (const f of flags) {
    const r = await admin(`/api/je/reviews/${reviewId}/flags/${f.id}/ack`, { method: 'POST' });
    assert.equal(r.status, 200);
  }
  const incompleteChecklist = await admin(`/api/je/reviews/${reviewId}/signoff`, {
    method: 'POST', body: { checklist: { all_factors_resolved: true }, recommendation: 'supports' },
  });
  assert.equal(incompleteChecklist.status, 400);
  const signed = await admin(`/api/je/reviews/${reviewId}/signoff`, {
    method: 'POST', body: { checklist, recommendation: 'more_information', secondOpinionWaivedReason: 'Pilot: single advisor; discussed with peer reviewer offline.' },
  });
  assert.equal(signed.status, 200, JSON.stringify(signed.data));
  assert.equal(signed.data.stage, 'report_ready');
});

let memberReportId;

test('reports: draft, approve-and-issue exactly once; member sees it only after approval', async () => {
  const before = await memberA(`/api/je/reviews/${reviewId}`);
  assert.equal(before.data.reports.length, 0);

  const draft = await admin(`/api/je/reviews/${reviewId}/reports`, { method: 'POST', body: { audience: 'member' } });
  assert.equal(draft.status, 200, JSON.stringify(draft.data).slice(0, 300));
  memberReportId = draft.data.reportId;
  assert.ok(draft.data.body.standardSentence.includes('does not decide your band'));
  assert.ok(draft.data.body.actions.length <= 5);

  const still = await memberA(`/api/je/reviews/${reviewId}`);
  assert.equal(still.data.reports.length, 0); // drafts are invisible to members

  const badEdit = await admin(`/api/je/reports/${memberReportId}/approve`, {
    method: 'POST', body: { edits: { opening: 'Your job is band 6 and the panel will agree.' } },
  });
  assert.equal(badEdit.status, 400);

  const ok = await admin(`/api/je/reports/${memberReportId}/approve`, {
    method: 'POST', body: { edits: { opening: 'The evidence Kelly confirmed points towards a stronger case than the current band reflects.' } },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, 'issued');

  const race = await admin(`/api/je/reports/${memberReportId}/approve`, { method: 'POST' });
  assert.equal(race.status, 410); // claim-then-execute

  const afterView = await memberA(`/api/je/reviews/${reviewId}`);
  assert.equal(afterView.data.reports.length, 1);
  const msgs = db.prepare(`SELECT COUNT(*) AS n FROM je_messages WHERE review_id = ? AND kind = 'report' AND approved_by IS NOT NULL`).get(reviewId).n;
  assert.equal(msgs, 1);
  const notes = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE type = 'je_report_ready' AND user_id = ?`).get(memberAId).n;
  assert.equal(notes, 1);
});

test('employer submission excludes the indicative range unless opted in with a reason', async () => {
  const noReason = await admin(`/api/je/reviews/${reviewId}/reports`, {
    method: 'POST', body: { audience: 'employer_submission', includesBandRange: true },
  });
  assert.equal(noReason.status, 400);
  const plain = await admin(`/api/je/reviews/${reviewId}/reports`, { method: 'POST', body: { audience: 'employer_submission' } });
  assert.equal(plain.status, 200);
  assert.equal(plain.data.body.indicativeRange, undefined);
  const md = await admin.raw(`/api/je/reviews/${reviewId}/submission.md`);
  assert.equal(md.status, 200);
  const text = await md.text();
  assert.ok(text.includes('# Request for job evaluation review'));
  assert.ok(!/Indicative assessment range/.test(text));
});

test('decisions are the only path to a real band and drive the stage machine', async () => {
  const toEmployer = await admin(`/api/je/reviews/${reviewId}/decisions`, {
    method: 'POST', body: { kind: 'request_submitted', decisionDate: '2026-08-01', source: 'advisor' },
  });
  assert.equal(toEmployer.status, 200);
  const outcome = await admin(`/api/je/reviews/${reviewId}/decisions`, {
    method: 'POST', body: { kind: 'outcome_issued', decisionDate: '2026-08-20', bandAwarded: '4', decidedBy: 'matching_panel' },
  });
  assert.equal(outcome.status, 200);
  const review = db.prepare('SELECT stage FROM je_reviews WHERE id = ?').get(reviewId);
  assert.equal(review.stage, 'outcome_received');
  // Appeal-window check should now flag
  const wb = await admin(`/api/je/reviews/${reviewId}/workbench`);
  assert.ok(wb.data.checks.some((c) => c.id === 'appeal_window'));
});

test('audit meta never contains free text', async () => {
  const rows = db.prepare(`SELECT action, meta FROM audit_events WHERE action LIKE 'je.%'`).all();
  assert.ok(rows.length > 5);
  const memberText = 'I run the ward stores';
  for (const row of rows) {
    assert.ok(!row.meta.includes(memberText), `${row.action} leaked answer text`);
    assert.ok(!row.meta.toLowerCase().includes('je-a@example.com'), `${row.action} leaked email`);
    assert.ok(row.meta.length < 600, `${row.action} meta too large: ${row.meta.length}`);
  }
});

test('JE content cannot reach the knowledge base', async () => {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM knowledge_chunks`).get().n;
  assert.equal(n, 0);
});

test('oversight metrics are aggregate-only', async () => {
  const r = await admin('/api/je/oversight');
  assert.equal(r.status, 200);
  const blob = JSON.stringify(r.data);
  assert.ok(!blob.includes('je-a@example.com'));
  assert.ok(!blob.includes('ward stores'));
  assert.ok(Array.isArray(r.data.perFactor));
});

test('admin can update the offer; audit records names only', async () => {
  const r = await admin('/api/je/offer', { method: 'POST', body: { priceGbp: 425, headline: 'Standard band review service' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.offer.priceGbp, 425);
  const seen = await memberA('/api/je/offer');
  assert.equal(seen.data.offer.priceGbp, 425);
  const evt = db.prepare(`SELECT meta FROM audit_events WHERE action = 'je.offer_updated' ORDER BY id DESC LIMIT 1`).get();
  assert.ok(!evt.meta.includes('425'));
});

test('reference import validates; approval supersedes and flags open reviews; recompute appends', async () => {
  const bad = await admin('/api/je/reference/rulesets', { method: 'POST', body: { scheme: 'afc', label: 'Broken', factors: [], bands: [] } });
  assert.equal(bad.status, 400);
  // Import a tiny but valid replacement bundle.
  const bundle = {
    scheme: 'afc', label: 'Replacement test ruleset', sourceNote: 'test',
    factors: [
      { code: 'alpha', seq: 1, name: 'Alpha', description: 'd', levels: [{ label: '1', points: 5, descriptor: 'x' }, { label: '2', points: 10, descriptor: 'y' }] },
    ],
    bands: [{ label: 'A', min: 0, max: 7 }, { label: 'B', min: 8, max: 20 }],
    profiles: [],
  };
  const imp = await admin('/api/je/reference/rulesets', { method: 'POST', body: bundle });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  const newId = imp.data.rulesetId;

  const issuedBefore = db.prepare(`SELECT body_json FROM je_reports WHERE id = ?`).get(memberReportId).body_json;
  const outcomesBefore = db.prepare('SELECT COUNT(*) AS n FROM je_outcomes WHERE review_id = ?').get(reviewId).n;

  const approve = await admin(`/api/je/reference/rulesets/${newId}/approve`, { method: 'POST' });
  assert.equal(approve.status, 200);
  assert.ok(approve.data.flaggedReviews >= 1);
  const flag = db.prepare(`SELECT COUNT(*) AS n FROM je_flags WHERE review_id = ? AND rule_id = 'superseded_ruleset' AND resolved_at IS NULL`).get(reviewId).n;
  assert.ok(flag >= 1);

  // Issued reports and prior outcomes are untouched by the supersede.
  assert.equal(db.prepare(`SELECT body_json FROM je_reports WHERE id = ?`).get(memberReportId).body_json, issuedBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM je_outcomes WHERE review_id = ?').get(reviewId).n, outcomesBefore);

  // Recompute on the pinned (now superseded) ruleset still appends.
  const rc = await admin(`/api/je/reviews/${reviewId}/recompute`, { method: 'POST', body: { basis: 'confirmed' } });
  assert.equal(rc.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM je_outcomes WHERE review_id = ?').get(reviewId).n, outcomesBefore + 1);
});

test('verify marks the seed as human-checked', async () => {
  const seedRow = db.prepare(`SELECT id FROM je_rulesets WHERE origin = 'seed'`).get();
  const r = await admin(`/api/je/reference/rulesets/${seedRow.id}/verify`, { method: 'POST' });
  assert.equal(r.status, 200);
  const again = await admin(`/api/je/reference/rulesets/${seedRow.id}/verify`, { method: 'POST' });
  assert.equal(again.status, 400);
});
