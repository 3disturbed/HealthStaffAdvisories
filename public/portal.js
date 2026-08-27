import { api, esc, fmtDate, fmtDay, requireUser } from '/common.js';

const view = document.getElementById('view');
let user;

const CASE_TYPE_OPTIONS = {
  disciplinary: 'Disciplinary / investigation',
  grievance: 'Grievance / bullying / harassment',
  sickness: 'Sickness / absence / adjustments',
  pay: 'Pay / banding / hours / leave',
  flexible: 'Flexible working / family leave',
  speaking_up: 'Speaking up / patient safety',
  contract: 'Contract / employment status',
  dismissal: 'Dismissal / redundancy',
  other: 'Something else',
};

function errorBox(err) {
  view.innerHTML = `<div class="notice error">${esc(err.message)}</div><p><a href="#/">Back to my cases</a></p>`;
}

async function renderDashboard() {
  const [{ cases }, notif] = await Promise.all([api('/cases'), api('/notifications')]);
  const unread = notif.notifications.filter((n) => !n.read_at);
  view.innerHTML = `
    <h1>My cases</h1>
    ${unread.length ? `<div class="notice info" id="notif-box">${unread.map((n) => `<div><strong>${esc(n.title)}</strong> <span class="muted small">${esc(fmtDate(n.created_at))}</span></div>`).join('')}</div>` : ''}
    <p><a class="btn" href="#/new">Start a case</a></p>
    <div class="case-list">
      ${cases.map((c) => `
        <a class="case-card" href="#/case/${c.id}">
          <h3>${esc(c.title)}</h3>
          <span class="tag ${esc(c.urgency)}">${esc(c.urgency.replace('_', ' '))}</span>
          <span class="tag status">${esc(c.statusLabel)}</span>
          <span class="tag">${esc(c.typeLabel)}</span>
          <div class="meta">Updated ${esc(fmtDate(c.updated_at))}${c.next_important_at ? ` · Next important date: ${esc(fmtDay(c.next_important_at))}` : ''}</div>
        </a>`).join('') || '<div class="card"><p>No cases yet. When something happens at work, start a case and we’ll help you make sense of it.</p></div>'}
    </div>`;
  if (unread.length) api('/notifications/read', { method: 'POST' }).catch(() => {});
}

function renderNewCase() {
  view.innerHTML = `
    <h1>Start a case</h1>
    <div class="card">
      <div id="msg"></div>
      <form id="new-case">
        <label for="whatHappened">What happened?</label>
        <p class="hint">In your own words. Include what was said or received, and roughly when. <strong>Please avoid patient-identifiable information</strong> — redact patient names/details unless genuinely necessary.</p>
        <textarea id="whatHappened" required minlength="10"></textarea>
        <label for="caseType">What kind of issue is this?</label>
        <select id="caseType">${Object.entries(CASE_TYPE_OPTIONS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <label for="employer">Employer / NHS organisation</label>
        <input id="employer" type="text">
        <label for="staffGroup">Your role / staff group</label>
        <input id="staffGroup" type="text" placeholder="e.g. Band 5 nurse, HCA, AHP">
        <label for="formalStage">Has anything already happened formally?</label>
        <p class="hint">e.g. an investigation opened, a letter received, a warning given — or "nothing formal yet".</p>
        <input id="formalStage" type="text">
        <label for="meetingOrDeadline">Is there a meeting, hearing or deadline?</label>
        <p class="hint">If yes, tell us the date — this matters for urgency.</p>
        <input id="meetingOrDeadline" type="text">
        <label for="desiredOutcome">What would you like to happen?</label>
        <input id="desiredOutcome" type="text">
        <p><button class="btn" type="submit">Create case</button> <a class="btn quiet" href="#/">Cancel</a></p>
      </form>
    </div>`;
  document.getElementById('new-case').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const data = await api('/cases', {
        method: 'POST',
        body: {
          whatHappened: document.getElementById('whatHappened').value,
          caseType: document.getElementById('caseType').value,
          employer: document.getElementById('employer').value,
          staffGroup: document.getElementById('staffGroup').value,
          formalStage: document.getElementById('formalStage').value,
          meetingOrDeadline: document.getElementById('meetingOrDeadline').value,
          desiredOutcome: document.getElementById('desiredOutcome').value,
        },
      });
      window.location.hash = `#/case/${data.caseId}`;
    } catch (err) {
      btn.disabled = false;
      document.getElementById('msg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    }
  });
}

