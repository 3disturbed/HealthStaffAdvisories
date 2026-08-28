// Permission-gated navigation model: who can reach what, decided once.
// DOM-free so `node --test` can import it directly (same reason as /escape.js).
//
// The header nav, the mobile tab bar, the nav drawer and admin.html's own
// access gate all derive from here. They used to be four hand-maintained
// permission unions and had already drifted apart: a faq.manage-only or
// je.monitor-only account passed admin.html's gate and saw real tabs, but got
// no Admin header link and no admin tab bar.

export function can(user, permission) {
  return !!user && user.permissions.includes(permission);
}

const anyOf = (user, perms) => perms.some((p) => can(user, p));

// Holding any one of these makes the assistant worth offering; the server
// gates every call regardless.
export const ASSISTANT_PERMS = ['users.manage', 'cases.review', 'knowledge.manage'];

export function canUseAssistant(user) {
  return anyOf(user, ASSISTANT_PERMS);
}

// The admin workspace, in tab order. 'overview' is unconditional — see
// hasAdminSurface().
export function adminSections(user) {
  const sections = [{ id: 'overview', label: 'Overview' }];
  if (can(user, 'users.manage')) sections.push({ id: 'users', label: 'Users & permissions' });
  if (canUseAssistant(user)) sections.push({ id: 'assistant', label: 'Assistant' });
  if (can(user, 'system.admin')) {
    sections.push(
      { id: 'membership', label: 'Membership & payments' },
      { id: 'settings', label: 'AI settings' },
      { id: 'mailbox', label: 'Dev mailbox' }
    );
  }
  if (can(user, 'knowledge.manage')) sections.push({ id: 'knowledge', label: 'Knowledge sources' });
  if (anyOf(user, ['je.reference.manage', 'je.monitor'])) sections.push({ id: 'banding', label: 'Job evaluation' });
  if (can(user, 'faq.manage')) sections.push({ id: 'faq', label: 'FAQ' });
  if (can(user, 'audit.view')) sections.push({ id: 'audit', label: 'Audit log' });
  return sections;
}

// 'overview' always lands, so anything beyond it means a real admin surface.
// One predicate for the header link, the tab bar, the drawer and the page gate.
export function hasAdminSurface(user) {
  return adminSections(user).length > 1;
}

export function advisorSections(user) {
  if (!can(user, 'cases.review')) return [];
  const sections = [
    { id: 'advisor-today', label: 'Today', href: '/advisor.html#/' },
    { id: 'advisor-queue', label: 'Queue', href: '/advisor.html#/queue' },
  ];
  if (anyOf(user, ['je.review', 'je.decide'])) {
    sections.push({ id: 'advisor-banding', label: 'Band reviews', href: '/advisor.html#/banding' });
  }
  return sections;
}

export function memberSections(user) {
  if (!can(user, 'cases.own')) return [];
  const sections = [
    { id: 'portal-home', label: 'Home', href: '/portal.html#/' },
    { id: 'portal-cases', label: 'Cases', href: '/portal.html#/cases' },
    { id: 'portal-new', label: 'Start a case', href: '/portal.html#/new' },
  ];
  if (can(user, 'je.own')) sections.push({ id: 'portal-banding', label: 'Band review', href: '/portal.html#/banding' });
  return sections;
}

// The drawer payload: the workspaces this account actually holds, then the
// links every signed-in account gets. Empty groups are dropped, so a member
// never sees an 'Admin' heading and an advisor-only account never sees 'Your
// cases'.
export function menuGroups(user) {
  if (!user) return [];
  const admin = hasAdminSurface(user)
    ? adminSections(user).map((s) => ({ id: `admin-${s.id}`, label: s.label, href: `/admin.html#/${s.id}` }))
    : [];
  return [
    { title: 'Your cases', items: memberSections(user) },
    { title: 'Advisor', items: advisorSections(user) },
    { title: 'Admin', items: admin },
    {
      title: 'Account',
      items: [
        { id: 'faq', label: 'Questions', href: '/faq.html' },
        { id: 'account', label: 'Account', href: '/account.html' },
        { id: 'logout', label: 'Sign out', href: '#logout' },
      ],
    },
  ].filter((group) => group.items.length > 0);
}
