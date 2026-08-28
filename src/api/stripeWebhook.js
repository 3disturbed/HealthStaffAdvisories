import Stripe from 'stripe';
import { db, getSetting } from '../db/connection.js';
import { audit } from '../audit/log.js';
import { applyPurchase, recordRefund, findPaymentByIntent } from '../services/membership.js';

// Mounted in server.js BEFORE express.json (signature verification needs
// the raw Buffer) and outside the csrfGuard (Stripe cannot send our header).

function onCheckoutCompleted(event) {
  const s = event.data.object;
  if (s.payment_status !== 'paid') return;
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

// `charge.amount_refunded` is CUMULATIVE and Stripe re-fires this event on
// every subsequent partial refund, so booking that field double-counts. Book
// one row per refund id instead, and let recordRefund dedupe.
function onChargeRefunded(event) {
  const charge = event.data.object;
  const parent = findPaymentByIntent(charge.payment_intent);
  if (!parent) {
    audit(null, 'payment.refund_unmatched', 'charge', charge.id || '', {
      paymentIntent: charge.payment_intent || null,
      amountRefunded: charge.amount_refunded ?? null,
    });
    return;
  }
  const refunds = charge.refunds?.data;
  if (!Array.isArray(refunds)) {
    // Malformed or unexpanded payload. Throwing means a 500 and a Stripe
    // retry — far better than silently booking nothing against real money.
    throw new Error(`charge.refunded for ${charge.id} carried no usable refunds list`);
  }
  for (const r of refunds) {
    recordRefund({ parentPaymentId: parent.id, refundGrossPence: r.amount, stripeRefundId: r.id });
  }
}

// The money has NOT left yet and may come back, so no ledger row here.
function onDisputeCreated(event) {
  const dispute = event.data.object;
  const parent = findPaymentByIntent(dispute.payment_intent);
  audit(null, 'payment.disputed', 'payment', parent?.id ?? '', {
    disputeId: dispute.id || null, amountPence: dispute.amount ?? null, matched: !!parent,
  });
}

// A lost dispute is money gone: book it like a refund.
function onDisputeClosed(event) {
  const dispute = event.data.object;
  if (dispute.status !== 'lost') {
    audit(null, 'payment.dispute_closed', 'charge', dispute.charge || '', { status: dispute.status || null });
    return;
  }
  const parent = findPaymentByIntent(dispute.payment_intent);
  if (!parent) {
    audit(null, 'payment.refund_unmatched', 'charge', dispute.charge || '', { disputeId: dispute.id || null });
    return;
  }
  recordRefund({ parentPaymentId: parent.id, refundGrossPence: dispute.amount, stripeRefundId: `dp_${dispute.id}` });
}

// Never write a ledger row for money that did not arrive.
function onPaymentFailed(event) {
  const pi = event.data.object;
  audit(null, 'payment.failed', 'user', pi.metadata?.userId || '', {
    paymentIntent: pi.id || null, code: pi.last_payment_error?.code || null,
  });
}

function onCheckoutExpired(event) {
  const s = event.data.object;
  const quoteId = Number(s.metadata?.quoteId) || null;
  const result = quoteId
    ? db.prepare(`UPDATE membership_quotes SET status = 'expired' WHERE id = ? AND status = 'pending'`).run(quoteId)
    : db.prepare(`UPDATE membership_quotes SET status = 'expired' WHERE stripe_session_id = ? AND status = 'pending'`).run(s.id);
  if (result.changes) audit(null, 'payment.quote_expired', 'membership_quote', quoteId || s.id, {});
}

const HANDLERS = {
  'checkout.session.completed': onCheckoutCompleted,
  'checkout.session.expired': onCheckoutExpired,
  'charge.refunded': onChargeRefunded,
  'charge.dispute.created': onDisputeCreated,
  'charge.dispute.closed': onDisputeClosed,
  'payment_intent.payment_failed': onPaymentFailed,
};

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

  const handler = HANDLERS[event.type];
  // An event we do not handle is acknowledged, or Stripe retries it forever.
  if (!handler) return res.json({ received: true, handled: false });

  try {
    handler(event);
  } catch (err) {
    // One of OUR handlers failed on an event we claim to handle. 200 here
    // would lose the event permanently, so let Stripe retry.
    console.error(`[stripe] ${event.type} ${event.id}: ${err.message}`);
    return res.status(500).json({ error: 'Could not process that event.' });
  }
  return res.json({ received: true, handled: true });
}