function intakeCard(intake) {
  if (!intake) return `
    <div class="card"><h3><span class="tag ai">AI</span> Making sense of your case</h3>
    <p class="muted" id="intake-pending">If AI assistance is enabled, an initial explanation appears here shortly — refresh in a few seconds. Kelly reviews anything important either way.</p></div>`;
  return `
    <div class="card">
      <h3><span class="tag ai">AI</span> What this appears to be</h3>
      <p class="small muted">AI assistance, not legal advice, and not yet reviewed by Kelly unless marked. Generated ${esc(fmtDate(intake.generatedAt))}.</p>
      <div class="msg system"><div class="body">${esc(intake.explanation)}</div></div>
      ${intake.uncertainty ? `<p class="small"><strong>What is unclear:</strong> ${esc(intake.uncertainty)}</p>` : ''}
      ${intake.missingQuestions?.length ? `<h4>Questions that would help</h4><ul>${intake.missingQuestions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
      ${intake.importantDates?.length ? `<h4>Possible important dates</h4><ul>${intake.importantDates.map((d) => `<li>${d.date ? `<strong>${esc(fmtDay(d.date))}</strong> — ` : ''}${esc(d.event)} <span class="tag high">potential — verify</span></li>`).join('')}</ul>` : ''}
      ${intake.sources?.length ? `<h4>Sources used</h4>${intake.sources.map((s) => `<div class="source-item"><span class="kind">${esc(s.sourceType.replace('_', ' '))}</span><br>${esc(s.title)} — ${esc(s.publisher)} (${esc(s.version)})${s.url ? ` · <a href="${esc(s.url)}" rel="noopener" target="_blank">source</a>` : ''}</div>`).join('')}` : '<p class="small muted">No knowledge sources matched this case yet.</p>'}
    </div>`;
}

async function renderCase(id, { silent = false } = {}) {
  const data = await api(`/cases/${id}`);
  const { case: c, messages, documents, escalations, intake } = data;
  view.innerHTML = `
    <p><a href="#/">&larr; My cases</a></p>
    <h1>${esc(c.title)}</h1>
    <p>
      <span class="tag ${esc(c.urgency)}">${esc(c.urgency.replace('_', ' '))}</span>
      <span class="tag status">${esc(c.statusLabel)}</span>
      <span class="tag">${esc(c.typeLabel)}</span>
    </p>
    ${escalations.length ? `<div class="notice warn"><strong>This case is being treated as a priority.</strong><br>${escalations.map((e) => esc(e.reason)).join('; ')}. If a deadline is imminent, see <a href="/emergency.html">urgent help</a> — do not rely on the portal alone.</div>` : ''}
    <div id="msg"></div>
    ${intakeCard(intake)}
    <div class="card">
      <h3>Conversation</h3>
      <div id="thread">
        ${messages.map((m) => `
          <div class="msg ${m.author_user_id === user.id ? 'member' : 'advisor'}">
            <div class="who">${esc(m.author_name || 'Kelly Online')} · ${esc(fmtDate(m.created_at))}${m.kind === 'action_plan' ? ' · <strong>Action plan</strong>' : ''}${m.kind === 'question' ? ' · <strong>Question for you</strong>' : ''}${m.kind === 'evidence' ? ' · <strong>📎 Evidence</strong>' : ''}</div>
            <div class="body">${esc(m.content)}</div>
            ${m.attachments?.length ? `<ul class="small">${m.attachments.map((a) => `<li><a href="/api/documents/${a.id}/download">${esc(a.filename)}</a></li>`).join('')}</ul>` : ''}
          </div>`).join('')}
      </div>
      ${c.status !== 'closed' ? `
      <form id="reply-form">
        <label for="reply">Add to your case</label>
        <textarea id="reply" required></textarea>
        <p><button class="btn" type="submit">Send</button>
        ${['gathering', 'need_member_info'].includes(c.status) ? '<button class="btn secondary" type="button" id="request-review">Ask Kelly to review</button>' : ''}</p>
      </form>` : '<p class="muted">This case is closed. Kelly can reopen it if needed.</p>'}
    </div>
    <div class="card">
      <h3>Documents</h3>
      <ul>${documents.map((d) => `<li><a href="/api/documents/${d.id}/download">${esc(d.original_filename)}</a> <span class="muted small">(${Math.round(d.size_bytes / 1024)} KB${d.status === 'extraction_failed' ? ', text could not be read' : ''})</span></li>`).join('') || '<li class="muted">None yet.</li>'}</ul>
      ${c.status !== 'closed' ? `
      <form id="upload-form">
        <p class="hint">PDF, Word (.docx) or plain text, up to 15 MB. Please redact patient-identifiable information first.</p>
        <input type="file" id="file" accept=".pdf,.docx,.txt" required>
        <p><button class="btn quiet" type="submit">Upload</button></p>
      </form>` : ''}
    </div>`;

  const msg = document.getElementById('msg');
  document.getElementById('reply-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/cases/${id}/messages`, { method: 'POST', body: { content: document.getElementById('reply').value } });
      renderCase(id);
    } catch (err) { msg.innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
  });
  document.getElementById('request-review')?.addEventListener('click', async () => {
    try {
      await api(`/cases/${id}/request-review`, { method: 'POST' });
      renderCase(id);
    } catch (err) { msg.innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
  });
  document.getElementById('upload-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fileInput = document.getElementById('file');
    if (!fileInput.files[0]) return;
    const formData = new FormData();
    formData.append('file', fileInput.files[0]);
    try {
      await api(`/cases/${id}/documents`, { method: 'POST', formData });
      renderCase(id);
    } catch (err) { msg.innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
  });

  // If intake has not arrived yet, poll a few times.
  if (!intake && !silent) {
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      if (tries > 8 || window.location.hash !== `#/case/${id}`) return clearInterval(timer);
      const fresh = await api(`/cases/${id}`).catch(() => null);
      if (fresh?.intake) {
        clearInterval(timer);
        if (window.location.hash === `#/case/${id}`) renderCase(id, { silent: true });
      }
    }, 4000);
  }
}

async function route() {
  const hash = window.location.hash || '#/';
  try {
    const caseMatch = hash.match(/^#\/case\/(\d+)$/);
    if (hash === '#/new') renderNewCase();
    else if (caseMatch) await renderCase(Number(caseMatch[1]));
    else await renderDashboard();
  } catch (err) {
    errorBox(err);
  }
  window.scrollTo(0, 0);
}

user = await requireUser('portal', 'cases.own');
if (user) {
  window.addEventListener('hashchange', route);
  route();
}
