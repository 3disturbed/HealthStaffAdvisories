import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-membership-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tmp;
process.env.ADMIN_INITIAL_PASSWORD = 'admin-test-password-1';

const { app } = await import('../src/server.js');
const { db, setSetting } = await import('../src/db/connection.js');
const {
  loyaltyDiscountPct, upgradeQuote, createQuote, applyPurchase, recordComp,
  costToValue, currentSubscription, updateTier, toDbTs,
} = await import('../src/services/membership.js');
const { aiAllowanceState, enqueueOrRun, processAiQueue } = await import('../src/services/aiQueue.js');
const { hashPassword } = await import('../src/auth/passwords.js');

let server;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const admin = () => db.prepare('SELECT * FROM users WHERE is_main_admin = 1').get();

function makeMember(email, createdDaysAgo = 0, createdAt = null) {
  const id = createdAt
    ? db.prepare(`INSERT INTO users (email, password_hash, display_name, status, email_verified_at, pay_band, created_at)
                  VALUES (?, ?, ?, 'active', datetime('now'), 'band_5', ?)`)
      .run(email, hashPassword('longpassword-1'), email.split('@')[0], createdAt).lastInsertRowid
    : db.prepare(`INSERT INTO users (email, password_hash, display_name, status, email_verified_at, pay_band, created_at)
                  VALUES (?, ?, ?, 'active', datetime('now'), 'band_5', datetime('now', ?))`)
      .run(email, hashPassword('longpassword-1'), email.split('@')[0], `-${createdDaysAgo} days`).lastInsertRowid;
  db.prepare(`INSERT INTO user_roles (user_id, role) VALUES (?, 'member')`).run(id);
  return id;
}

function giveSubscription(userId, tierId, periodStart, periodEnd) {
  db.prepare(`INSERT INTO subscriptions (user_id, tier_id, status, period_start, period_end) VALUES (?, ?, 'active', ?, ?)`)
    .run(userId, tierId, periodStart, periodEnd);
}

function payment(userId, amountPence, tierId = 'standard', kind = 'purchase') {
  db.prepare(`INSERT INTO payments (user_id, amount_pence, kind, tier_id, period_start, period_end) VALUES (?, ?, ?, ?, datetime('now'), datetime('now', '+1 month'))`)
    .run(userId, amountPence, kind, tierId);
}

function aiRuns(userId, n, agoModifier = '-1 hour') {
  for (let i = 0; i < n; i += 1) {
    db.prepare(`INSERT INTO ai_outputs (case_id, billed_user_id, task, provider, model, prompt_version, status, output_json, created_at)
                VALUES (NULL, ?, 'intake', 'openai', 'test', 'v', 'ok', '{}', datetime('now', ?))`)
      .run(userId, agoModifier);
  }
}

function makeCase(userId, status = 'gathering') {
  return db.prepare(`INSERT INTO cases (member_id, title, what_happened, status) VALUES (?, 'T', 'narrative', ?)`)
    .run(userId, status).lastInsertRowid;
}

// ── formulas ─────────────────────────────────────────────────────────────

test('loyalty discount: bounded, monotonic, saturating', () => {
  assert.equal(loyaltyDiscountPct(0, 0), 0);
  assert.equal(loyaltyDiscountPct(2, 730), 30);
  assert.equal(loyaltyDiscountPct(99, 9999), 30); // hard cap
  assert.ok(loyaltyDiscountPct(1, 100) < loyaltyDiscountPct(2, 100));
  assert.ok(loyaltyDiscountPct(1, 100) < loyaltyDiscountPct(1, 400));
  assert.ok(loyaltyDiscountPct(-5, -5) === 0); // never negative
});

test('worked example 1: typical Standard→Plus mid-period upgrade = 335p', () => {
  const u = makeMember('typical@example.com', 0, '2026-05-18 10:00:00'); // 90 days before the fixed 'now'
  giveSubscription(u, 'standard', '2026-08-01 00:00:00', '2026-09-01 00:00:00');
  payment(u, 799);
  aiRuns(u, 6);
  const caseId = makeCase(u); // 1 open case ×500
  db.prepare(`INSERT INTO case_messages (case_id, author_user_id, visibility, kind, content, approved_by) VALUES (?, ?, 'member', 'message', 'reply', ?)`)
    .run(caseId, admin().id, admin().id); // 1 approved reply ×300
  db.prepare(`INSERT INTO documents (owner_user_id, case_id, storage_key, original_filename, media_type, size_bytes, sha256) VALUES (?, ?, 'k1', 'a.txt', 'text/plain', 1, 'h1')`).run(u, caseId);
  db.prepare(`INSERT INTO documents (owner_user_id, case_id, storage_key, original_filename, media_type, size_bytes, sha256) VALUES (?, ?, 'k2', 'b.txt', 'text/plain', 1, 'h2')`).run(u, caseId); // 2 docs ×20

  const cv = costToValue(u, new Date('2026-08-16T10:00:00Z'));
  assert.equal(cv.paidPence, 799);
  assert.equal(cv.estCostPence, 6 * 40 + 300 + 2 * 20 + 500); // 1080

  const q = upgradeQuote(u, 'plus', new Date('2026-08-16T10:00:00Z'));
  assert.equal(q.kind, 'upgrade');
  assert.equal(q.breakdown.daysTotal, 31);
  assert.equal(q.breakdown.daysLeft, 16);
  assert.equal(q.breakdown.targetProRataPence, 774);
  assert.equal(q.breakdown.currentCreditPence, 412);
  assert.equal(q.breakdown.discountPct, 7.4);
  assert.equal(q.amountPence, 335);
  assert.equal(q.autoApply, false);
  assert.equal(q.breakdown.periodEnd, '2026-09-01 00:00:00'); // renewal unchanged
});

