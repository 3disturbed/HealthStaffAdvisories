import express from 'express';
import path from 'node:path';
import { config } from './config.js';
import { BUILD_VERSION } from './version.js';
import { seedAdmin } from './db/connection.js';
import { seedJeRuleset } from './je/reference.js';
import { attachUser, csrfGuard } from './auth/middleware.js';
import { authRouter } from './api/auth.js';
import { casesRouter } from './api/cases.js';
import { advisorRouter } from './api/advisor.js';
import { adminRouter } from './api/admin.js';
import { assistantRouter } from './api/assistant.js';
import { documentsRouter } from './api/documents.js';
import { knowledgeRouter } from './api/knowledge.js';
import { notificationsRouter } from './api/notifications.js';
import { accountRouter } from './api/account.js';
import { jeRouter } from './api/je.js';
import { membershipRouter } from './api/membership.js';
import { stripeWebhookHandler } from './api/stripeWebhook.js';
import { seedMembershipTiers } from './db/connection.js';
import { processAiQueue } from './services/aiQueue.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Stripe webhook FIRST: signature verification needs the raw body (before
// express.json) and Stripe cannot send our CSRF header (before csrfGuard).
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

app.use(express.json({ limit: '256kb' }));
app.use(attachUser);

// Security headers.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
  );
  next();
});

// Tiny cookie helper (avoid a dependency for one call site).
app.use((req, res, next) => {
  res.cookie = (name, value, opts = {}) => {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
    if (opts.httpOnly) parts.push('HttpOnly');
    if (opts.secure) parts.push('Secure');
    if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
    parts.push(`Path=${opts.path || '/'}`);
    res.append('Set-Cookie', parts.join('; '));
  };
  res.clearCookie = (name, opts = {}) => {
    res.append('Set-Cookie', `${name}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=${opts.path || '/'}`);
  };
  next();
});

app.use('/api', csrfGuard);
app.use('/api/auth', authRouter);
app.use('/api/cases', casesRouter);
app.use('/api/advisor', advisorRouter);
app.use('/api/admin/assistant', assistantRouter);
app.use('/api/admin', adminRouter);
app.use('/api/knowledge', knowledgeRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/account', accountRouter);
app.use('/api/je', jeRouter);
app.use('/api/membership', membershipRouter);
app.use('/api', documentsRouter);

// Current build fingerprint. Clients poll this and self-heal when the
// version they loaded with no longer matches (see public/version-check.js).
app.get('/api/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ version: BUILD_VERSION });
});

// Entry documents are never cached, so a browser can always discover a new
// build; other assets use no-cache, meaning revalidate-before-reuse (ETag
// keeps that a cheap 304). Without this, heuristic caching can keep serving
// old JS/CSS after a deploy — symptoms like a panel stuck on "Loading…".
app.use(
  express.static(path.join(config.root, 'public'), {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      res.setHeader('X-App-Version', BUILD_VERSION);
      res.setHeader('Cache-Control', filePath.endsWith('.html') ? 'no-store' : 'no-cache');
    },
  })
);

// JSON 404 for unknown API routes; static handler covers the rest.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Never leak stack traces or file contents to users.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large' || err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That upload is too large (15 MB limit).' });
  }
  console.error(`[error] ${req.method} ${req.path}: ${err.message}`);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

const seeded = seedAdmin();
seedJeRuleset();
seedMembershipTiers();

// AI allowance queue worker: drains queued jobs when allowance frees.
// 30s cadence is plenty — the member promise is "around HH:MM".
if (process.env.NODE_ENV !== 'test') {
  processAiQueue().catch(() => {});
  setInterval(() => processAiQueue().catch(() => {}), 30_000);
}

if (process.env.NODE_ENV !== 'test') {
  app.listen(config.port, () => {
    console.log(`Kelly Online running at ${config.baseUrl}`);
    if (seeded?.password) {
      console.log('──────────────────────────────────────────────────────');
      console.log(`Main admin account seeded: ${config.adminEmail}`);
      console.log(`One-time password: ${seeded.password}`);
      console.log('Sign in and change it. This will not be shown again.');
      console.log('──────────────────────────────────────────────────────');
    }
  });
}

export { app };
