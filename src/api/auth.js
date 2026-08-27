import { Router } from 'express';
import { db } from '../db/connection.js';
import { hashPassword, verifyPassword, randomToken, sha256 } from '../auth/passwords.js';
import { createSession, revokeSession, revokeAllSessions, setSessionCookie, clearSessionCookie } from '../auth/sessions.js';
import { requireAuth, rateLimit } from '../auth/middleware.js';
import { rolesForUser, permissionsForUser } from '../rbac/permissions.js';
import { sendEmail } from '../notify/mailer.js';
import { audit } from '../audit/log.js';
import { config } from '../config.js';

export const authRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function issueEmailToken(userId, purpose, ttlHours) {
  const token = randomToken();
  db.prepare(
    `INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', ?))`
  ).run(userId, purpose, sha256(token), `+${ttlHours} hours`);
  return token;
}

function consumeEmailToken(token, purpose) {
  const row = db
    .prepare(
      `SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > datetime('now')`
    )
    .get(sha256(token), purpose);
  if (!row) return null;
  db.prepare(`UPDATE email_tokens SET used_at = datetime('now') WHERE id = ?`).run(row.id);
  return row;
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    isMainAdmin: !!user.is_main_admin,
    roles: rolesForUser(user.id),
    permissions: [...permissionsForUser(user)],
  };
}

authRouter.post('/register', rateLimit({ keyPrefix: 'register', max: 10 }), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const displayName = String(req.body.displayName || '').trim().slice(0, 80);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
  if (!displayName) return res.status(400).json({ error: 'Please tell us what to call you.' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

  const info = db
    .prepare(`INSERT INTO users (email, password_hash, display_name, status) VALUES (?, ?, ?, 'pending')`)
    .run(email, hashPassword(password), displayName);
  const userId = info.lastInsertRowid;
  db.prepare('INSERT INTO user_roles (user_id, role) VALUES (?, ?)').run(userId, 'member');

  const token = issueEmailToken(userId, 'verify', 48);
  sendEmail(
    email,
    'Confirm your Kelly Online account',
    `Hello ${displayName},\n\nConfirm your account by opening this link:\n${config.baseUrl}/verify.html?token=${token}\n\nIf you did not create this account, ignore this email.`
  );
  audit(userId, 'user.registered', 'user', userId);
  res.json({ ok: true, message: 'Account created. Check your email for a confirmation link.' });
});

authRouter.post('/verify', rateLimit({ keyPrefix: 'verify', max: 30 }), (req, res) => {
  const row = consumeEmailToken(String(req.body.token || ''), 'verify');
  if (!row) return res.status(400).json({ error: 'That confirmation link is invalid or has expired.' });
  db.prepare(`UPDATE users SET status = 'active', email_verified_at = datetime('now') WHERE id = ? AND status = 'pending'`).run(row.user_id);
  audit(row.user_id, 'user.email_verified', 'user', row.user_id);
  res.json({ ok: true, message: 'Email confirmed. You can now sign in.' });
});

authRouter.post('/login', rateLimit({ keyPrefix: 'login', max: 20 }), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    audit(null, 'auth.login_failed', 'email', email);
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  if (user.status === 'pending') return res.status(403).json({ error: 'Please confirm your email address first.' });
  if (user.status !== 'active') return res.status(403).json({ error: 'This account is disabled.' });

  const { token, expires } = createSession(user.id, req);
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(user.id);
  setSessionCookie(res, token, expires);
  audit(user.id, 'auth.login', 'user', user.id);
  res.json({ ok: true, user: publicUser(user) });
});

authRouter.post('/logout', (req, res) => {
  if (req.user) audit(req.user.id, 'auth.logout', 'user', req.user.id);
  revokeSession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

authRouter.post('/request-reset', rateLimit({ keyPrefix: 'reset', max: 10 }), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND status != ?').get(email, 'disabled');
  if (user) {
    const token = issueEmailToken(user.id, 'reset', 2);
    sendEmail(
      email,
      'Reset your Kelly Online access',
      `Reset your password by opening this link (valid for 2 hours):\n${config.baseUrl}/reset.html?token=${token}\n\nIf you did not request this, ignore this email.`
    );
    audit(user.id, 'auth.reset_requested', 'user', user.id);
  }
  // Same response either way — do not reveal whether an account exists.
  res.json({ ok: true, message: 'If that account exists, a reset link has been sent.' });
});

authRouter.post('/reset', rateLimit({ keyPrefix: 'reset2', max: 10 }), (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
  const row = consumeEmailToken(String(req.body.token || ''), 'reset');
  if (!row) return res.status(400).json({ error: 'That reset link is invalid or has expired.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), row.user_id);
  revokeAllSessions(row.user_id);
  audit(row.user_id, 'auth.password_reset', 'user', row.user_id);
  res.json({ ok: true, message: 'Password updated. Please sign in.' });
});
