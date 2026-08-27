import { api, esc, el, fmtDate, requireUser, can, showNotice } from '/common.js';

const view = document.getElementById('view');
let user;

async function render() {
  const [profile, { sessions }] = await Promise.all([api('/account'), api('/account/sessions')]);
  const member = can(user, 'cases.own');
  const openCases = member
    ? (await api('/cases')).cases.filter((c) => c.status !== 'closed')
    : [];

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
      <h3>Change password</h3>
      <form id="password-form">
        <label for="currentPassword">Current password</label>
        <input id="currentPassword" type="password" autocomplete="current-password" required>
        <label for="newPassword">New password</label>
        <p class="hint">At least 10 characters. Other devices are signed out when you change it.</p>
        <input id="newPassword" type="password" autocomplete="new-password" minlength="10" required>
        <p><button class="btn small" type="submit">Change password</button></p>
      </form>
    </div>

    <div class="card">
      <h3>Email notifications</h3>
      <p class="small muted">Case-update emails (never containing case details). In-app notifications stay on. Account emails such as password resets are always sent.</p>
      <p><label class="small"><input id="emailPref" type="checkbox" ${profile.emailNotifications ? 'checked' : ''}> Send me notification emails</label></p>
    </div>

    <div class="card">
      <h3>Active sessions</h3>
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

    ${member ? `
    <div class="card">
      <h3>Submit evidence</h3>
      ${openCases.length ? `
      <p class="hint">Upload documents to one of your open cases and tell Kelly what they show. <strong>Please redact patient-identifiable information first.</strong></p>
      <form id="evidence-form">
        <label for="ev-case">Case</label>
        <select id="ev-case">${openCases.map((c) => `<option value="${c.id}">#${c.id} · ${esc(c.title)}</option>`).join('')}</select>
        <label for="ev-files">Documents (PDF, DOCX or TXT — up to 10 files)</label>
        <input id="ev-files" type="file" accept=".pdf,.docx,.txt" multiple required>
        <label for="ev-statement">What does this evidence show?</label>
        <textarea id="ev-statement" required minlength="10" maxlength="4000"></textarea>
        <p><button class="btn" type="submit">Submit evidence</button></p>
      </form>` : '<p class="muted">You have no open cases. <a href="/portal.html#/new">Start a case</a> first.</p>'}
    </div>` : ''}`;

  const msg = el('msg');
  const oops = (err) => { showNotice(msg, 'error', err.message); window.scrollTo(0, 0); };

  el('profile-form').addEventListener('submit', (e) => {
    e.preventDefault();
    api('/account/profile', { method: 'POST', body: { displayName: el('displayName').value } })
      .then(() => { showNotice(msg, 'ok', 'Display name updated.'); window.scrollTo(0, 0); })
      .catch(oops);
  });

  el('password-form').addEventListener('submit', (e) => {
    e.preventDefault();
    api('/account/password', {
      method: 'POST',
      body: { currentPassword: el('currentPassword').value, newPassword: el('newPassword').value },
    })
      .then((r) => { el('password-form').reset(); showNotice(msg, 'ok', r.message); render(); })
      .catch(oops);
  });

  el('emailPref').addEventListener('change', () => {
    api('/account/email-notifications', { method: 'POST', body: { enabled: el('emailPref').checked } })
      .then((r) => showNotice(msg, 'ok', r.emailNotifications ? 'Notification emails on.' : 'Notification emails off.'))
      .catch(oops);
  });

  el('revoke-others')?.addEventListener('click', () => {
    api('/account/sessions/revoke-others', { method: 'POST' })
      .then((r) => { showNotice(msg, 'ok', r.message); render(); })
      .catch(oops);
  });

  el('evidence-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    const caseId = el('ev-case').value;
    const files = [...el('ev-files').files];
    if (files.length === 0 || files.length > 10) return oops(new Error('Choose between 1 and 10 files.'));
    btn.disabled = true;
    try {
      const documentIds = [];
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        const r = await api(`/cases/${caseId}/documents`, { method: 'POST', formData });
        documentIds.push(r.document.id);
      }
      await api(`/cases/${caseId}/evidence`, {
        method: 'POST',
        body: { statement: el('ev-statement').value, documentIds },
      });
      view.scrollIntoView();
      showNotice(msg, 'ok', 'Evidence submitted.');
      msg.innerHTML += `<p><a class="btn small" href="/portal.html#/case/${esc(caseId)}">View the case</a></p>`;
      e.target.reset();
    } catch (err) {
      oops(err);
    } finally {
      btn.disabled = false;
    }
  });
}

user = await requireUser('account');
if (user) render().catch((err) => { view.innerHTML = `<div class="notice error">${esc(err.message)}</div>`; });