test('worked example 2: high-CV member pays 285p for the same upgrade', () => {
  const u = makeMember('highcv@example.com', 0, '2025-10-20 10:00:00'); // 300 days before the fixed 'now'
  giveSubscription(u, 'standard', '2026-08-01 00:00:00', '2026-09-01 00:00:00');
  payment(u, 4794);
  aiRuns(u, 10); // estCost 400 → CV ≈ 11.99 → cvPart capped at 15

  const q = upgradeQuote(u, 'plus', new Date('2026-08-16T10:00:00Z'));
  assert.equal(q.breakdown.discountPct, 21.16);
  assert.equal(q.amountPence, 285);
});

test('worked example 3: near renewal drops below the card minimum → autoApply', () => {
  const u = makeMember('nearrenewal@example.com', 90);
  giveSubscription(u, 'standard', '2026-08-01 00:00:00', '2026-09-01 00:00:00');
  payment(u, 799);
  aiRuns(u, 6);
  const caseId = makeCase(u);
  db.prepare(`INSERT INTO case_messages (case_id, author_user_id, visibility, kind, content, approved_by) VALUES (?, ?, 'member', 'message', 'reply', ?)`)
    .run(caseId, admin().id, admin().id);
  db.prepare(`INSERT INTO documents (owner_user_id, case_id, storage_key, original_filename, media_type, size_bytes, sha256) VALUES (?, ?, 'k3', 'a.txt', 'text/plain', 1, 'h3')`).run(u, caseId);
  db.prepare(`INSERT INTO documents (owner_user_id, case_id, storage_key, original_filename, media_type, size_bytes, sha256) VALUES (?, ?, 'k4', 'b.txt', 'text/plain', 1, 'h4')`).run(u, caseId);

  const q = upgradeQuote(u, 'plus', new Date('2026-08-31T18:00:00Z'));
  assert.equal(q.breakdown.daysLeft, 1);
  assert.equal(q.breakdown.targetProRataPence, 48);
  assert.equal(q.breakdown.currentCreditPence, 26);
  assert.equal(q.amountPence, 20);
  assert.equal(q.autoApply, true);
});

test('quote edges: pilot purchase, same tier, downgrade, cold start', () => {
  const u = makeMember('edges@example.com', 10);
  // Implicit Pilot → purchase kind, tenure-only discount, no NaN.
  const q = upgradeQuote(u, 'standard');
  assert.equal(q.kind, 'purchase');
  assert.ok(Number.isFinite(q.amountPence) && q.amountPence > 0 && q.amountPence <= 799);

  assert.match(upgradeQuote(u, 'pilot').error, /already/);

  giveSubscription(u, 'plus', toDbTs(new Date()), db.prepare(`SELECT datetime('now', '+1 month') AS e`).get().e);
  assert.match(upgradeQuote(u, 'plus').error, /already/);
  assert.match(upgradeQuote(u, 'standard').error, /Downgrades/);
});

// ── fulfilment ───────────────────────────────────────────────────────────

