import { api, esc, el, fmtDate, requireUser, can, showNotice } from '/common.js';
import { installPanel, wireInstallPanel } from '/install-ui.js';
import { enterView, setBusy, toast, skelForm } from '/ui.js';

const view = document.getElementById('view');
let user;

const THEME_OPTIONS = [
  ['auto', 'Auto'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

async function render() {
  view.innerHTML = skelForm();
  const [profile, { sessions }] = await Promise.all([api('/account'), api('/account/sessions')]);
  const member = can(user, 'cases.own');
  const openCases = member
    ? (await api('/cases')).cases.filter((c) => c.status !== 'closed')
    : [];
  const themePref = window.__kellyThemePref ? window.__kellyThemePref() : 'auto';

  view.innerHTML = `
    <h1>Your account</h1>
    <div id="msg"></div>

    <div class="card">
      <h3>Profile</h3>
      <p class="small muted">${esc(profile.email)}</p>
      <form id="profile-form">
        <label for="displayName">Display name</label>
        <input id="displayName" type="text" value="${esc(profile.displayName)}" maxlength="80" required>
        <p><button class="btn small" type="submit">Save name</button></p>
      </form>
    </div>

    <div class="card">
      <h3>Appearance</h3>
      <p class="small muted">Applies to this device.</p>
      <span class="seg" id="theme-seg">
        ${THEME_OPTIONS.map(([v, l]) => `<button type="button" data-theme-pref="${v}" class="${themePref === v ? 'on' : ''}">${l}</button>`).join('')}
      </span>
    </div>

    <div class="card">
      <h3>Email notifications</h3>
      <p class="small muted">Case-update emails (never containing case details). In-app notifications stay on. Account emails such as password resets are always sent.</p>
      <p><label class="small"><input id="emailPref" type="checkbox" ${profile.emailNotifications ? 'checked' : ''}> Send me notification emails</label></p>
    </div>

    <div class="card">
      <h3>Security</h3>
      <form id="password-form">
        <label for="currentPassword">Current password</label>
        <input id="currentPassword" type="password" autocomplete="current-password" required>
        <label for="newPassword">New password</label>
        <p class="hint">At least 10 characters. Other devices are signed out when you change it.</p>
        <input id="newPassword" type="password" autocomplete="new-password" minlength="10" required>
        <p><button class="btn small" type="submit">Change password</button></p>
      </form>
      <h4>Active sessions</h4>
      <div class="table-scroll"><table class="data">
        <tr><th>Signed in</th><th>Device</th><th>IP</th><th></th></tr>
        ${sessions.map((s) => `
          <tr>
            <td class="small">${esc(fmtDate(s.createdAt))}</td>
            <td class="small">${esc((s.userAgent || 'unknown').slice(0, 60))}</td>
            <td class="small">${esc(s.ip || '')}</td>
            <td>${s.current ? '<span class="tag role">this device</span>' : ''}</td>
          </tr>`).join('')}
      </table></div>
      ${sessions.length > 1 ? '<p><button class="btn small danger" id="revoke-others">Sign out everywhere else</button></p>' : ''}
    </div>

    ${installPanel({ variant: 'section' })}

    ${member ? `
    <div class="card">
      <h3>Your cases</h3>
      ${openCases.length ? `
      <p class="small muted">Add evidence straight to a case:</p>
      ${openCases.map((c) => `<p class="mt0"><a class="btn small quiet" href="/portal.html#/case/${c.id}/evidence">📎 #${c.id} · ${esc(c.title.slice(0, 48))}</a></p>`).join('')}
      ` : '<p class="muted">You have no open cases. <a href="/portal.html#/new">Start a case</a>.</p>'}
    </div>` : ''}

    ${!member && (can(user, 'cases.review') || can(user, 'users.manage')) ? `
    <div class="card">
      <h3>Quick links</h3>
      ${can(user, 'cases.review') ? '<p class="mt0"><a href="/advisor.html">Advisor dashboard</a></p>' : ''}
      <p class="mt0"><a href="/admin.html">Admin area</a></p>
    </div>` : ''}`;
  enterView(view);

  const msg = el('msg');
  const oops = (err) => { showNotice(msg, 'error', err.message); window.scrollTo(0, 0); };
  wireInstallPanel(() => render());

  el('theme-seg').querySelectorAll('[data-theme-pref]').forEach((b) =>
    b.addEventListener('click', () => {
      window.__kellySetTheme?.(b.dataset.themePref);
      el('theme-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      toast('ok', b.dataset.themePref === 'auto' ? 'Following your device theme.' : `${b.textContent} theme on.`);
    }));

  el('profile-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    setBusy(btn, true);
    api('/account/profile', { method: 'POST', body: { displayName: el('displayName').value } })
      .then(() => { toast('ok', 'Display name updated.'); setBusy(btn, false); })
      .catch((err) => { setBusy(btn, false); oops(err); });
  });

  el('password-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    setBusy(btn, true);
    api('/account/password', {
      method: 'POST',
      body: { currentPassword: el('currentPassword').value, newPassword: el('newPassword').value },
    })
      .then((r) => { toast('ok', r.message); render(); })
      .catch((err) => { setBusy(btn, false); oops(err); });
  });

  el('emailPref').addEventListener('change', () => {
    api('/account/email-notifications', { method: 'POST', body: { enabled: el('emailPref').checked } })
      .then((r) => toast('ok', r.emailNotifications ? 'Notification emails on.' : 'Notification emails off.'))
      .catch(oops);
  });

  el('revoke-others')?.addEventListener('click', (e) => {
    setBusy(e.target, true);
    api('/account/sessions/revoke-others', { method: 'POST' })
      .then((r) => { toast('ok', r.message); render(); })
      .catch((err) => { setBusy(e.target, false); oops(err); });
  });
}

user = await requireUser('account');
if (user) {
  window.addEventListener('kelly-installable', () => render().catch(() => {}));
  window.addEventListener('kelly-installed', () => render().catch(() => {}));
  render().catch((err) => { view.innerHTML = `<div class="notice error">${esc(err.message)}</div>`; });
}
