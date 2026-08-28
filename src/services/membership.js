import { db, getSetting } from '../db/connection.js';
import { audit } from '../audit/log.js';
import { notifyUser } from '../notify/mailer.js';

// Membership, billing and the AI-usage allowance. Pure functions over the
// DB in the services contract ({error,status} | {ok,...}); quote math takes
// `now` so tests are deterministic. Money is integer pence throughout.

export const PAY_BANDS = {
  band_2: 'NHS AfC Band 2',
  band_3: 'NHS AfC Band 3',
  band_4: 'NHS AfC Band 4',
  band_5: 'NHS AfC Band 5',
  band_6: 'NHS AfC Band 6',
  band_7: 'NHS AfC Band 7',
  band_8a: 'NHS AfC Band 8a',
  band_8b: 'NHS AfC Band 8b',
  band_8c: 'NHS AfC Band 8c',
  band_8d: 'NHS AfC Band 8d',
  band_9: 'NHS AfC Band 9',
  medical_dental: 'Medical / Dental',
  student_apprentice: 'Student / Apprentice',
  other: 'Other / prefer to self-describe',
};

// SQLite datetime('now') is UTC but bare `new Date('YYYY-MM-DD HH:MM:SS')`
// parses as LOCAL time — every DB timestamp must come through here or
// proration/expectedAt silently shift by the timezone offset.
export function parseDbDate(value) {
  if (!value) return null;
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

export function toDbTs(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function addOneMonth(dbTs) {
  return db.prepare(`SELECT datetime(?, '+1 month') AS e`).get(dbTs).e;
}

const DAY_MS = 86400000;

// ── tiers ────────────────────────────────────────────────────────────────

function tierRow(t) {
  return {
    id: t.id, name: t.name, pricePence: t.price_pence, currency: t.currency,
    aiDailyAllowance: t.ai_daily_allowance, rank: t.rank, active: !!t.active,
  };
}

export function listTiers({ includeInactive = false } = {}) {
  const rows = db
    .prepare(`SELECT * FROM membership_tiers ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY rank`)
    .all();
  return rows.map(tierRow);
}

export function getTier(id) {
  const row = db.prepare('SELECT * FROM membership_tiers WHERE id = ?').get(String(id));
  return row ? tierRow(row) : null;
}

export function updateTier(actor, tierId, changes) {
  const tier = db.prepare('SELECT * FROM membership_tiers WHERE id = ?').get(String(tierId));
  if (!tier) return { error: 'Tier not found.', status: 404 };
  const sets = {};
  if (typeof changes.name === 'string') {
    const name = changes.name.trim().slice(0, 40);
    if (!name) return { error: 'Tier name cannot be empty.', status: 400 };
    sets.name = name;
  }
  if (changes.pricePence !== undefined) {
    const p = Number(changes.pricePence);
    if (!Number.isInteger(p) || p < 0 || p > 100000) return { error: 'Price must be 0–100000 pence.', status: 400 };
    sets.price_pence = p;
  }
  if (changes.aiDailyAllowance !== undefined) {
    const a = Number(changes.aiDailyAllowance);
    if (!Number.isInteger(a) || a < 0 || a > 100) return { error: 'AI allowance must be 0–100 per day.', status: 400 };
    sets.ai_daily_allowance = a;
  }
  if (typeof changes.active === 'boolean') sets.active = changes.active ? 1 : 0;
  if (Object.keys(sets).length === 0) return { error: 'Nothing to change.', status: 400 };

  const cols = Object.keys(sets).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE membership_tiers SET ${cols}, updated_at = datetime('now') WHERE id = ?`)
    .run(...Object.values(sets), tier.id);
  audit(actor.id, 'tier.updated', 'membership_tier', tier.id, sets); // prices are not secrets
  return { ok: true, tier: getTier(tier.id) };
}

// ── subscription state ───────────────────────────────────────────────────

export function currentSubscription(userId, now = new Date()) {
  const ts = toDbTs(now);
  // Lazily expire finished periods — no cron required.
  db.prepare(`UPDATE subscriptions SET status = 'expired', updated_at = datetime('now')
              WHERE user_id = ? AND status = 'active' AND period_end <= ?`).run(userId, ts);
  const row = db
    .prepare(`SELECT s.*, t.id AS t_id, t.name, t.price_pence, t.currency, t.ai_daily_allowance, t.rank, t.active
              FROM subscriptions s JOIN membership_tiers t ON t.id = s.tier_id
              WHERE s.user_id = ? AND s.status = 'active' AND s.period_end > ? ORDER BY s.id DESC LIMIT 1`)
    .get(userId, ts);
  if (row) {
    return {
      ok: true,
      implicitPilot: false,
      tier: tierRow({ ...row, id: row.t_id }),
      subscription: { periodStart: row.period_start, periodEnd: row.period_end, status: row.status },
    };
  }
  // Pilot is the permanent free floor — nobody is ever tier-less.
  const pilot = getTier('pilot');
  return { ok: true, implicitPilot: true, tier: pilot, subscription: null };
}

// ── Cost-to-Value ────────────────────────────────────────────────────────

function weight(key, fallback) {
  const n = Number(getSetting(key, fallback));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function costToValue(userId, now = new Date()) {
  const user = db.prepare('SELECT created_at, pay_band FROM users WHERE id = ?').get(userId);
  if (!user) return { error: 'User not found.', status: 404 };
  const paidPence = db
    .prepare(`SELECT COALESCE(SUM(amount_pence), 0) AS n FROM payments WHERE user_id = ? AND kind IN ('purchase','upgrade','refund')`)
    .get(userId).n;
  const weights = {
    ai: weight('cv_weight_ai', 40),
    reply: weight('cv_weight_reply', 300),
    doc: weight('cv_weight_doc', 20),
    case: weight('cv_weight_case', 500),
  };
  const counts = {
    ai: db.prepare('SELECT COUNT(*) AS n FROM ai_outputs WHERE billed_user_id = ?').get(userId).n,
    reply: db.prepare(`SELECT COUNT(*) AS n FROM case_messages m JOIN cases c ON c.id = m.case_id
                       WHERE c.member_id = ? AND m.visibility = 'member' AND m.approved_by IS NOT NULL`).get(userId).n,
    doc: db.prepare('SELECT COUNT(*) AS n FROM documents WHERE owner_user_id = ?').get(userId).n,
    case: db.prepare(`SELECT COUNT(*) AS n FROM cases WHERE member_id = ? AND status != 'closed'`).get(userId).n,
  };
  const estCostPence = weights.ai * counts.ai + weights.reply * counts.reply + weights.doc * counts.doc + weights.case * counts.case;
  const tenureDays = Math.max(0, Math.floor((now - parseDbDate(user.created_at)) / DAY_MS));
  // Floor the denominator at £1 — no division by zero, no runaway CV.
  const cv = paidPence / Math.max(estCostPence, 100);
  return { ok: true, cv, paidPence, estCostPence, tenureDays, payBand: user.pay_band || '', weights, counts };
}

// Bounded 0–30 %, monotonic non-decreasing in CV and tenure.
export function loyaltyDiscountPct(cv, tenureDays) {
  const cvPart = 15 * Math.min(Math.max(cv, 0), 2) / 2;          // saturates at CV = 2
  const tenurePart = 15 * Math.min(Math.max(tenureDays, 0), 730) / 730; // saturates at 2 years
  return Math.round(Math.min(30, cvPart + tenurePart) * 100) / 100;
}

// ── quotes ───────────────────────────────────────────────────────────────

const STRIPE_MIN_PENCE = 30; // Stripe GBP charge minimum

export function upgradeQuote(userId, targetTierId, now = new Date()) {
  const target = getTier(targetTierId);
  if (!target || !target.active) return { error: 'That membership is not available.', status: 400 };

  const state = currentSubscription(userId, now);
  const cvData = costToValue(userId, now);
  if (cvData.error) return cvData;
  const discountPct = loyaltyDiscountPct(cvData.cv, cvData.tenureDays);

  if (!state.implicitPilot && state.tier.id === target.id) {
    return { error: 'You already have this tier.', status: 400 };
  }
  if (!state.implicitPilot && target.rank < state.tier.rank) {
    return { error: 'Downgrades take effect at renewal — contact us.', status: 400 };
  }
  if (state.implicitPilot && target.id === 'pilot') {
    return { error: 'You already have this tier.', status: 400 };
  }

  if (state.implicitPilot || !state.subscription) {
    // Fresh purchase: full month from now, loyalty discount still applies.
    const periodStart = toDbTs(now);
    const periodEnd = addOneMonth(periodStart);
    const amountPence = Math.max(0, Math.round(target.pricePence * (1 - discountPct / 100)));
    return {
      ok: true, kind: 'purchase', amountPence, autoApply: amountPence < STRIPE_MIN_PENCE,
      breakdown: {
        targetProRataPence: target.pricePence, currentCreditPence: 0, basePence: target.pricePence,
        discountPct, cv: cvData.cv, tenureDays: cvData.tenureDays,
        daysLeft: null, daysTotal: null, periodStart, periodEnd,
      },
    };
  }

  const S = parseDbDate(state.subscription.periodStart);
  const E = parseDbDate(state.subscription.periodEnd);
  const daysTotal = Math.max(1, Math.ceil((E - S) / DAY_MS));
  const daysLeft = Math.min(daysTotal, Math.max(1, Math.ceil((E - now) / DAY_MS)));
  const targetProRataPence = Math.round(target.pricePence * daysLeft / daysTotal);
  const currentCreditPence = Math.round(state.tier.pricePence * daysLeft / daysTotal);
  const basePence = Math.max(0, targetProRataPence - currentCreditPence);
  const amountPence = Math.max(0, Math.round(basePence * (1 - discountPct / 100)));
  return {
    ok: true, kind: 'upgrade', amountPence, autoApply: amountPence < STRIPE_MIN_PENCE,
    breakdown: {
      targetProRataPence, currentCreditPence, basePence, discountPct,
      cv: cvData.cv, tenureDays: cvData.tenureDays, daysLeft, daysTotal,
      periodStart: toDbTs(now), periodEnd: state.subscription.periodEnd, // renewal date unchanged
    },
  };
}

export function createQuote(userId, targetTierId, now = new Date()) {
  const quote = upgradeQuote(userId, targetTierId, now);
  if (quote.error) return quote;
  const info = db
    .prepare(`INSERT INTO membership_quotes (user_id, kind, tier_id, amount_pence, period_start, period_end, breakdown_json, expires_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, datetime(?, '+1 hour'))`)
    .run(userId, quote.kind, targetTierId, quote.amountPence,
      quote.breakdown.periodStart, quote.breakdown.periodEnd,
      JSON.stringify(quote.breakdown), toDbTs(now));
  return { ok: true, quoteId: info.lastInsertRowid, ...quote };
}

// ── fulfilment (idempotent — the webhook and tests both call this) ───────

export function applyPurchase({ userId, tierId, kind, quoteId, stripeSessionId = null, paymentIntentId = '', amountPence, currency = 'gbp' }, now = new Date()) {
  if (stripeSessionId) {
    const existing = db.prepare('SELECT id FROM payments WHERE stripe_session_id = ?').get(stripeSessionId);
    if (existing) return { ok: true, already: true, paymentId: existing.id };
  }

  let quote = quoteId
    ? db.prepare(`SELECT * FROM membership_quotes WHERE id = ? AND user_id = ? AND status = 'pending'`).get(Number(quoteId), userId)
    : null;
  let periodStart;
  let periodEnd;
  let finalKind = kind;
  let finalTier = tierId;
  let finalAmount = amountPence;
  if (quote) {
    ({ period_start: periodStart, period_end: periodEnd, kind: finalKind, tier_id: finalTier } = quote);
    finalAmount = quote.amount_pence;
    db.prepare(`UPDATE membership_quotes SET status = 'paid' WHERE id = ?`).run(quote.id);
  } else {
    // Money was taken but the quote is missing/expired — fulfil from
    // metadata with a full period rather than losing the payment.
    periodStart = toDbTs(now);
    periodEnd = addOneMonth(periodStart);
    audit(null, 'payment.fulfilled_without_quote', 'user', userId, { tierId, stripeSessionId });
  }
  const tier = getTier(finalTier);
  if (!tier) return { error: 'Unknown tier at fulfilment.', status: 400 };

  const info = db
    .prepare(`INSERT INTO payments (user_id, amount_pence, currency, kind, tier_id, period_start, period_end,
              stripe_session_id, stripe_payment_intent, quote_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, finalAmount, currency, finalKind, finalTier, periodStart, periodEnd,
      stripeSessionId, paymentIntentId, quote ? quote.breakdown_json : null);

  const active = db
    .prepare(`SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' AND period_end > ? ORDER BY id DESC LIMIT 1`)
    .get(userId, toDbTs(now));
  if (finalKind === 'upgrade' && active) {
    // Tier changes now; the ORIGINAL renewal date is kept.
    db.prepare(`UPDATE subscriptions SET tier_id = ?, updated_at = datetime('now') WHERE id = ?`).run(finalTier, active.id);
  } else {
    if (active) db.prepare(`UPDATE subscriptions SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(active.id);
    db.prepare(`INSERT INTO subscriptions (user_id, tier_id, status, period_start, period_end) VALUES (?, ?, 'active', ?, ?)`)
      .run(userId, finalTier, periodStart, periodEnd);
  }
  audit(userId, 'payment.applied', 'payment', info.lastInsertRowid, { kind: finalKind, tierId: finalTier, amountPence: finalAmount });
  notifyUser(userId, 'membership', `Your ${tier.name} membership is active`, 'Thank you — your membership has been updated.');
  return { ok: true, paymentId: info.lastInsertRowid };
}

export function recordComp(actor, userId, { tierId, months = 1, note = '' }) {
  const tier = getTier(tierId);
  if (!tier) return { error: 'Unknown tier.', status: 400 };
  const m = Math.min(24, Math.max(1, Number(months) || 1));
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(userId));
  if (!user) return { error: 'User not found.', status: 404 };

  const now = new Date();
  const active = db
    .prepare(`SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' AND period_end > ? ORDER BY id DESC LIMIT 1`)
    .get(user.id, toDbTs(now));
  let periodStart;
  let periodEnd;
  if (active && active.tier_id === tier.id) {
    periodStart = active.period_start;
    periodEnd = db.prepare(`SELECT datetime(?, '+${m} months') AS e`).get(active.period_end).e;
    db.prepare(`UPDATE subscriptions SET period_end = ?, updated_at = datetime('now') WHERE id = ?`).run(periodEnd, active.id);
  } else {
    if (active) db.prepare(`UPDATE subscriptions SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(active.id);
    periodStart = toDbTs(now);
    periodEnd = db.prepare(`SELECT datetime(?, '+${m} months') AS e`).get(periodStart).e;
    db.prepare(`INSERT INTO subscriptions (user_id, tier_id, status, period_start, period_end) VALUES (?, ?, 'active', ?, ?)`)
      .run(user.id, tier.id, periodStart, periodEnd);
  }
  db.prepare(`INSERT INTO payments (user_id, amount_pence, kind, tier_id, period_start, period_end, quote_json, recorded_by)
              VALUES (?, 0, 'comp', ?, ?, ?, ?, ?)`)
    .run(user.id, tier.id, periodStart, periodEnd, JSON.stringify({ note: String(note).slice(0, 200), months: m }), actor.id);
  audit(actor.id, 'payment.comp', 'user', user.id, { tierId: tier.id, months: m });
  notifyUser(user.id, 'membership', `${tier.name} membership granted`, 'Your membership has been updated.');
  return { ok: true, periodEnd };
}
