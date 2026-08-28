import { Router } from 'express';
import { db } from '../db/connection.js';
import { requireAuth, rateLimit } from '../auth/middleware.js';
import { hashPassword, verifyPassword, sha256 } from '../auth/passwords.js';
import { revokeOtherSessions } from '../auth/sessions.js';
import { audit } from '../audit/log.js';
import { PAY_BANDS } from '../services/membership.js';

export const accountRouter = Router();

accountRouter.get('/', requireAuth, (req, res) => {
  res.json({
    email: req.user.email,
    displayName: req.user.display_name,
    emailNotifications: !!req.user.email_notifications,
    payBand: req.user.pay_band || '',
  });
});

accountRouter.post('/password', requireAuth, rateLimit({ keyPrefix: 'pwchange', max: 10 }), (req, res) => {
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  if (!verifyPassword(current, req.user.password_hash)) {
    return res.status(400).json({ error: 'Your current password is incorrect.' });
  }
  if (next.length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
  // Keep the session in use; sign out everywhere else.
  revokeOtherSessions(req.user.id, req.sessionToken);
  audit(req.user.id, 'auth.password_changed', 'user', req.user.id);
  res.json({ ok: true, message: 'Password updated. Other devices have been signed out.' });
});

accountRouter.post('/profile', requireAuth, (req, res) => {
  const displayName = String(req.body.displayName || '').trim().slice(0, 80);
  if (!displayName) return res.status(400).json({ error: 'Display name cannot be empty.' });
  const fields = ['displayName'];
  if (req.body.payBand !== undefined) {
    const payBand = String(req.body.payBand || '');
    if (!(payBand in PAY_BANDS)) return res.status(400).json({ error: 'Please choose a valid NHS pay band.' });
    db.prepare('UPDATE users SET pay_band = ? WHERE id = ?').run(payBand, req.user.id);
    fields.push('payBand');
  }
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, req.user.id);
  audit(req.user.id, 'account.profile_updated', 'user', req.user.id, { fields });
  res.json({ ok: true, displayName });
});

accountRouter.get('/sessions', requireAuth, (req, res) => {
  const currentHash = sha256(req.sessionToken || '');
  const rows = db
    .prepare(
      `SELECT id, token_hash, created_at, ip, user_agent FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
       ORDER BY created_at DESC`
    )
    .all(req.user.id);
  res.json({
    sessions: rows.map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      ip: s.ip,
      userAgent: s.user_agent,
      current: s.token_hash === currentHash,
    })),
  });
});

accountRouter.post('/sessions/revoke-others', requireAuth, (req, res) => {
  revokeOtherSessions(req.user.id, req.sessionToken);
  audit(req.user.id, 'account.sessions_revoked', 'user', req.user.id);
  res.json({ ok: true, message: 'All other devices have been signed out.' });
});

accountRouter.post('/email-notifications', requireAuth, (req, res) => {
  const enabled = req.body.enabled === true;
  db.prepare('UPDATE users SET email_notifications = ? WHERE id = ?').run(enabled ? 1 : 0, req.user.id);
  audit(req.user.id, 'account.email_pref', 'user', req.user.id, { enabled });
  res.json({ ok: true, emailNotifications: enabled });
});
