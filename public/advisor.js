import { api, esc, fmtDate, fmtDay, requireUser, can } from '/common.js';

const view = document.getElementById('view');
let user;

const VIEWS = [
  ['urgent', 'Urgent'],
  ['awaiting', 'Awaiting review'],
  ['waiting_member', 'Waiting for member'],
  ['action_sent', 'Action sent'],
  ['closed', 'Closed'],
  ['all', 'All'],
];
const STATUS_OPTIONS = {
  gathering: 'Gathering information',
  waiting_for_kelly: 'Waiting for Kelly',
  kelly_reviewing: 'Kelly reviewing',
  need_member_info: 'Need information from member',
  action_plan_ready: 'Action plan ready',
  ongoing: 'Ongoing support',
  closed: 'Closed',
};
const URGENCY_OPTIONS = ['critical', 'high', 'normal', 'self_service'];

function errorBox(err) {
  view.innerHTML = `<div class="notice error">${esc(err.message)}</div><p><a href="#/">Back to queue</a></p>`;
}

async function renderQueue(which = 'urgent') {
  const data = await api(`/advisor/queue?view=${encodeURIComponent(which)}`);
  view.innerHTML = `
    <h1>Advisor dashboard</h1>
    <div class="tabs">
      ${VIEWS.map(([id, label]) => `<button data-view="${id}" class="${id === which ? 'active' : ''}">${label} (${data.counts[id] ?? 0})</button>`).join('')}
    </div>
    <div class="case-list">
      ${data.cases.map((c) => `
        <a class="case-card" href="#/case/${c.id}">
          <h3>#${c.id} · ${esc(c.title)}</h3>
          <span class="tag ${esc(c.urgency)}">${esc(c.urgency.replace('_', ' '))}</span>
          <span class="tag status">${esc(c.statusLabel)}</span>
          <span class="tag">${esc(c.typeLabel)}</span>
          ${c.openEscalations ? `<span class="tag critical">${c.openEscalations} open escalation${c.openEscalations > 1 ? 's' : ''}</span>` : ''}
          <div class="meta">${esc(c.member)}${c.employer ? ` · ${esc(c.employer)}` : ''} · opened ${esc(fmtDate(c.createdAt))}${c.nextImportantAt ? ` · <strong>next date ${esc(fmtDay(c.nextImportantAt))}</strong>` : ''}</div>
        </a>`).join('') || '<div class="card"><p class="muted">Nothing in this view.</p></div>'}
    </div>`;
  view.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => renderQueue(b.dataset.view).catch(errorBox))
  );
}

