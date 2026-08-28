// Shared helpers for all pages. No framework — plain browser JS.
import { ICONS, pop, openSheet } from '/ui.js';
import { escAttr, safeUrl } from '/escape.js';
import { can, canUseAssistant, hasAdminSurface } from '/nav-model.js';
import { mountNavDrawer } from '/nav-drawer.js';

// PWA: register the (network-first) service worker. The install prompt is
// captured earlier, in /pwa-early.js; theme in /theme-boot.js.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Detect stale assets and self-heal (see /version-check.js).
import('/version-check.js').then((m) => m.startVersionWatch()).catch(() => {});

export async function api(path, { method = 'GET', body, formData, signal } = {}) {
  const opts = { method, headers: { 'x-requested-with': 'fetch' } };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (formData) opts.body = formData;
  // Lets a caller cancel a superseded request (see FAQ search in /faq-ui.js).
  if (signal) opts.signal = signal;
  const res = await fetch(`/api${path}`, opts);
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let cachedUser;
export async function currentUser() {
  if (cachedUser !== undefined) return cachedUser;
  try {
    cachedUser = (await api('/auth/me')).user;
  } catch {
    cachedUser = null;
  }
  return cachedUser;
}

export async function signOut() {
  await api('/auth/logout', { method: 'POST' });
  window.location.href = '/';
}

export function esc(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

// escAttr and safeUrl live in /escape.js, can() and the nav derivations in
// /nav-model.js — both DOM-free so node --test can import them directly.
// Re-exported here so pages keep importing from one place.
// Use escAttr inside quoted attributes (esc leaves quotes unescaped), esc for
// text content.
export { escAttr, safeUrl };
export { can, hasAdminSurface };

export function el(id) { return document.getElementById(id); }

export function showNotice(container, kind, text) {
  container.innerHTML = `<div class="notice ${escAttr(kind)}">${esc(text)}</div>`;
}

export function fmtDate(value) {
  if (!value) return '';
  const d = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtDay(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── notifications (badge + Alerts sheet) ─────────────────────────────────
let notifPromise = null;
export function fetchNotifications(fresh = false) {
  if (!notifPromise || fresh) notifPromise = api('/notifications').catch(() => ({ notifications: [], unread: 0 }));
  return notifPromise;
}

function setBadges(unread) {
  document.querySelectorAll('[data-alert-badge]').forEach((slot) => {
    slot.innerHTML = unread > 0 ? `<span class="badge-dot">${unread > 9 ? '9+' : unread}</span>` : '';
  });
}

export async function openAlerts(user) {
  const body = openSheet('Alerts', '<div class="skel skel-line" data-w="90"></div><div class="skel skel-line" data-w="75"></div>');
  const { notifications } = await fetchNotifications(true);
  const caseBase = can(user, 'cases.review') ? '/advisor.html#/case/' : '/portal.html#/case/';
  const jeBase = can(user, 'je.review') ? '/advisor.html#/banding/' : '/portal.html#/banding/';
  body.innerHTML = notifications.length
    ? notifications.map((n) => `
        <a class="notif-item ${n.read_at ? '' : 'unread'}" href="${n.je_review_id ? `${jeBase}${n.je_review_id}` : n.case_id ? `${caseBase}${n.case_id}` : '#'}">
          ${esc(n.title)}${n.body ? `<span class="muted small"> — ${esc(n.body)}</span>` : ''}
          <div class="muted small">${esc(fmtDate(n.created_at))}</div>
        </a>`).join('')
    : '<p class="muted small">Nothing yet. Updates about your cases appear here.</p>';
  // Reading the sheet marks everything read.
  api('/notifications/read', { method: 'POST' }).then(() => {
    setBadges(0);
    fetchNotifications(true);
  }).catch(() => {});
}

// ── tab bar ──────────────────────────────────────────────────────────────
function tabsForRole(user) {
  if (can(user, 'cases.review')) {
    return [
      { id: 'advisor-today', icon: 'today', label: 'Today', href: '/advisor.html#/' },
      { id: 'advisor-queue', icon: 'queue', label: 'Queue', href: '/advisor.html#/queue', also: ['/advisor.html#/banding'] },
      { id: 'assistant', icon: 'chat', label: 'Assistant', action: 'assistant' },
      { id: 'alerts', icon: 'bell', label: 'Alerts', action: 'alerts', badge: true },
      { id: 'account', icon: 'account', label: 'Account', href: '/account.html' },
    ];
  }
  if (hasAdminSurface(user)) {
    const tabs = [
      { id: 'admin-overview', icon: 'overview', label: 'Overview', href: '/admin.html#/overview' },
    ];
    if (can(user, 'users.manage')) tabs.push({ id: 'admin-users', icon: 'users', label: 'Users', href: '/admin.html#/users' });
    if (canUseAssistant(user)) {
      tabs.push({ id: 'assistant', icon: 'chat', label: 'Assistant', action: 'assistant' });
    }
    tabs.push(
      { id: 'alerts', icon: 'bell', label: 'Alerts', action: 'alerts', badge: true },
      { id: 'account', icon: 'account', label: 'Account', href: '/account.html' }
    );
    return tabs;
  }
  if (can(user, 'cases.own')) {
    return [
      { id: 'portal-home', icon: 'home', label: 'Home', href: '/portal.html#/' },
      { id: 'portal-cases', icon: 'cases', label: 'Cases', href: '/portal.html#/cases', also: ['/portal.html#/banding'] },
      { id: 'portal-new', icon: 'plus', label: 'Start', href: '/portal.html#/new', accent: true, also: ['/portal.html#/banding/new'] },
      { id: 'alerts', icon: 'bell', label: 'Alerts', action: 'alerts', badge: true },
      { id: 'account', icon: 'account', label: 'Account', href: '/account.html' },
    ];
  }
  return [];
}

function currentTabId(tabs) {
  const here = window.location.pathname.replace(/\/$/, '') || '/index.html';
  const hash = window.location.hash || '#/';
  // `also` prefixes (e.g. the banding section living under the Cases tab):
  // longest prefix wins so '#/banding/new' lights Start, not Cases.
  let alsoBest = null;
  for (const t of tabs) {
    for (const alt of t.also || []) {
      const [altPath, altHash] = alt.split('#');
      if (altPath !== here || !altHash) continue;
      const want = `#${altHash}`;
      if ((hash === want || hash.startsWith(`${want}/`) || hash.startsWith(want)) &&
          (!alsoBest || want.length > alsoBest.len)) {
        alsoBest = { id: t.id, len: want.length };
      }
    }
  }
  if (alsoBest) return alsoBest.id;
  let best = null;
  for (const t of tabs) {
    if (!t.href) continue;
    const [path, tabHash] = t.href.split('#');
    if (path !== here && `${path}` !== `${here}`) continue;
    if (tabHash) {
      const want = `#${tabHash}`;
      if (hash === want || (want !== '#/' && hash.startsWith(want))) return t.id;
      if (want === '#/' && (hash === '#/' || hash === '')) best = best || t.id;
      if (want === '#/' && hash.startsWith('#/case/')) best = best || t.id; // case views belong to the home tab
    } else {
      best = best || t.id;
    }
  }
  return best || tabs.find((t) => t.href)?.id || null;
}

function renderTabBar(user) {
  const bar = document.getElementById('tab-bar');
  if (!bar) return;
  const tabs = tabsForRole(user);
  if (tabs.length === 0) return;

  bar.innerHTML = `<div class="tab-indicator" aria-hidden="true"></div>${tabs
    .map((t) => t.href
      ? `<a class="tab-item ${t.accent ? 'accent-tab' : ''}" data-tab-id="${t.id}" href="${t.href}">
           <span class="tab-icon">${ICONS[t.icon]}</span>${t.badge ? '<span data-alert-badge></span>' : ''}
           <span class="tab-label">${t.label}</span></a>`
      : `<button class="tab-item" type="button" data-tab-id="${t.id}" data-action="${t.action}">
           <span class="tab-icon">${ICONS[t.icon]}</span>${t.badge ? '<span data-alert-badge></span>' : ''}
           <span class="tab-label">${t.label}</span></button>`)
    .join('')}`;
  bar.hidden = false;
  document.body.classList.add('has-tabbar');

  const indicator = bar.querySelector('.tab-indicator');
  const n = tabs.length;
  indicator.style.width = `${40 / n}%`;
  indicator.style.marginLeft = `${30 / n}%`;

  function setActive() {
    const activeTab = currentTabId(tabs);
    const idx = Math.max(0, tabs.findIndex((t) => t.id === activeTab));
    bar.querySelectorAll('.tab-item').forEach((elTab) => {
      const on = elTab.dataset.tabId === activeTab;
      elTab.classList.toggle('active', on);
      if (on) elTab.setAttribute('aria-current', 'page');
      else elTab.removeAttribute('aria-current');
    });
    indicator.style.transform = `translateX(${idx * 250}%)`;
  }
  setActive();
  window.addEventListener('hashchange', setActive);

  bar.querySelectorAll('.tab-item').forEach((item) =>
    item.addEventListener('click', () => pop(item.querySelector('svg'))));
  bar.querySelectorAll('[data-action="alerts"]').forEach((b) =>
    b.addEventListener('click', () => openAlerts(user)));
  bar.querySelectorAll('[data-action="assistant"]').forEach((b) =>
    b.addEventListener('click', () => window.__openAssistant?.()));

  // Hide the bar while the keyboard is open (mobile).
  document.addEventListener('focusin', (e) => {
    if (e.target.matches('input, textarea, select')) document.body.classList.add('kb-open');
  });
  document.addEventListener('focusout', () => document.body.classList.remove('kb-open'));

  fetchNotifications().then((n2) => setBadges(n2.unread));
}

// ── header nav ───────────────────────────────────────────────────────────
export async function renderNav(activeId) {
  const nav = document.querySelector('.site-header nav');
  if (!nav) return null;
  const user = await currentUser();
  const links = [];
  // Tuples are [id, href, label, className?]. The 4th element exists for
  // 'nav-keep': styles.css hides header links on mobile for signed-in users
  // (body.has-tabbar ... a:not(.nav-keep)), so a link that must survive there
  // has to opt in explicitly.
  if (!user) {
    links.push(['faq', '/faq.html', 'Questions', 'nav-keep']);
    links.push(['login', '/login.html', 'Sign in'], ['register', '/register.html', 'Create account']);
  } else {
    if (can(user, 'cases.own')) links.push(['portal', '/portal.html', 'My cases']);
    if (can(user, 'je.own')) links.push(['banding', '/portal.html#/banding', 'Band review']);
    if (can(user, 'cases.review')) links.push(['advisor', '/advisor.html', 'Advisor']);
    if (hasAdminSurface(user)) links.push(['admin', '/admin.html', 'Admin']);
    links.push(['faq', '/faq.html', 'Questions', 'nav-keep']);
    links.push(['account', '/account.html', 'Account'], ['logout', '#logout', 'Sign out']);
  }
  nav.innerHTML = links
    .map(([id, href, label, cls = '']) =>
      `<a href="${href}" data-nav="${id}" class="${id === activeId ? 'active' : ''} ${cls}">${label}</a>`)
    .join('');

  if (user) {
    // Header bell (kept visible on mobile alongside the tab bar).
    const bell = document.createElement('button');
    bell.className = 'bell-btn';
    bell.type = 'button';
    bell.setAttribute('aria-label', 'Alerts');
    bell.innerHTML = `${ICONS.bell}<span data-alert-badge></span>`;
    bell.addEventListener('click', () => openAlerts(user));
    nav.appendChild(bell);
    // Everything else this account can reach — including the sections too deep
    // for the header links or the five mobile tabs.
    mountNavDrawer(nav, user, signOut);
  }

  const logout = nav.querySelector('[data-nav="logout"]');
  if (logout) {
    logout.addEventListener('click', (e) => {
      e.preventDefault();
      signOut();
    });
  }

  if (user) {
    renderTabBar(user);
    // Floating assistant for accounts holding at least one assistant
    // permission (the server gates every call regardless).
    if (canUseAssistant(user)) {
      import('/assistant-widget.js').then((m) => m.mountAssistantWidget()).catch(() => {});
    }
    fetchNotifications().then((n) => setBadges(n.unread));
  }
  return user;
}

export async function requireUser(activeId, permission) {
  const user = await renderNav(activeId);
  if (!user) {
    window.location.href = '/login.html';
    return null;
  }
  if (permission && !can(user, permission)) {
    document.querySelector('main').innerHTML =
      '<div class="notice error">Your account does not have access to this area.</div>';
    return null;
  }
  return user;
}
