import { Router } from 'express';
import { db, getSetting, setSetting } from '../db/connection.js';
import { requirePermission } from '../auth/middleware.js';
import { PERMISSIONS, ROLES, ROLE_DEFAULTS, rolesForUser, overridesForUser, permissionsForUser } from '../rbac/permissions.js';
import { setUserRole, setUserPermission, setUserStatus } from '../services/adminActions.js';
import { audit } from '../audit/log.js';
import { aiConfigured } from '../ai/intake.js';
import { config } from '../config.js';

export const adminRouter = Router();

// Guard logic (main-admin protection, only-main-admin rules) lives in
// src/services/adminActions.js, shared with the assistant's write tools.
function respond(res, result) {
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  return res.json(result);
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
  respond(res, setUserRole(req.user, req.params.id, { role: req.body.role, action: req.body.action }));
});

adminRouter.post('/users/:id/permissions', requirePermission('users.manage'), (req, res) => {
  respond(res, setUserPermission(req.user, req.params.id, { permission: req.body.permission, mode: req.body.mode }));
});

adminRouter.post('/users/:id/status', requirePermission('users.manage'), (req, res) => {
  respond(res, setUserStatus(req.user, req.params.id, req.body.status));
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