test('applyPurchase is idempotent per Stripe session and honours the frozen quote', () => {
  const u = makeMember('fulfil@example.com', 30);
  const quote = createQuote(u, 'standard');
  assert.ok(quote.ok);

  const first = applyPurchase({ userId: u, tierId: 'standard', kind: quote.kind, quoteId: quote.quoteId, stripeSessionId: 'cs_test_1', amountPence: quote.amountPence });
  assert.ok(first.ok && !first.already);
  const second = applyPurchase({ userId: u, tierId: 'standard', kind: quote.kind, quoteId: quote.quoteId, stripeSessionId: 'cs_test_1', amountPence: quote.amountPence });
  assert.equal(second.already, true);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE stripe_session_id = 'cs_test_1'`).get().n, 1);

  const state = currentSubscription(u);
  assert.equal(state.tier.id, 'standard');
  assert.equal(state.implicitPilot, false);
});

test('upgrade fulfilment keeps the original renewal date', () => {
  const u = makeMember('keepdate@example.com', 30);
  giveSubscription(u, 'standard', '2026-08-01 00:00:00', '2026-09-01 00:00:00');
  const q = createQuote(u, 'plus', new Date('2026-08-16T10:00:00Z'));
  const applied = applyPurchase({ userId: u, tierId: 'plus', kind: 'upgrade', quoteId: q.quoteId, stripeSessionId: 'cs_test_keep', amountPence: q.amountPence }, new Date('2026-08-16T10:05:00Z'));
  assert.ok(applied.ok);
  const sub = db.prepare(`SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'`).get(u);
  assert.equal(sub.tier_id, 'plus');
  assert.equal(sub.period_end, '2026-09-01 00:00:00');
});

test('missing quote still fulfils from metadata (money is never lost)', () => {
  const u = makeMember('noquote@example.com', 5);
  const applied = applyPurchase({ userId: u, tierId: 'standard', kind: 'purchase', quoteId: 99999, stripeSessionId: 'cs_test_orphan', amountPence: 799 });
  assert.ok(applied.ok);
  assert.equal(currentSubscription(u).tier.id, 'standard');
  assert.ok(db.prepare(`SELECT 1 FROM audit_events WHERE action = 'payment.fulfilled_without_quote'`).get());
});

test('recordComp grants a subscription with a zero-amount ledger row', () => {
  const u = makeMember('comp@example.com', 5);
  const r = recordComp(admin(), u, { tierId: 'plus', months: 2, note: 'pilot thank-you' });
  assert.ok(r.ok);
  assert.equal(currentSubscription(u).tier.id, 'plus');
  const row = db.prepare(`SELECT * FROM payments WHERE user_id = ? AND kind = 'comp'`).get(u);
  assert.equal(row.amount_pence, 0);
  assert.equal(row.recorded_by, admin().id);
});

test('costToValue responds to admin-tuned weights', () => {
  const u = makeMember('weights@example.com', 5);
  aiRuns(u, 5);
  const before = costToValue(u).estCostPence;
  setSetting('cv_weight_ai', 100);
  const afterTune = costToValue(u).estCostPence;
  assert.equal(before, 200);
  assert.equal(afterTune, 500);
  setSetting('cv_weight_ai', 40);
});

// ── allowance & queue ────────────────────────────────────────────────────

test('allowance counts the rolling 24h and computes nextFreeAt from the oldest run', () => {
  const u = makeMember('allowance@example.com', 5); // implicit Pilot: 3/day
  aiRuns(u, 1, '-23 hours');
  aiRuns(u, 2, '-1 hour');
  const state = aiAllowanceState(u);
  assert.equal(state.allowance, 3);
  assert.equal(state.used, 3);
  assert.equal(state.remaining, 0);
  // Oldest in-window row (23h ago) + 24h → frees in ~1h.
  const msUntilFree = new Date(state.nextFreeAt) - new Date();
  assert.ok(msUntilFree > 30 * 60000 && msUntilFree < 90 * 60000, `nextFreeAt off: ${state.nextFreeAt}`);
});

