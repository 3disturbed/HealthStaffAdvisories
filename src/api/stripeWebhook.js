import Stripe from 'stripe';
import { getSetting } from '../db/connection.js';
import { applyPurchase } from '../services/membership.js';

// Mounted in server.js BEFORE express.json (signature verification needs
// the raw Buffer) and outside the csrfGuard (Stripe cannot send our header).
export function stripeWebhookHandler(req, res) {
  const secretKey = getSetting('stripe_secret_key');
  const webhookSecret = getSetting('stripe_webhook_secret');
  if (!secretKey || !webhookSecret) return res.status(503).json({ error: 'Payments not configured.' });

  let event;
  try {
    event = new Stripe(secretKey).webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
  } catch {
    return res.status(400).json({ error: 'Invalid signature.' });
  }

  if (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') {
    const s = event.data.object;
    // Idempotent: Stripe retries and refreshes cannot double-fulfil.
    applyPurchase({
      userId: Number(s.metadata?.userId),
      tierId: String(s.metadata?.tierId || ''),
      kind: String(s.metadata?.kind || 'purchase'),
      quoteId: Number(s.metadata?.quoteId) || null,
      stripeSessionId: s.id,
      paymentIntentId: String(s.payment_intent || ''),
      amountPence: s.amount_total,
      currency: s.currency,
    });
  }
  // Always 2xx once the signature verified, or Stripe keeps retrying.
  res.json({ received: true });
}
