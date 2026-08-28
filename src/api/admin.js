import { Router } from 'express';
import { db, getSetting, setSetting } from '../db/connection.js';
import { requirePermission } from '../auth/middleware.js';
import { PERMISSIONS, ROLES, ROLE_DEFAULTS, rolesForUser, overridesForUser, permissionsForUser } from '../rbac/permissions.js';
import { setUserRole, setUserPermission, setUserStatus } from '../services/adminActions.js';
import { audit } from '../audit/log.js';
import { aiConfigured } from '../ai/intake.js';
import { config } from '../config.js';
import { listTiers, updateTier, currentSubscription, costToValue, recordComp } from '../services/membership.js';

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
  const stripeKey = getSetting('stripe_secret_key', '');
  const stripeWhsec = getSetting('stripe_webhook_secret', '');
  res.json({
    aiConfigured: aiConfigured(),
    aiDisabled: getSetting('ai_disabled', '0') === '1',
    aiModel: getSetting('ai_model', config.defaultAiModel),
    // Never return stored secrets — only enough to recognise them.
    openaiKeyMasked: key ? `sk-…${key.slice(-4)}` : null,
    stripeConfigured: !!stripeKey,
    stripeTestMode: stripeKey.startsWith('sk_test_'),
    stripeKeyMasked: stripeKey ? `sk_…${stripeKey.slice(-4)}` : null,
    stripeWebhookMasked: stripeWhsec ? `whsec_…${stripeWhsec.slice(-4)}` : null,
    cvWeights: {
      ai: Number(getSetting('cv_weight_ai', 40)),
      reply: Number(getSetting('cv_weight_reply', 300)),
      doc: Number(getSetting('cv_weight_doc', 20)),
      case: Number(getSetting('cv_weight_case', 500)),
    },
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
  if (typeof req.body.stripeSecretKey === 'string' && req.body.stripeSecretKey.trim()) {
    const key = req.body.stripeSecretKey.trim();
    if (key.length < 20 || !key.startsWith('sk_')) return res.status(400).json({ error: 'That does not look like a Stripe secret key.' });
    setSetting('stripe_secret_key', key);
    changed.push('stripe_secret_key');
  }
  if (typeof req.body.stripeWebhookSecret === 'string' && req.body.stripeWebhookSecret.trim()) {
    const whsec = req.body.stripeWebhookSecret.trim();
    if (whsec.length < 20 || !whsec.startsWith('whsec_')) return res.status(400).json({ error: 'That does not look like a Stripe webhook secret.' });
    setSetting('stripe_webhook_secret', whsec);
    changed.push('stripe_webhook_secret');
  }
  if (req.body.clearStripeKeys === true) {
    db.prepare(`DELETE FROM settings WHERE key IN ('stripe_secret_key', 'stripe_webhook_secret')`).run();
    changed.push('stripe_keys_cleared');
  }
  for (const [field, key] of [['cvWeightAi', 'cv_weight_ai'], ['cvWeightReply', 'cv_weight_reply'], ['cvWeightDoc', 'cv_weight_doc'], ['cvWeightCase', 'cv_weight_case']]) {
    if (req.body[field] !== undefined) {
      const n = Number(req.body[field]);
      if (!Number.isInteger(n) || n < 0 || n > 100000) return res.status(400).json({ error: 'Cost weights must be 0–100000 pence.' });
      setSetting(key, n);
      changed.push(key);
    }
  }
  if (changed.length === 0) return res.status(400).json({ error: 'Nothing to change.' });
  audit(req.user.id, 'settings.updated', 'settings', '', { changed }); // names only, never values
  res.json({ ok: true, changed });
});

// ── membership administration ────────────────────────────────────────────

adminRouter.get('/tiers', requirePermission('system.admin'), (req, res) => {
  res.json({ tiers: listTiers({ includeInactive: true }) });
});

adminRouter.post('/tiers/:id', requirePermission('system.admin'), (req, res) => {
  respond(res, updateTier(req.user, req.params.id, {
    name: req.body.name, pricePence: req.body.pricePence,
    aiDailyAllowance: req.body.aiDailyAllowance, active: req.body.active,
  }));
});

adminRouter.get('/ledger', requirePermission('system.admin'), (req, res) => {
  const rows = db
    .prepare(`SELECT p.*, u.email AS user_email, t.name AS tier_name FROM payments p
              JOIN users u ON u.id = p.user_id JOIN membership_tiers t ON t.id = p.tier_id
              ORDER BY p.id DESC LIMIT 100`)
    .all();
  res.json({ payments: rows });
});

adminRouter.get('/members-billing', requirePermission('system.admin'), (req, res) => {
  const members = db
    .prepare(`SELECT DISTINCT u.id, u.email, u.display_name, u.pay_band, u.created_at
              FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = 'member'
              ORDER BY u.created_at`)
    .all();
  res.json({
    members: members.map((m) => {
      const state = currentSubscription(m.id);
      const cv = costToValue(m.id);
      return {
        id: m.id, email: m.email, displayName: m.display_name,
        payBand: m.pay_band || '', tier: state.tier?.name || 'Pilot',
        renewsAt: state.subscription?.periodEnd || null,
        paidPence: cv.error ? 0 : cv.paidPence,
        estCostPence: cv.error ? 0 : cv.estCostPence,
        cv: cv.error ? 0 : Math.round(cv.cv * 100) / 100,
        tenureDays: cv.error ? 0 : cv.tenureDays,
      };
    }),
  });
});

adminRouter.post('/comp', requirePermission('system.admin'), (req, res) => {
  respond(res, recordComp(req.user, Number(req.body.userId), {
    tierId: String(req.body.tierId || ''), months: req.body.months, note: req.body.note,
  }));
});
