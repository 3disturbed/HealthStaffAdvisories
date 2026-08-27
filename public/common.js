// Shared helpers for all pages. No framework — plain browser JS.

export async function api(path, { method = 'GET', body, formData } = {}) {
  const opts = { method, headers: { 'x-requested-with': 'fetch' } };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (formData) opts.body = formData;
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

export function can(user, permission) {
  return !!user && user.permissions.includes(permission);
}

export function esc(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

export function el(id) { return document.getElementById(id); }

export function showNotice(container, kind, text) {
  container.innerHTML = `<div class="notice ${esc(kind)}">${esc(text)}</div>`;
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

// Render the signed-in navigation. Pages pass their own id for highlighting.
export async function renderNav(activeId) {
  const nav = document.querySelector('.site-header nav');
  if (!nav) return null;
  const user = await currentUser();
  const links = [];
  if (!user) {
    links.push(['login', '/login.html', 'Sign in'], ['register', '/register.html', 'Create account']);
  } else {
    if (can(user, 'cases.own')) links.push(['portal', '/portal.html', 'My cases']);
    if (can(user, 'cases.review')) links.push(['advisor', '/advisor.html', 'Advisor']);
    if (['users.manage', 'system.admin', 'audit.view', 'knowledge.manage', 'cases.review'].some((p) => can(user, p))) {
      links.push(['admin', '/admin.html', 'Admin']);
    }
    links.push(['account', '/account.html', 'Account'], ['logout', '#logout', 'Sign out']);
  }
  nav.innerHTML = links
    .map(([id, href, label]) => `<a href="${href}" data-nav="${id}" class="${id === activeId ? 'active' : ''}">${label}</a>`)
    .join('');
  const logout = nav.querySelector('[data-nav="logout"]');
  if (logout) {
    logout.addEventListener('click', async (e) => {
      e.preventDefault();
      await api('/auth/logout', { method: 'POST' });
      window.location.href = '/';
    });
  }
  // Floating assistant for accounts that hold at least one assistant
  // permission (the server gates every call regardless).
  if (user && ['users.manage', 'cases.review', 'knowledge.manage'].some((p) => can(user, p))) {
    import('/assistant-widget.js').then((m) => m.mountAssistantWidget()).catch(() => {});
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
