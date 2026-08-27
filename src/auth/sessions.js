import { db } from '../db/connection.js';
import { randomToken, sha256 } from './passwords.js';
import { config } from '../config.js';

export function createSession(userId, req) {
  const token = randomToken();
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)`
  ).run(
    sha256(token),
    userId,
    expires.toISOString(),
    req.ip || '',
    String(req.headers['user-agent'] || '').slice(0, 200)
  );
  return { token, expires };
}

export function sessionUser(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.*, s.id AS session_id FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > datetime('now')
         AND u.status = 'active'`
    )
    .get(sha256(token));
  return row || null;
}

export function revokeSession(token) {
  if (!token) return;
  db.prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE token_hash = ?`).run(sha256(token));
}

export function revokeAllSessions(userId) {
  db.prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`).run(userId);
}

// Revoke every session except the one the user is acting from.
export function revokeOtherSessions(userId, currentToken) {
  db.prepare(
    `UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL AND token_hash != ?`
  ).run(userId, sha256(currentToken || ''));
}

export function setSessionCookie(res, token, expires) {
  res.cookie('kelly_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env === 'production',
    expires,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie('kelly_session', { path: '/' });
}