test('exhausted allowance queues instead of rejecting; concurrent calls cannot overspend', () => {
  setSetting('openai_api_key', 'sk-test-000000000000000000000000');
  const u = makeMember('queue@example.com', 5);
  updateTier(admin(), 'pilot', { aiDailyAllowance: 1 });

  const caseA = makeCase(u);
  const caseB = makeCase(u);
  const first = enqueueOrRun({ caseId: caseA, userId: u, task: 'intake' });
  const second = enqueueOrRun({ caseId: caseB, userId: u, task: 'intake' });
  assert.equal(first.ran, true);
  assert.equal(second.queued, true);
  assert.ok(second.expectedAt);
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM ai_jobs WHERE user_id = ? GROUP BY status`).all(u);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  assert.ok((byStatus.running || 0) + (byStatus.failed || 0) + (byStatus.queued || 0) >= 2);
  assert.equal(byStatus.queued, 1); // the second call queued — never rejected

  updateTier(admin(), 'pilot', { aiDailyAllowance: 3 });
  db.prepare('DELETE FROM settings WHERE key = ?').run('openai_api_key');
});

test('worker promotes due jobs when allowance frees, and pushes them back when it has not', async () => {
  setSetting('openai_api_key', 'sk-test-000000000000000000000000');
  const u = makeMember('promote@example.com', 5);
  updateTier(admin(), 'pilot', { aiDailyAllowance: 1 });
  const caseId = makeCase(u);

  // Allowance fully used by a recent run; one queued job already due.
  aiRuns(u, 1, '-1 hour');
  db.prepare(`INSERT INTO ai_jobs (case_id, user_id, task, status, not_before) VALUES (?, ?, 'intake', 'queued', datetime('now', '-1 minute'))`).run(caseId, u);
  await processAiQueue();
  let job = db.prepare(`SELECT * FROM ai_jobs WHERE case_id = ?`).get(caseId);
  assert.equal(job.status, 'queued'); // still exhausted → pushed back, not rejected
  assert.ok(job.not_before);

  // Free the allowance (backdate the usage out of the window) → promoted.
  db.prepare(`UPDATE ai_outputs SET created_at = datetime('now', '-25 hours') WHERE billed_user_id = ?`).run(u);
  db.prepare(`UPDATE ai_jobs SET not_before = datetime('now', '-1 minute') WHERE case_id = ?`).run(caseId);
  await processAiQueue();
  job = db.prepare(`SELECT * FROM ai_jobs WHERE case_id = ?`).get(caseId);
  assert.ok(['running', 'queued', 'failed'].includes(job.status));
  assert.notEqual(job.status + job.not_before, 'queued' + null);
  assert.ok(job.status !== 'queued' || job.attempts > 0 || job.started_at, 'job was promoted');

  updateTier(admin(), 'pilot', { aiDailyAllowance: 3 });
  db.prepare('DELETE FROM settings WHERE key = ?').run('openai_api_key');
});

test('stale running jobs are recovered by the worker', async () => {
  const u = makeMember('stale@example.com', 5);
  const caseId = makeCase(u);
  db.prepare(`INSERT INTO ai_jobs (case_id, user_id, task, status, started_at) VALUES (?, ?, 'intake', 'running', datetime('now', '-20 minutes'))`).run(caseId, u);
  await processAiQueue(); // ai disabled here → recovery still runs
  const job = db.prepare(`SELECT * FROM ai_jobs WHERE case_id = ?`).get(caseId);
  assert.equal(job.status, 'queued');
  assert.equal(job.attempts, 1);
});

// ── Phase 0: ledger correctness ──────────────────────────────────────────
// The sub-30p auto-apply path takes no money, so the ledger must record 0p.
// Before the fix, applyPurchase overwrote the caller's `amountPence: 0` with
// the frozen quote amount, booking revenue that was never collected.

test('auto-apply books ZERO, not the quote amount — no money changed hands', () => {
  const u = makeMember('autoapply@example.com', 90);
  giveSubscription(u, 'standard', '2026-08-01 00:00:00', '2026-09-01 00:00:00');
  payment(u, 799);
  aiRuns(u, 6);
  const now = new Date('2026-08-31T18:00:00Z');

  const q = createQuote(u, 'plus', now);
  assert.equal(q.autoApply, true, 'precondition: this quote is below the card minimum');
  assert.ok(q.amountPence > 0 && q.amountPence < 30, 'precondition: a small non-zero quote');

  const before = db.prepare('SELECT COALESCE(SUM(amount_pence), 0) AS n FROM payments WHERE user_id = ?').get(u).n;
  const applied = applyPurchase(
    { userId: u, tierId: 'plus', kind: q.kind, quoteId: q.quoteId, amountPence: 0, currency: 'gbp', autoApplied: true },
    now
  );
  assert.ok(applied.ok, JSON.stringify(applied));

  const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(applied.paymentId);
  assert.equal(row.amount_pence, 0, 'the ledger must not book money that was never charged');
  assert.equal(row.kind, 'upgrade', 'still an upgrade — a purchase discounted to zero, not a comp');

  const after = db.prepare('SELECT COALESCE(SUM(amount_pence), 0) AS n FROM payments WHERE user_id = ?').get(u).n;
  assert.equal(after, before, 'lifetime paid is unchanged');

  // The row explains itself: the breakdown records why it is zero.
  assert.equal(JSON.parse(row.quote_json).autoApplied, true);
  // The entitlement still applied — the member got what they asked for.
  assert.equal(currentSubscription(u, now).tier.id, 'plus');
});

test('a normal upgrade still honours the frozen quote (guards against over-fixing)', () => {
  const u = makeMember('frozenquote@example.com', 90);
  giveSubscription(u, 'standard', '2026-08-01 00:00:00', '2026-09-01 00:00:00');
  const now = new Date('2026-08-15T00:00:00Z');
  const q = createQuote(u, 'plus', now);
  assert.equal(q.autoApply, false);

  // Stripe reports a different number; the frozen quote must still win.
  const applied = applyPurchase(
    { userId: u, tierId: 'plus', kind: q.kind, quoteId: q.quoteId, amountPence: 99999, stripeSessionId: 'cs_frozen_1' },
    now
  );
  const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(applied.paymentId);
  assert.equal(row.amount_pence, q.amountPence, 'the frozen quote overrides what Stripe reports');
});
