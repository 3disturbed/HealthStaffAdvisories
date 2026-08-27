import { Router } from 'express';
import { db, getSetting, setSetting } from '../db/connection.js';
import { requirePermission } from '../auth/middleware.js';
import { PERMISSIONS, ROLES, ROLE_DEFAULTS, rolesForUser, overridesForUser, permissionsForUser } from '../rbac/permissions.js';
import { revokeAllSessions } from '../auth/sessions.js';
import { audit } from '../audit/log.js';
import { aiConfigured } from '../ai/intake.js';
import { config } from '../config.js';

export const adminRouter = Router();

function targetUserOr404(req, res) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!user) {
    res.status(404).json({ error: 'User not found.' });
    return null;
  }
  return user;
}

// The main administration account is protected: nobody (including itself)
// can demote, disable or strip it. Only the main admin may grant/remove the
// admin role on other accounts.
function guardTarget(req, res, target) {
  if (target.is_main_admin) {
    res.status(403).json({ error: 'The main administration account cannot be modified.' });
    return false;
  }
  return true;
}

adminRouter.get('/users', requirePermission('users.manage'), (req, res) => {
  const users = db
    .prepare(`SELECT id, email, display_name, status, is_main_admin, email_verified_at, created_at, last_login_at FROM users ORDER BY created_at`)
    .all();
  res.json({
    roles: ROLES,
    roleDefaults: ROLE_DEFAULTS,
    permissionCatalog: PERMISSIONS,
    users: users.map((u) => ({
      id: u.id, email: u.email, displayName: u.display_name, status: u.status,
      isMainAdmin: !!u.is_main_admin, emailVerified: !!u.email_verified_at,
      createdAt: u.created_at, lastLoginAt: u.last_login_at,
      roles: rolesForUser(u.id),
      overrides: overridesForUser(u.id),
      effectivePermissions: [...permissionsForUser(u)],
    })),
  });
});

adminRouter.post('/users/:id/roles', requirePermission('users.manage'), (req, res) => {
  const target = targetUserOr404(req, res);
  if (!target || !guardTarget(req, res, target)) return;
  const { role, action } = req.body;
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role.' });
  if (!['add', 'remove'].includes(action)) return res.status(400).json({ error: 'Action must be add or remove.' });
  if (role === 'admin' && !req.user.is_main_admin) {
    return res.status(403).json({ error: 'Only the main administration account can grant or remove the admin role.' });
  }
  if (action === 'add') {
    db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role, granted_by) VALUES (?, ?, ?)').run(target.id, role, req.user.id);
  } else {
    db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role = ?').run(target.id, role);
  }
  audit(req.user.id, `role.${action}`, 'user', target.id, { role });
  res.json({ ok: true, roles: rolesForUser(target.id) });
});

adminRouter.post('/users/:id/permissions', requirePermission('users.manage'), (req, res) => {
  const target = targetUserOr404(req, res);
  if (!target || !guardTarget(req, res, target)) return;
  const { permission, mode } = req.body;
  if (!(permission in PERMISSIONS)) return res.status(400).json({ error: 'Unknown permission.' });
  if (!['grant', 'revoke', 'clear'].includes(mode)) return res.status(400).json({ error: 'Mode must be grant, revoke or clear.' });
  if ((permission === 'users.manage' || permission === 'system.admin') && !req.user.is_main_admin) {
    return res.status(403).json({ error: 'Only the main administration account can change administrative permissions.' });
  }
  if (mode === 'clear') {
    db.prepare('DELETE FROM user_permissions WHERE user_id = ? AND permission = ?').run(target.id, permission);
  } else {
    db.prepare(
      `INSERT INTO user_permissions (user_id, permission, mode, granted_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, permission) DO UPDATE SET mode = excluded.mode, granted_by = excluded.granted_by, created_at = datetime('now')`
    ).run(target.id, permission, mode, req.user.id);
  }
  audit(req.user.id, `permission.${mode}`, 'user', target.id, { permission });
  res.json({ ok: true, overrides: overridesForUser(target.id), effectivePermissions: [...permissionsForUser(target)] });
});

adminRouter.post('/users/:id/status', requirePermission('users.manage'), (req, res) => {
  const target = targetUserOr404(req, res);
  if (!target || !guardTarget(req, res, target)) return;
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot disable your own account.' });
  const status = req.body.status;
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Status must be active or disabled.' });
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, target.id);
  if (status === 'disabled') revokeAllSessions(target.id);
  audit(req.user.id, `user.${status}`, 'user', target.id);
  res.json({ ok: true, status });
});

adminRouter.get('/audit', requirePermission('audit.view'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.*, u.email AS actor_email FROM audit_events a
       LEFT JOIN users u ON u.id = a.actor_user_id
       ORDER BY a.id DESC LIMIT 200`
    )
    .all();
  res.json({ events: rows });
});

adminRouter.get('/mailbox', requirePermission('system.admin'), (req, res) => {
  const rows = db.prepare('SELECT * FROM outbound_emails ORDER BY id DESC LIMIT 50').all();
  res.json({ emails: rows });
});

adminRouter.get('/settings', requirePermission('system.admin'), (req, res) => {
  const key = getSetting('openai_api_key', '');
  res.json({
    aiConfigured: aiConfigured(),
    aiDisabled: getSetting('ai_disabled', '0') === '1',
    aiModel: getSetting('ai_model', config.defaultAiModel),
    // Never return the stored key — only enough to recognise it.
    openaiKeyMasked: key ? `sk-…${key.slice(-4)}` : null,
  });
});

adminRouter.post('/settings', requirePermission('system.admin'), (req, res) => {
  const changed = [];
  if (typeof req.body.openaiApiKey === 'string' && req.body.openaiApiKey.trim()) {
    const key = req.body.openaiApiKey.trim();
    if (key.length < 20) return res.status(400).json({ error: 'That does not look like a valid API key.' });
    setSetting('openai_api_key', key);
    changed.push('openai_api_key');
  }
  if (req.body.clearOpenaiApiKey === true) {
    db.prepare('DELETE FROM settings WHERE key = ?').run('openai_api_key');
    changed.push('openai_api_key_cleared');
  }
  if (typeof req.body.aiModel === 'string' && req.body.aiModel.trim()) {
    setSetting('ai_model', req.body.aiModel.trim().slice(0, 60));
    changed.push('ai_model');
  }
  if (typeof req.body.aiDisabled === 'boolean') {
    // G6 incident kill switch: disables AI generation, case portal stays up.
    setSetting('ai_disabled', req.body.aiDisabled ? '1' : '0');
    changed.push('ai_disabled');
  }
  if (changed.length === 0) return res.status(400).json({ error: 'Nothing to change.' });
  audit(req.user.id, 'settings.updated', 'settings', '', { changed }); // names only, never values
  res.json({ ok: true, changed });
});
