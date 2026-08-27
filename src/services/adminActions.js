import { db } from '../db/connection.js';
import { ROLES, PERMISSIONS, rolesForUser, overridesForUser, permissionsForUser } from '../rbac/permissions.js';
import { revokeAllSessions } from '../auth/sessions.js';
import { audit } from '../audit/log.js';

// Single source of truth for admin mutations. Used by the admin API router
// AND the assistant's write tools, so the guard rules cannot drift:
// - the main administration account is untouchable by anyone;
// - only the main admin grants/removes the admin role and admin permissions;
// - an actor cannot disable their own account.
// Every function returns { error, status } or { ok, ... }.

function findTarget(targetId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(targetId));
}

function auditMeta(base, opts) {
  return opts.via ? { ...base, via: opts.via, actionId: opts.actionId } : base;
}

export function setUserRole(actor, targetId, { role, action }, opts = {}) {
  const target = findTarget(targetId);
  if (!target) return { error: 'User not found.', status: 404 };
  if (target.is_main_admin) return { error: 'The main administration account cannot be modified.', status: 403 };
  if (!ROLES.includes(role)) return { error: 'Unknown role.', status: 400 };
  if (!['add', 'remove'].includes(action)) return { error: 'Action must be add or remove.', status: 400 };
  if (role === 'admin' && !actor.is_main_admin) {
    return { error: 'Only the main administration account can grant or remove the admin role.', status: 403 };
  }
  if (action === 'add') {
    db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role, granted_by) VALUES (?, ?, ?)').run(target.id, role, actor.id);
  } else {
    db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role = ?').run(target.id, role);
  }
  audit(actor.id, `role.${action}`, 'user', target.id, auditMeta({ role }, opts));
  return { ok: true, roles: rolesForUser(target.id) };
}

export function setUserPermission(actor, targetId, { permission, mode }, opts = {}) {
  const target = findTarget(targetId);
  if (!target) return { error: 'User not found.', status: 404 };
  if (target.is_main_admin) return { error: 'The main administration account cannot be modified.', status: 403 };
  if (!(permission in PERMISSIONS)) return { error: 'Unknown permission.', status: 400 };
  if (!['grant', 'revoke', 'clear'].includes(mode)) return { error: 'Mode must be grant, revoke or clear.', status: 400 };
  if ((permission === 'users.manage' || permission === 'system.admin') && !actor.is_main_admin) {
    return { error: 'Only the main administration account can change administrative permissions.', status: 403 };
  }
  if (mode === 'clear') {
    db.prepare('DELETE FROM user_permissions WHERE user_id = ? AND permission = ?').run(target.id, permission);
  } else {
    db.prepare(
      `INSERT INTO user_permissions (user_id, permission, mode, granted_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, permission) DO UPDATE SET mode = excluded.mode, granted_by = excluded.granted_by, created_at = datetime('now')`
    ).run(target.id, permission, mode, actor.id);
  }
  audit(actor.id, `permission.${mode}`, 'user', target.id, auditMeta({ permission }, opts));
  return { ok: true, overrides: overridesForUser(target.id), effectivePermissions: [...permissionsForUser(target)] };
}

export function setUserStatus(actor, targetId, status, opts = {}) {
  const target = findTarget(targetId);
  if (!target) return { error: 'User not found.', status: 404 };
  if (target.is_main_admin) return { error: 'The main administration account cannot be modified.', status: 403 };
  if (target.id === actor.id) return { error: 'You cannot disable your own account.', status: 400 };
  if (!['active', 'disabled'].includes(status)) return { error: 'Status must be active or disabled.', status: 400 };
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, target.id);
  if (status === 'disabled') revokeAllSessions(target.id);
  audit(actor.id, `user.${status}`, 'user', target.id, auditMeta({}, opts));
  return { ok: true, status };
}
