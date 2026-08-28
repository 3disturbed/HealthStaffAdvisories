import { Router } from 'express';
import Stripe from 'stripe';
import { db, getSetting } from '../db/connection.js';
import { requireAuth, rateLimit } from '../auth/middleware.js';
import { config } from '../config.js';
import {
  listTiers, getTier, currentSubscription, costToValue, upgradeQuote, createQuote, applyPurchase, PAY_BANDS,
} from '../services/membership.js';
import { aiAllowanceState } from '../services/aiQueue.js';

export const membershipRouter = Router();

export function stripeEnabled() {
  return !!getSetting('stripe_secret_key');
}

// Public: powers the landing-page pricing cards.
membershipRouter.get('/tiers', (req, res) => {
  res.json({ tiers: listTiers().map(({ id, name, pricePence, aiDailyAllowance }) => ({ id, name, pricePence, aiDailyAllowance })) });
});

membershipRouter.get('/', requireAuth, (req, res) => {
  const state = currentSubscription(req.user.id);
  const cv = costToValue(req.user.id);
  res.json({
    tier: state.tier,
    subscription: state.subscription,
    implicitPilot: state.implicitPilot,
    payBand: req.user.pay_band || '',
    payBands: PAY_BANDS,
    allowance: aiAllowanceState(req.user.id),
    tiers: listTiers(),
    costToValue: cv.error ? null : { cv: Math.round(cv.cv * 100) / 100, paidPence: cv.paidPence, tenureDays: cv.tenureDays },
    stripeEnabled: stripeEnabled(),
  });
});

// Side-effect-free preview for the Account page quote lines.
membershipRouter.get('/quote/:tier', requireAuth, (req, res) => {
  const quote = upgradeQuote(req.user.id, req.params.tier);
  if (quote.error) return res.status(quote.status || 400).json({ error: quote.error });
  res.json(quote);
});

membershipRouter.post('/checkout', requireAuth, rateLimit({ keyPrefix: 'checkout', max: 10 }), async (req, res, next) => {
  try {
    const tier = getTier(String(req.body.tier || ''));
    if (!tier || !tier.active) return res.status(400).json({ error: 'That membership is not available.' });

    const quote = createQuote(req.user.id, tier.id);
    if (quote.error) return res.status(quote.status || 400).json({ error: quote.error });

    if (quote.autoApply) {
      // Below the card minimum — apply immediately, ledger records 0p.
      const applied = applyPurchase({
        userId: req.user.id, tierId: tier.id, kind: quote.kind, quoteId: quote.quoteId,
        amountPence: 0, currency: tier.currency,
      });
      if (applied.error) return res.status(applied.status || 400).json({ error: applied.error });
      return res.json({ applied: true });
    }

    if (!stripeEnabled()) {
      return res.status(503).json({ error: 'Payments are not switched on yet — an administrator needs to add the Stripe keys.' });
    }

    const stripe = new Stripe(getSetting('stripe_secret_key'));
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: tier.currency,
          unit_amount: quote.amountPence,
          product_data: { name: `Kelly Online ${tier.name} membership` },
        },
      }],
      metadata: {
        userId: String(req.user.id), tierId: tier.id, kind: quote.kind, quoteId: String(quote.quoteId),
      },
      payment_intent_data: { metadata: { userId: String(req.user.id), quoteId: String(quote.quoteId) } },
      customer_email: req.user.email,
      success_url: `${config.baseUrl}/account.html?checkout=success`,
      cancel_url: `${config.baseUrl}/account.html?checkout=cancelled`,
    });
    db.prepare('UPDATE membership_quotes SET stripe_session_id = ? WHERE id = ?').run(session.id, quote.quoteId);
    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});