function briefCard(ai) {
  if (!ai) return '<div class="card"><h3><span class="tag ai">AI</span> Case brief</h3><p class="muted">No AI analysis yet.</p></div>';
  if (!ai.output) return `<div class="card"><h3><span class="tag ai">AI</span> Case brief</h3><p class="muted">Last analysis failed (${esc(ai.createdAt)}).</p></div>`;
  const o = ai.output;
  const b = o.advisorBrief || {};
  return `
    <div class="card">
      <h3><span class="tag ai">AI</span> Case brief <span class="muted small">(${esc(ai.model)} · ${esc(ai.promptVersion)} · ${esc(fmtDate(ai.createdAt))})</span></h3>
      ${b.headline ? `<p><strong>${esc(b.headline)}</strong></p>` : ''}
      ${b.memberWants ? `<p><strong>Member wants:</strong> ${esc(b.memberWants)}</p>` : ''}
      ${o.summary ? `<p>${esc(o.summary)}</p>` : ''}
      ${b.keyIssues?.length ? `<h4>Key issues</h4><ul>${b.keyIssues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${b.risks?.length ? `<h4>Risk flags</h4><ul>${b.risks.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${o.missingQuestions?.length ? `<h4>Missing information</h4><ul>${o.missingQuestions.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${b.suggestedNextSteps?.length ? `<h4>Suggested next steps <span class="muted small">(for your judgement)</span></h4><ul>${b.suggestedNextSteps.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${o.uncertainty ? `<p class="small"><strong>Uncertainty:</strong> ${esc(o.uncertainty)}</p>` : ''}
      ${ai.citations?.length ? `<h4>Citations</h4>${ai.citations.map((s) => `<div class="source-item"><span class="kind">${esc(s.source_type.replace('_', ' '))}</span> <strong>${esc(s.title)}</strong> (${esc(s.publisher)}, ${esc(s.version_label)})<br><em>${esc(s.claim)}</em><details><summary class="small">extract</summary><div class="small">${esc(s.chunk_content)}</div></details></div>`).join('')}` : '<p class="small muted">No citations — treat policy statements with extra care.</p>'}
    </div>`;
}

async function renderCase(id) {
  const data = await api(`/advisor/cases/${id}`);
  const { case: c, messages, timeline, documents, escalations, ai } = data;
  const openEsc = escalations.filter((e) => !e.resolved_at);
  view.innerHTML = `
    <p><a href="#/">&larr; Queue</a></p>
    <h1>#${c.id} · ${esc(c.title)}</h1>
    <p>
      <span class="tag ${esc(c.urgency)}">${esc(c.urgency.replace('_', ' '))}</span>
      <span class="tag status">${esc(c.statusLabel)}</span>
      <span class="tag">${esc(c.typeLabel)}</span>
    </p>
    <div id="msg"></div>
    ${openEsc.length ? `<div class="notice warn"><strong>Why this is urgent</strong><ul>${openEsc.map((e) => `<li>${esc(e.reason)} <span class="muted small">(${esc(e.detected_by)}, ${esc(e.severity)})</span> <button class="btn small quiet" data-resolve="${e.id}">Resolve</button></li>`).join('')}</ul></div>` : ''}

    <div class="grid-2">
      <div>
        <div class="card">
          <h3>Member</h3>
          <p>${esc(c.member)} · <a href="mailto:${esc(c.memberEmail)}">${esc(c.memberEmail)}</a><br>
          <span class="muted small">Member since ${esc(fmtDay(c.memberSince))}</span></p>
          <p><strong>Employer:</strong> ${esc(c.employer || '—')}<br>
          <strong>Role/staff group:</strong> ${esc(c.staffGroup || '—')}<br>
          <strong>Formal steps so far:</strong> ${esc(c.formalStage || '—')}<br>
          <strong>Meeting/deadline stated:</strong> ${esc(c.meetingOrDeadline || '—')}<br>
          <strong>Member wants:</strong> ${esc(c.desiredOutcome || '—')}</p>
          <h4>Original account</h4>
          <div class="msg member"><div class="body">${esc(c.whatHappened)}</div></div>
        </div>

        <div class="card">
          <h3>Case controls</h3>
          <form id="case-controls">
            <label for="ctl-status">Status</label>
            <select id="ctl-status">${Object.entries(STATUS_OPTIONS).map(([v, l]) => `<option value="${v}" ${v === c.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <label for="ctl-urgency">Urgency</label>
            <select id="ctl-urgency">${URGENCY_OPTIONS.map((v) => `<option value="${v}" ${v === c.urgency ? 'selected' : ''}>${v.replace('_', ' ')}</option>`).join('')}</select>
            <label for="ctl-next">Next important date</label>
            <input type="date" id="ctl-next" value="${esc(c.nextImportantAt || '')}">
            <p><button class="btn small" type="submit">Save</button>
            <button class="btn small quiet" type="button" id="reanalyse" ${data.aiEnabled ? '' : 'disabled title="AI not configured"'}>Re-run AI analysis</button></p>
          </form>
        </div>

        <div class="card">
          <h3>Timeline</h3>
          ${timeline.map((t) => `
            <div class="timeline-item">
              <span class="date">${t.event_date ? esc(fmtDay(t.event_date)) : '—'}</span>
              <span>${esc(t.description)}
                ${t.confirmed ? '' : `<span class="unconfirmed">unconfirmed (${esc(t.source)})</span>
                <button class="btn small quiet" data-tl-confirm="${t.id}">Confirm</button>
                <button class="btn small quiet" data-tl-remove="${t.id}">Remove</button>`}
              </span>
            </div>`).join('') || '<p class="muted">No timeline entries.</p>'}
        </div>

        <div class="card">
          <h3>Documents</h3>
          <ul>${documents.map((d) => `<li><a href="/api/documents/${d.id}/download">${esc(d.original_filename)}</a> <span class="muted small">(${Math.round(d.size_bytes / 1024)} KB, ${esc(d.status)})</span> <button class="btn small quiet" data-doc-text="${d.id}">View text</button></li>`).join('') || '<li class="muted">None.</li>'}</ul>
          <div id="doc-text"></div>
        </div>
      </div>

      <div>
        ${briefCard(ai)}
        <div class="card">
          <h3>Conversation</h3>
          <div id="thread">
            ${messages.map((m) => `
              <div class="msg ${m.visibility === 'advisor_private' ? 'private' : m.approved_by ? 'advisor' : 'member'}">
                <div class="who">${m.visibility === 'advisor_private' ? '🔒 Private note · ' : ''}${esc(m.author_name || 'System')} · ${esc(fmtDate(m.created_at))}${m.kind === 'action_plan' ? ' · <strong>Action plan</strong>' : ''}${m.kind === 'question' ? ' · <strong>Question to member</strong>' : ''}${m.kind === 'evidence' ? ' · <strong>📎 Evidence</strong>' : ''}</div>
                <div class="body">${esc(m.content)}</div>
                ${m.attachments?.length ? `<ul class="small">${m.attachments.map((a) => `<li><a href="/api/documents/${a.id}/download">${esc(a.filename)}</a></li>`).join('')}</ul>` : ''}
              </div>`).join('')}
          </div>
          ${can(user, 'cases.respond') ? `
          <form id="reply-form">
            <label for="reply-kind">Reply as</label>
            <select id="reply-kind">
              <option value="message">Message to member</option>
              <option value="question">Question — needs information from member</option>
              <option value="action_plan">Action plan — reviewed advice</option>
            </select>
            <textarea id="reply" required placeholder="What I understand… What matters… What to do now… What I need from you… Important dates… Sources…"></textarea>
            <p><button class="btn" type="submit">Send to member</button></p>
          </form>` : ''}
          ${can(user, 'cases.notes') ? `
          <form id="note-form">
            <label for="note">🔒 Private advisor note <span class="muted small">(never visible to member)</span></label>
            <textarea id="note" required></textarea>
            <p><button class="btn quiet" type="submit">Save note</button></p>
          </form>` : ''}
        </div>
      </div>
    </div>`;

  const msg = document.getElementById('msg');
  const oops = (err) => { msg.innerHTML = `<div class="notice error">${esc(err.message)}</div>`; window.scrollTo(0, 0); };

  view.querySelectorAll('[data-resolve]').forEach((b) =>
    b.addEventListener('click', () =>
      api(`/advisor/cases/${id}/escalations/${b.dataset.resolve}/resolve`, { method: 'POST' }).then(() => renderCase(id)).catch(oops)));
  view.querySelectorAll('[data-tl-confirm]').forEach((b) =>
    b.addEventListener('click', () =>
      api(`/advisor/timeline/${b.dataset.tlConfirm}`, { method: 'PATCH', body: { action: 'confirm' } }).then(() => renderCase(id)).catch(oops)));
  view.querySelectorAll('[data-tl-remove]').forEach((b) =>
    b.addEventListener('click', () =>
      api(`/advisor/timeline/${b.dataset.tlRemove}`, { method: 'PATCH', body: { action: 'remove' } }).then(() => renderCase(id)).catch(oops)));
  view.querySelectorAll('[data-doc-text]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        const t = await api(`/documents/${b.dataset.docText}/text`);
        document.getElementById('doc-text').innerHTML =
          `<h4>${esc(t.filename)}</h4><div class="msg system"><div class="body">${esc(t.text || '(no text extracted)')}</div></div>`;
      } catch (err) { oops(err); }
    }));

  document.getElementById('case-controls')?.addEventListener('submit', (e) => {
    e.preventDefault();
    api(`/advisor/cases/${id}`, {
      method: 'PATCH',
      body: {
        status: document.getElementById('ctl-status').value,
        urgency: document.getElementById('ctl-urgency').value,
        nextImportantAt: document.getElementById('ctl-next').value,
      },
    }).then(() => renderCase(id)).catch(oops);
  });
  document.getElementById('reanalyse')?.addEventListener('click', () =>
    api(`/advisor/cases/${id}/reanalyse`, { method: 'POST' })
      .then((r) => { msg.innerHTML = `<div class="notice ok">${esc(r.message)}</div>`; })
      .catch(oops));
  document.getElementById('reply-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    api(`/advisor/cases/${id}/reply`, {
      method: 'POST',
      body: { kind: document.getElementById('reply-kind').value, content: document.getElementById('reply').value },
    }).then(() => renderCase(id)).catch(oops);
  });
  document.getElementById('note-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    api(`/advisor/cases/${id}/notes`, { method: 'POST', body: { content: document.getElementById('note').value } })
      .then(() => renderCase(id)).catch(oops);
  });
}

async function route() {
  const hash = window.location.hash || '#/';
  try {
    const caseMatch = hash.match(/^#\/case\/(\d+)$/);
    if (caseMatch) await renderCase(Number(caseMatch[1]));
    else await renderQueue();
  } catch (err) {
    errorBox(err);
  }
  window.scrollTo(0, 0);
}

user = await requireUser('advisor', 'cases.review');
if (user) {
  window.addEventListener('hashchange', route);
  route();
}
