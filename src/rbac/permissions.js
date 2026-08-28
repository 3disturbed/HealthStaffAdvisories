import { db } from '../db/connection.js';

// Full permission catalogue. Roles carry a default set; the main admin can
// grant or revoke individual permissions per account on top of role defaults.
export const PERMISSIONS = {
  'cases.own': 'Create and view own cases',
  'cases.review': 'View and work the advisor case queue',
  'cases.respond': 'Send advisor responses and action plans',
  'cases.notes': 'Read and write private advisor notes',
  'cases.status': 'Change case status, urgency and escalations',
  'knowledge.manage': 'Add and version knowledge sources',
  'faq.manage': 'Write and publish FAQ answers and categories',
  'users.manage': 'Grant and remove roles/permissions on accounts',
  'audit.view': 'View the audit log',
  'system.admin': 'Operational admin (AI kill switch, dev mailbox)',
  'je.own': 'Start and view own band reviews',
  'je.review': 'Work the job evaluation queue and confirm factor levels',
  'je.decide': 'Sign off assessments, issue JE reports and record outcomes',
  'je.reference.manage': 'Import, approve and verify job evaluation reference data',
  'je.monitor': 'View aggregate job evaluation quality metrics',
};

export const ROLE_DEFAULTS = {
  member: ['cases.own', 'je.own'],
  advisor: ['cases.review', 'cases.respond', 'cases.notes', 'cases.status', 'knowledge.manage', 'faq.manage', 'je.review', 'je.decide'],
  admin: ['users.manage', 'audit.view', 'system.admin', 'knowledge.manage', 'faq.manage', 'je.reference.manage', 'je.monitor'],
};

export const ROLES = Object.keys(ROLE_DEFAULTS);

export function rolesForUser(userId) {
  return db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(userId).map((r) => r.role);
}

export function overridesForUser(userId) {
  return db.prepare('SELECT permission, mode FROM user_permissions WHERE user_id = ?').all(userId);
}

// Effective permissions: union of role defaults, plus grants, minus revokes.
// The main administration account always holds every permission.
export function permissionsForUser(user) {
  if (user.is_main_admin) return new Set(Object.keys(PERMISSIONS));
  const perms = new Set();
  for (const role of rolesForUser(user.id)) {
    for (const p of ROLE_DEFAULTS[role] || []) perms.add(p);
  }
  for (const { permission, mode } of overridesForUser(user.id)) {
    if (!(permission in PERMISSIONS)) continue;
    if (mode === 'grant') perms.add(permission);
    else perms.delete(permission);
  }
  return perms;
}

export function userHas(user, permission) {
  return permissionsForUser(user).has(permission);
}
