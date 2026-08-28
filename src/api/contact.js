import { Router } from 'express';
import { rateLimit } from '../auth/middleware.js';
import {
  submitContact,
  getThreadByToken,
  replyByToken,
  TOPICS,
  TOPIC_LABELS,
} from '../services/contactMessages.js';

export const contactRouter = Router();

// faq.js flavour: spreads extra keys so a result can carry its own fields.
function respond(res, result) {
  if (result?.error) {
    const { error, status = 400, ...rest } = result;
    return res.status(status).json({ error, ...rest });
  }
  res.json(result);
}

// Every response here is either token-scoped or a one-off submission ack, and
// the app runs behind a proxy — a shared cache must never reuse any of it.
function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
}

// DELIBERATELY unauthenticated — this replaces a public mailto, so it has to
// work for someone with no account (including an ex-member exercising data
// rights). req.user is still read when present, which attaches the thread to
// their Inbox instead of issuing a magic link.
contactRouter.get('/topics', (req, res) => {
  noStore(res);
  res.json({ ok: true, topics: TOPICS.map((id) => ({ id, label: TOPIC_LABELS[id] })) });
});

contactRouter.post(
  '/',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5, keyPrefix: 'contact' }),
  (req, res) => {
    noStore(res);
    // Honeypot: a field no human sees and no real browser fills. Answer
    // exactly as a success would, so a bot learns nothing, and store nothing.
    if (String(req.body?.website || '').trim()) {
      return res.json({ ok: true, urgent: false, signpost: false, signedIn: !!req.user });
    }
    respond(res, submitContact(req.user, req.body || {}));
  }
);

// POST, not GET, for the same two reasons as FAQ search (src/api/faq.js): the
// csrfGuard then requires the x-requested-with header, and the magic-link
// token stays out of URLs and proxy access logs.
contactRouter.post(
  '/thread',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 60, keyPrefix: 'contact-thread' }),
  (req, res) => {
    noStore(res);
    respond(res, getThreadByToken(req.body?.token));
  }
);

contactRouter.post(
  '/thread/reply',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: 'contact-thread-reply' }),
  (req, res) => {
    noStore(res);
    respond(res, replyByToken(req.body?.token, req.body?.body));
  }
);
