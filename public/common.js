// Shared helpers for all pages. No framework — plain browser JS.
import { ICONS, pop, toast } from '/ui.js';
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

// ── unread badge ─────────────────────────────────────────────────────────
// One count for both Inbox feeds: unread updates plus unread message threads
// (see src/api/notifications.js).
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

// ── assistant launcher ───────────────────────────────────────────────────
// Two launchers open the same panel: the floating button the widget draws
// itself, and the tab bar's Assistant tab, painted here. The tab is clickable
// the moment the bar renders, but the widget behind it is a separate module a
// network round trip away — taps that landed in that window used to be dropped
// in silence. Routing them through this promise opens the panel as soon as the
// module lands, and says so when it never does.
let assistantLoad = null;
function loadAssistant() {
  if (!assistantLoad) {
    assistantLoad = import('/assistant-widget.js');
    // A failed load must not leave the button dead for the rest of the
    // session: forget it so the next click tries again.
    assistantLoad.catch(() => { assistantLoad = null; });
  }
  return assistantLoad;
}

export async function openAssistant() {
  let widget;
  try {
    widget = await loadAssistant();
  } catch (err) {
    // Genuinely could not fetch the module — the one case where blaming the
    // connection is honest.
    console.error('[assistant] module failed to load', err);
    toast('error', 'The assistant could not be loaded. Check your connection and try again.');
    return;
  }

  // common.js and the widget are two files that have to agree. A browser can
  // hold a fresh one and a stale one across a deploy, and the stale widget has
  // no openAssistantWidget() — which is a version skew, not a network fault.
  // Clear the caches that caused it and say what will actually help.
  if (typeof widget.openAssistantWidget !== 'function') {
    console.error('[assistant] stale widget module: no openAssistantWidget export');
    await import('/version-check.js').then((m) => m.purgeCaches()).catch(() => {});
    toast('error', 'The app has been updated — refresh the page to use the assistant.');
    return;
  }

  try {
    widget.openAssistantWidget();
  } catch (err) {
    // Not a loading problem. Name it, and leave it in the console to chase.
    console.error('[assistant] failed to open', err);
    toast('error', `The assistant could not open: ${err.message}`);
  }
}

// ── tab bar ──────────────────────────────────────────────────────────────
function tabsForRole(user) {
  if (can(user, 'cases.review')) {
    return [
      { id: 'advisor-today', icon: 'today', label: 'Today', href: '/advisor.html#/' },
      { id: 'advisor-queue', icon: 'queue', label: 'Queue', href: '/advisor.html#/queue', also: ['/advisor.html#/banding'] },
      { id: 'assistant', icon: 'chat', label: 'Assistant', action: 'assistant' },
      { id: 'inbox', icon: 'bell', label: 'Inbox', href: '/inbox.html', badge: true },
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
      { id: 'inbox', icon: 'bell', label: 'Inbox', href: '/inbox.html', badge: true },
      { id: 'account', icon: 'account', label: 'Account', href: '/account.html' }
    );
    return tabs;
  }
  if (can(user, 'cases.own')) {
    return [
      { id: 'portal-home', icon: 'home', label: 'Home', href: '/portal.html#/' },
      { id: 'portal-cases', icon: 'cases', label: 'Cases', href: '/portal.html#/cases', also: ['/portal.html#/banding'] },
      { id: 'portal-new', icon: 'plus', label: 'Start', href: '/portal.html#/new', accent: true, also: ['/portal.html#/banding/new'] },
      { id: 'inbox', icon: 'bell', label: 'Inbox', href: '/inbox.html', badge: true },
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
  bar.querySelectorAll('[data-action="assistant"]').forEach((b) =>
    b.addEventListener('click', () => openAssistant()));

  // Hide the bar while the keyboard is open (mobile).
  document.addEventListener('focusin', (e) => {
    if (e.target.matches('input, textarea, select')) document.body.classList.add('kb-open');
  });
  document.addEventListener('focusout', () => document.body.classList.remove('kb-open'));

  fetchNotifications().then((n2) => setBadges(n2.unread));
}

// ── header nav ───────────────────────────────────────────────────────────
// The bar carries no links: brand on the left, Inbox bell and hamburger on the
// right. Every destination lives in the drawer (/nav-model.js), signed in or
// out, so there is one navigation surface rather than two saying the same
// thing. `activeId` is accepted for the callers' sake but no longer used here —
// the drawer marks its own active entry from the live URL, which is more
// accurate than an id the page has to remember to pass.
export async function renderNav(activeId) {
  const nav = document.querySelector('.site-header nav');
  if (!nav) return null;
  const user = await currentUser();
  nav.innerHTML = '';

  if (user) {
    // The bell stays out of the drawer: it carries the unread badge, and a
    // count behind a menu is a count nobody sees. Alerts and messages share
    // one Inbox page, so it is a link rather than a sheet.
    const bell = document.createElement('a');
    bell.className = 'bell-btn';
    bell.href = '/inbox.html';
    bell.setAttribute('aria-label', 'Inbox');
    bell.innerHTML = `${ICONS.bell}<span data-alert-badge></span>`;
    nav.appendChild(bell);
  }
  // Mounted for everyone — signed-out visitors get Questions, Contact, Sign in
  // and Create account here instead of in the bar.
  mountNavDrawer(nav, user, signOut);

  if (user) {
    renderTabBar(user);
    // Floating assistant for accounts holding at least one assistant
    // permission (the server gates every call regardless). Failure is quiet
    // here — nobody has asked for the assistant yet; openAssistant() reports it
    // if and when somebody presses a launcher.
    if (canUseAssistant(user)) {
      loadAssistant().then((m) => m.mountAssistantWidget()).catch(() => {});
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
