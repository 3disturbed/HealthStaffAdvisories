import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  can,
  adminSections,
  hasAdminSurface,
  advisorSections,
  memberSections,
  menuGroups,
} from '../public/nav-model.js';
import { ROLE_DEFAULTS, PERMISSIONS } from '../src/rbac/permissions.js';

const withPerms = (...permissions) => ({ permissions });
const roleUser = (...roles) => withPerms(...new Set(roles.flatMap((r) => ROLE_DEFAULTS[r])));
const mainAdmin = () => withPerms(...Object.keys(PERMISSIONS));

const ids = (sections) => sections.map((s) => s.id);
const group = (user, title) => menuGroups(user).find((g) => g.title === title);

test('can() needs a user and an explicit permission', () => {
  assert.equal(can(null, 'users.manage'), false);
  assert.equal(can(undefined, 'users.manage'), false);
  assert.equal(can(withPerms(), 'users.manage'), false);
  assert.equal(can(withPerms('users.manage'), 'users.manage'), true);
  assert.equal(can(withPerms('users.manage'), 'system.admin'), false);
});

test('a member has no admin surface and no advisor sections', () => {
  const member = roleUser('member');
  assert.equal(hasAdminSurface(member), false);
  assert.deepEqual(ids(adminSections(member)), ['overview']);
  assert.deepEqual(advisorSections(member), []);
  assert.deepEqual(ids(memberSections(member)), ['portal-home', 'portal-cases', 'portal-new', 'portal-banding']);
  assert.equal(group(member, 'Admin'), undefined, 'a member must never see an Admin group');
  assert.ok(group(member, 'Your cases'), 'a member gets their own workspace group');
});

// The drift this module exists to remove: these two accounts passed
// admin.html's own gate and saw real tabs, but the header link and the mobile
// tab bar used a different permission union and left them out entirely.
test('a faq.manage-only account has a real admin surface', () => {
  const editor = withPerms('faq.manage');
  assert.equal(hasAdminSurface(editor), true);
  assert.deepEqual(ids(adminSections(editor)), ['overview', 'faq']);
  assert.deepEqual(group(editor, 'Admin').items.map((i) => i.href), ['/admin.html#/overview', '/admin.html#/faq']);
});

test('a je.monitor-only account reaches Job evaluation', () => {
  const monitor = withPerms('je.monitor');
  assert.equal(hasAdminSurface(monitor), true);
  assert.deepEqual(ids(adminSections(monitor)), ['overview', 'banding']);
});

test('hasAdminSurface is exactly "more than the unconditional overview"', () => {
  assert.equal(hasAdminSurface(withPerms()), false);
  assert.deepEqual(ids(adminSections(withPerms())), ['overview']);
  for (const permission of ['users.manage', 'system.admin', 'knowledge.manage', 'audit.view', 'faq.manage', 'je.monitor', 'je.reference.manage', 'cases.review']) {
    assert.equal(hasAdminSurface(withPerms(permission)), true, `${permission} should open an admin surface`);
  }
  for (const permission of ['cases.own', 'je.own', 'cases.respond', 'cases.notes', 'cases.status', 'je.review', 'je.decide']) {
    assert.equal(hasAdminSurface(withPerms(permission)), false, `${permission} must not open an admin surface`);
  }
});

test('an advisor gets the advisor group plus the admin sections their role grants', () => {
  const advisor = roleUser('advisor');
  assert.deepEqual(ids(advisorSections(advisor)), ['advisor-today', 'advisor-queue', 'advisor-banding']);
  assert.deepEqual(ids(adminSections(advisor)), ['overview', 'assistant', 'knowledge', 'faq']);
  assert.deepEqual(memberSections(advisor), [], 'an advisor holds no cases.own');
  assert.deepEqual(menuGroups(advisor).map((g) => g.title), ['Advisor', 'Admin', 'Account']);
});

test('an admin gets every section their role grants, in tab order', () => {
  assert.deepEqual(ids(adminSections(roleUser('admin'))), [
    'overview', 'users', 'assistant', 'membership', 'settings', 'mailbox', 'knowledge', 'banding', 'faq', 'audit',
  ]);
});

test('the main admin sees all ten sections and all three workspaces', () => {
  const user = mainAdmin();
  assert.equal(adminSections(user).length, 10);
  assert.deepEqual(menuGroups(user).map((g) => g.title), ['Your cases', 'Advisor', 'Admin', 'Account']);
});

test('every signed-in account gets Questions, Account and Sign out', () => {
  for (const user of [roleUser('member'), roleUser('advisor'), roleUser('admin'), withPerms()]) {
    const account = group(user, 'Account');
    assert.deepEqual(account.items.map((i) => i.id), ['faq', 'account', 'logout']);
  }
  assert.deepEqual(menuGroups(null), [], 'signed out gets no menu at all');
});

test('the menu never offers a destination the permissions did not grant', () => {
  const users = [roleUser('member'), roleUser('advisor'), roleUser('admin'), mainAdmin(), withPerms('faq.manage'), withPerms('je.monitor'), withPerms()];
  for (const user of users) {
    const allowed = new Set([
      ...memberSections(user).map((s) => s.href),
      ...advisorSections(user).map((s) => s.href),
      ...(hasAdminSurface(user) ? adminSections(user).map((s) => `/admin.html#/${s.id}`) : []),
      '/faq.html', '/account.html', '#logout',
    ]);
    for (const g of menuGroups(user)) {
      for (const item of g.items) {
        assert.ok(allowed.has(item.href), `${item.href} is not derivable from this account's permissions`);
      }
    }
  }
});

test('no group is ever rendered empty', () => {
  for (const user of [roleUser('member'), roleUser('advisor'), roleUser('admin'), mainAdmin(), withPerms()]) {
    for (const g of menuGroups(user)) assert.ok(g.items.length > 0, `${g.title} is empty`);
  }
});
