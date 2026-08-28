import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Stripe from 'stripe';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-webhook-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tmp;
process.env.ADMIN_INITIAL_PASSWORD = 'admin-test-password-1';

const { app } = await import('../src/server.js');
const { db, setSetting } = await import('../src/db/connection.js');
const { hashPassword } = await import('../src/auth/passwords.js');

const SECRET_KEY = 'sk_test_webhooktestkey000000';
const WEBHOOK_SECRET = 'whsec_webhooktestsecret00000';

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  setSetting('stripe_secret_key', SECRET_KEY);
  setSetting('stripe_webhook_secret', WEBHOOK_SECRET);
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Stripe's own helper produces a real signature, so these tests exercise the
// verification path rather than bypassing it.
function send(event) {
  const payload = JSON.stringify(event);
  const signature = new Stripe(SECRET_KEY).webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return fetch(`${base}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
}

function makeMember(email) {
  const id = db
    .prepare(`INSERT INTO users (email, password_hash, display_name, status, email_verified_at)
              VALUES (?, ?, ?, 'active', datetime('now'))`)
    .run(email, hashPassword('longpassword-1'), email.split('@')[0]).lastInsertRowid;
  db.prepare(`INSERT INTO user_roles (user_id, role) VALUES (?, 'member')`).run(id);
  return id;
}

function makePayment(userId, amountPence, paymentIntent) {
  return db
    .prepare(`INSERT INTO payments (user_id, amount_pence, kind, tier_id, period_start, period_end,
              stripe_session_id, stripe_payment_intent)
              VALUES (?, ?, 'purchase', 'standard', datetime('now'), datetime('now', '+1 month'), ?, ?)`)
    .run(userId, amountPence, `cs_${paymentIntent}`, paymentIntent).lastInsertRowid;
}

const net = (userId) =>
  db.prepare('SELECT COALESCE(SUM(amount_pence), 0) AS n FROM payments WHERE user_id = ?').get(userId).n;

const chargeEvent = (paymentIntent, refunds, amountRefunded) => ({
  id: `evt_${refunds.map((r) => r.id).join('_')}`,
  type: 'charge.refunded',
  data: {
    object: {
      id: `ch_${paymentIntent}`,
      payment_intent: paymentIntent,
      amount_refunded: amountRefunded,
      currency: 'gbp',
      refunds: { object: 'list', data: refunds },
    },
  },
});

test('a refund books a negative row and the ledger nets correctly', async () => {
  const u = makeMember('refund@example.com');
  makePayment(u, 799, 'pi_refund_1');
  assert.equal(net(u), 799);

  const res = await send(chargeEvent('pi_refund_1', [{ id: 're_1', amount: 799, currency: 'gbp' }], 799));
  assert.equal(res.status, 200);

  const rows = db.prepare(`SELECT * FROM payments WHERE user_id = ? AND kind = 'refund'`).all(u);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount_pence, -799, 'refunds are stored negative so SUM() is net paid');
  assert.equal(net(u), 0, 'a full refund nets the member to zero');
});

test('the same refund delivered twice books it once (Stripe retries)', async () => {
  const u = makeMember('retry@example.com');
  makePayment(u, 500, 'pi_retry_1');
  const event = chargeEvent('pi_retry_1', [{ id: 're_retry_1', amount: 500, currency: 'gbp' }], 500);

  assert.equal((await send(event)).status, 200);
  assert.equal((await send(event)).status, 200);

  const rows = db.prepare(`SELECT * FROM payments WHERE user_id = ? AND kind = 'refund'`).all(u);
  assert.equal(rows.length, 1, 'idempotent per refund id');
  assert.equal(net(u), 0);
});

test('two partial refunds on one charge book two rows, not the cumulative total twice', async () => {
  // charge.amount_refunded is CUMULATIVE and Stripe re-fires the event on each
  // partial refund. Booking that field would double-count: 300 then 300+200=500
  // would record 800 against a 799 charge.
  const u = makeMember('partial@example.com');
  makePayment(u, 799, 'pi_partial_1');

  const first = [{ id: 're_partial_a', amount: 300, currency: 'gbp' }];
  assert.equal((await send(chargeEvent('pi_partial_1', first, 300))).status, 200);
  assert.equal(net(u), 499);

  const second = [...first, { id: 're_partial_b', amount: 200, currency: 'gbp' }];
  assert.equal((await send(chargeEvent('pi_partial_1', second, 500))).status, 200);

  const rows = db.prepare(`SELECT amount_pence FROM payments WHERE user_id = ? AND kind = 'refund' ORDER BY id`).all(u);
  assert.deepEqual(rows.map((r) => r.amount_pence), [-300, -200], 'one row per refund, at its own amount');
  assert.equal(net(u), 299, '799 charged less 500 refunded');
});

test('a refund with no matching payment is recorded against nothing rather than crashing', async () => {
  const res = await send(chargeEvent('pi_orphan_1', [{ id: 're_orphan', amount: 100, currency: 'gbp' }], 100));
  assert.equal(res.status, 200, 'an unmatched refund must not make Stripe retry forever');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE stripe_session_id = 're_orphan'`).get().n, 0);
  const logged = db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'payment.refund_unmatched'`).get().n;
  assert.equal(logged, 1, 'but it must be visible in the audit log');
});

test('an expired checkout session marks the quote expired', async () => {
  const u = makeMember('expired@example.com');
  const quoteId = db
    .prepare(`INSERT INTO membership_quotes (user_id, kind, tier_id, amount_pence, period_start, period_end, stripe_session_id, expires_at)
              VALUES (?, 'purchase', 'standard', 799, datetime('now'), datetime('now', '+1 month'), 'cs_expired_1', datetime('now', '+1 hour'))`)
    .run(u).lastInsertRowid;

  const res = await send({
    id: 'evt_expired_1',
    type: 'checkout.session.expired',
    data: { object: { id: 'cs_expired_1', metadata: { quoteId: String(quoteId) } } },
  });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT status FROM membership_quotes WHERE id = ?').get(quoteId).status, 'expired');
});

test('a failed payment never writes a ledger row', async () => {
  const u = makeMember('failed@example.com');
  const before = db.prepare('SELECT COUNT(*) AS n FROM payments').get().n;

  const res = await send({
    id: 'evt_failed_1',
    type: 'payment_intent.payment_failed',
    data: { object: { id: 'pi_failed_1', metadata: { userId: String(u) }, last_payment_error: { code: 'card_declined' } } },
  });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, before, 'money that never arrived is never booked');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'payment.failed'`).get().n, 1);
});

test('an event type we do not handle is acknowledged, not retried', async () => {
  const res = await send({ id: 'evt_ignored_1', type: 'customer.created', data: { object: { id: 'cus_1' } } });
  assert.equal(res.status, 200);
});

test('a bad signature is rejected before anything is read', async () => {
  const res = await fetch(`${base}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
    body: JSON.stringify({ id: 'evt_bad', type: 'charge.refunded', data: { object: {} } }),
  });
  assert.equal(res.status, 400);
});

test('a handler that throws returns 500 so Stripe retries rather than losing the event', async () => {
  // A known payment whose event carries an unusable refunds list. The money is
  // real, so booking nothing and replying 200 would lose the refund forever.
  const u = makeMember('boom@example.com');
  makePayment(u, 799, 'pi_boom');
  const res = await send({
    id: 'evt_boom_1',
    type: 'charge.refunded',
    data: { object: { id: 'ch_boom', payment_intent: 'pi_boom', refunds: 'not-a-list' } },
  });
  assert.equal(res.status, 500, 'silently 200-ing a failed handler loses the event forever');
  assert.equal(net(u), 799, 'and nothing partial was written');
});
