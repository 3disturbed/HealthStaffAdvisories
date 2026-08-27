import express from 'express';
import path from 'node:path';
import { config } from './config.js';
import { seedAdmin } from './db/connection.js';
import { attachUser, csrfGuard } from './auth/middleware.js';
import { authRouter } from './api/auth.js';
import { casesRouter } from './api/cases.js';
import { advisorRouter } from './api/advisor.js';
import { adminRouter } from './api/admin.js';
import { documentsRouter } from './api/documents.js';
import { knowledgeRouter } from './api/knowledge.js';
import { notificationsRouter } from './api/notifications.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

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
app.use('/api/admin', adminRouter);
app.use('/api/knowledge', knowledgeRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api', documentsRouter);

app.use(express.static(path.join(config.root, 'public'), { extensions: ['html'] }));

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
