import { api, esc, escAttr, fmtDate, fmtDay, requireUser, can } from '/common.js';
import { enterView, stagger, setBusy, toast, openSheet, closeSheet, dueChip, emptyState, countUp, skelCases, skelCaseDetail } from '/ui.js';

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

// KELLY-OPS response structure, inserted at the cursor on request.
const RESPONSE_TEMPLATE = `What I understand
•

What matters
•

What to do now
•

What I need from you
•

Important dates
•

Sources
•`;

function errorBox(err) {
  view.innerHTML = `<div class="notice error">${esc(err.message)}</div><p><a href="#/">Back to Today</a></p>`;
}

function setActionBar(on) {
  document.body.classList.toggle('has-actionbar', on);
}

function cardHtml(c, extraClass = '') {
  return `
    <a class="case-card ${extraClass}" href="#/case/${c.id}">
      ${extraClass.includes('next-up') ? '<span class="tag role">Next up</span>' : ''}
      <h3>#${c.id} · ${esc(c.title)}</h3>
      <span class="tag ${escAttr(c.urgency)}">${esc(c.urgency.replace('_', ' '))}</span>
      <span class="tag status">${esc(c.statusLabel)}</span>
      ${c.nextImportantAt ? dueChip(c.nextImportantAt) : ''}
      ${c.openEscalations ? `<span class="tag critical">${c.openEscalations} escalation${c.openEscalations > 1 ? 's' : ''}</span>` : ''}
      <div class="meta">${esc(c.member)}${c.employer ? ` · ${esc(c.employer)}` : ''} · opened ${esc(fmtDay(c.createdAt))}${c.lastMessageBy === 'member' ? ` · <strong>member replied ${esc(fmtDate(c.lastMessageAt))}</strong>` : ''}</div>
    </a>`;
}

// ── Today (KELLY-OPS daily order) ────────────────────────────────────────
function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.round((new Date(`${dateStr}T12:00:00`) - new Date().setHours(12, 0, 0, 0)) / 86400000);
}

async function renderToday() {
  setActionBar(false);
  view.innerHTML = skelCases(3);
  const data = await api('/advisor/queue?view=all');
  const open = data.cases.filter((c) => c.status !== 'closed');
  const used = new Set();
  const take = (predicate, cap = Infinity) => {
    const bucket = open.filter((c) => !used.has(c.id) && predicate(c)).slice(0, cap);
    bucket.forEach((c) => used.add(c.id));
    return bucket;
  };

  const buckets = [
    ['Urgent', take((c) => ['critical', 'high'].includes(c.urgency))],
    ['Important date within 7 days', take((c) => { const d = daysUntil(c.nextImportantAt); return d !== null && d <= 7; })],
    ['Awaiting your review', take((c) => c.status === 'waiting_for_kelly')],
    ['Member replied', take((c) => c.lastMessageBy === 'member')],
    ['Oldest open cases', take(() => true, 5)],
  ];
  let nextUpDone = false;

  view.innerHTML = `
    <h1>Today</h1>
    <p class="muted small">${open.length} open case${open.length === 1 ? '' : 's'} · in the order that protects members best</p>
    ${open.length === 0 ? emptyState({ icon: 'inboxCheck', title: 'All clear', body: 'No open cases right now. New and urgent cases appear here the moment they arrive.' }) : ''}
    ${buckets.map(([label, cases]) => {
      if (cases.length === 0) {
        return `<details class="small muted"><summary>✓ ${label} — none</summary></details>`;
      }
      const cards = cases.map((c) => {
        const cls = !nextUpDone ? 'next-up' : '';
        nextUpDone = true;
        return cardHtml(c, cls);
      }).join('');
      return `<h3>${label} <span class="tag" data-count="${cases.length}">${cases.length}</span></h3><div class="case-list stagger-list">${cards}</div>`;
    }).join('')}
    <p class="small right"><a href="#/queue">Browse the full queue →</a></p>`;
  enterView(view);
  view.querySelectorAll('.stagger-list').forEach((l) => stagger(l, '.case-card'));
  view.querySelectorAll('[data-count]').forEach((elc) => countUp(elc, elc.dataset.count));
}

// ── Queue (browse) ───────────────────────────────────────────────────────
async function renderQueue(which = 'urgent') {
  setActionBar(false);
  view.innerHTML = skelCases(3);
  const data = await api(`/advisor/queue?view=${encodeURIComponent(which)}`);
  view.innerHTML = `
    <h1>Queue</h1>
    <div class="tabs">
      ${VIEWS.map(([id, label]) => `<button data-view="${id}" class="${id === which ? 'active' : ''}">${label} (${data.counts[id] ?? 0})</button>`).join('')}
    </div>
    <div class="case-list" id="queue-list">
      ${data.cases.map((c) => cardHtml(c)).join('') || emptyState({ icon: 'inboxCheck', title: 'Nothing in this view' })}
    </div>`;
  enterView(view);
  stagger(document.getElementById('queue-list'), '.case-card');
  view.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      history.replaceState(null, '', `#/queue/${b.dataset.view}`);
      renderQueue(b.dataset.view).catch(errorBox);
    }));
}

// ── AI brief (labels verbatim) ───────────────────────────────────────────
function briefCard(ai, aiEnabled, id) {
  const reanalyse = `<button class="btn small quiet" type="button" id="reanalyse" ${aiEnabled ? '' : 'disabled title="AI not configured"'}>Re-run AI analysis</button>`;
  if (!ai) return `<div class="card"><h3 class="mt0"><span class="tag ai">AI</span> Case brief</h3><p class="muted">No AI analysis yet.</p><p>${reanalyse}</p></div>`;
  if (!ai.output) return `<div class="card"><h3 class="mt0"><span class="tag ai">AI</span> Case brief</h3><p class="muted">Last analysis failed (${esc(ai.createdAt)}).</p><p>${reanalyse}</p></div>`;
  const o = ai.output;
  const b = o.advisorBrief || {};
  return `
    <div class="card">
      <h3 class="mt0"><span class="tag ai">AI</span> Case brief <span class="muted small">(${esc(ai.model)} · ${esc(ai.promptVersion)} · ${esc(fmtDate(ai.createdAt))})</span></h3>
      ${b.headline ? `<p><strong>${esc(b.headline)}</strong></p>` : ''}
      ${b.memberWants ? `<p><strong>Member wants:</strong> ${esc(b.memberWants)}</p>` : ''}
      ${o.summary ? `<p>${esc(o.summary)}</p>` : ''}
      ${b.keyIssues?.length ? `<h4>Key issues</h4><ul>${b.keyIssues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${b.risks?.length ? `<h4>Risk flags</h4><ul>${b.risks.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${o.missingQuestions?.length ? `<h4>Missing information</h4><ul>${o.missingQuestions.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${b.suggestedNextSteps?.length ? `<h4>Suggested next steps <span class="muted small">(for your judgement)</span></h4><ul>${b.suggestedNextSteps.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${o.uncertainty ? `<p class="small"><strong>Uncertainty:</strong> ${esc(o.uncertainty)}</p>` : ''}
      ${ai.citations?.length ? `<h4>Citations</h4>${ai.citations.map((s) => `<div class="source-item"><span class="kind">${esc(s.source_type.replace('_', ' '))}</span> <strong>${esc(s.title)}</strong> (${esc(s.publisher)}, ${esc(s.version_label)})<br><em>${esc(s.claim)}</em><details><summary class="small">extract</summary><div class="small">${esc(s.chunk_content)}</div></details></div>`).join('')}` : '<p class="small muted">No citations — treat policy statements with extra care.</p>'}
      <p>${reanalyse}</p>
    </div>`;
}

// One-tap transition per current status.
function quickTransition(status) {
  if (status === 'waiting_for_kelly') return { label: 'Take this case', to: 'kelly_reviewing' };
  if (status === 'action_plan_ready' || status === 'ongoing') return { label: 'Close case', to: 'closed' };
  if (status === 'closed') return { label: 'Reopen case', to: 'kelly_reviewing' };
  return null;
}

// ── Case workspace ───────────────────────────────────────────────────────
async function renderCase(id) {
  view.innerHTML = skelCaseDetail();
  const data = await api(`/advisor/cases/${id}`);
  const { case: c, messages, timeline, documents, escalations, ai } = data;
  const openEsc = escalations.filter((e) => !e.resolved_at);

  let lastDay = '';
  const thread = messages.map((m) => {
    const day = fmtDay(m.created_at);
    const divider = day !== lastDay ? `<div class="day-divider">${esc(day)}</div>` : '';
    lastDay = day;
    return `${divider}
      <div class="msg ${m.visibility === 'advisor_private' ? 'private' : m.approved_by ? 'advisor' : 'member'}${m.kind === 'question' ? ' question-msg' : ''}">
        <div class="who">${m.visibility === 'advisor_private' ? '🔒 Private note · ' : ''}${esc(m.author_name || 'System')} · ${esc(fmtDate(m.created_at))}${m.kind === 'action_plan' ? ' · <strong>Action plan</strong>' : ''}${m.kind === 'question' ? ' · <strong>Question to member</strong>' : ''}${m.kind === 'evidence' ? ' · <strong>📎 Evidence</strong>' : ''}</div>
        <div class="body">${esc(m.content)}</div>
        ${m.attachments?.length ? `<ul class="small">${m.attachments.map((a) => `<li><a href="/api/documents/${a.id}/download">${esc(a.filename)}</a></li>`).join('')}</ul>` : ''}
      </div>`;
  }).join('');

  view.innerHTML = `
    <p><a href="#/">&larr; Today</a></p>
    <h1>#${c.id} · ${esc(c.title)}</h1>
    <p>
      <span class="tag ${escAttr(c.urgency)}">${esc(c.urgency.replace('_', ' '))}</span>
      <span class="tag status">${esc(c.statusLabel)}</span>
      <span class="tag">${esc(c.typeLabel)}</span>
      ${c.nextImportantAt ? dueChip(c.nextImportantAt) : ''}
    </p>
    <div id="msg"></div>
    ${openEsc.length ? `<div class="notice warn"><strong>Why this is urgent</strong><ul>${openEsc.map((e) => `<li>${esc(e.reason)} <span class="muted small">(${esc(e.detected_by)}, ${esc(e.severity)})</span> <button class="btn small quiet" data-resolve="${e.id}">Resolve</button></li>`).join('')}</ul></div>` : ''}
    ${c.desiredOutcome ? `<div class="notice info"><strong>Member wants:</strong> ${esc(c.desiredOutcome)}</div>` : ''}
    ${briefCard(ai, data.aiEnabled, c.id)}
    <div class="card">
      <h3 class="mt0">Timeline</h3>
      <div class="timeline">
      ${timeline.map((t) => `
        <div class="timeline-item ${t.confirmed ? 'confirmed' : ''}">
          <span class="date">${t.event_date ? esc(fmtDay(t.event_date)) : '—'}</span>
          <span>${esc(t.description)}
            ${t.confirmed ? '' : `<span class="unconfirmed">unconfirmed (${esc(t.source)})</span>
            <button class="btn small quiet" data-tl-confirm="${t.id}">Confirm</button>
            <button class="btn small quiet" data-tl-remove="${t.id}">Remove</button>`}
          </span>
        </div>`).join('') || '<p class="muted small">No timeline entries.</p>'}
      </div>
    </div>
    <div class="card">
      <h3 class="mt0">Documents</h3>
      <ul>${documents.map((d) => `<li><a href="/api/documents/${d.id}/download">${esc(d.original_filename)}</a> <span class="muted small">(${Math.round(d.size_bytes / 1024)} KB, ${esc(d.status)})</span> <button class="btn small quiet" data-doc-text="${d.id}">View text</button></li>`).join('') || '<li class="muted">None.</li>'}</ul>
      <div id="doc-text"></div>
    </div>
    <div class="card">
      <h3 class="mt0">Member</h3>
      <p>${esc(c.member)} · <a href="mailto:${escAttr(c.memberEmail)}">${esc(c.memberEmail)}</a><br>
      <span class="muted small">Member since ${esc(fmtDay(c.memberSince))}</span>
      ${c.memberPayBand ? `<br><span class="tag">${esc(c.memberPayBand.replace('band_', 'AfC Band ').replace('_', ' '))}</span>` : ''}</p>
      <p><strong>Employer:</strong> ${esc(c.employer || '—')}<br>
      <strong>Role/staff group:</strong> ${esc(c.staffGroup || '—')}<br>
      <strong>Formal steps so far:</strong> ${esc(c.formalStage || '—')}<br>
      <strong>Meeting/deadline stated:</strong> ${esc(c.meetingOrDeadline || '—')}</p>
      <h4>Original account</h4>
      <div class="msg member"><div class="body">${esc(c.whatHappened)}</div></div>
    </div>
    <div class="card">
      <h3 class="mt0">Conversation</h3>
      <div id="thread">${thread || '<p class="muted small">No messages yet.</p>'}</div>
    </div>
    <div class="action-bar">
      ${can(user, 'cases.respond') ? '<button class="btn primary" type="button" id="ab-reply">Reply</button>' : ''}
      ${can(user, 'cases.status') ? '<button class="btn secondary" type="button" id="ab-status">Status</button>' : ''}
      ${can(user, 'cases.notes') ? '<button class="btn quiet" type="button" id="ab-note">🔒 Note</button>' : ''}
    </div>`;
  enterView(view);
  setActionBar(true);

  const msg = document.getElementById('msg');
  const oops = (err) => { msg.innerHTML = `<div class="notice error">${esc(err.message)}</div>`; window.scrollTo(0, 0); };

  view.querySelectorAll('[data-resolve]').forEach((b) =>
    b.addEventListener('click', () =>
      api(`/advisor/cases/${id}/escalations/${b.dataset.resolve}/resolve`, { method: 'POST' })
        .then(() => { toast('ok', 'Escalation resolved.'); renderCase(id); }).catch(oops)));
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
  document.getElementById('reanalyse')?.addEventListener('click', () =>
    api(`/advisor/cases/${id}/reanalyse`, { method: 'POST' })
      .then((r) => toast('ok', r.message))
      .catch(oops));

  // ── Reply sheet ──
  document.getElementById('ab-reply')?.addEventListener('click', () => {
    const body = openSheet('Reply to member', `
      <form id="sheet-reply">
        <label for="reply-kind">Reply as</label>
        <select id="reply-kind">
          <option value="message">Message to member</option>
          <option value="question">Question — needs information from member</option>
          <option value="action_plan">Action plan — reviewed advice</option>
        </select>
        <label for="reply-text">Your reply</label>
        <textarea id="reply-text" required rows="9"></textarea>
        <p><button class="btn small quiet" type="button" id="use-structure">Use structure</button></p>
        <p><button class="btn" type="submit">Send to member</button></p>
        <div id="sheet-msg"></div>
      </form>`);
    body.querySelector('#use-structure').addEventListener('click', () => {
      const ta = body.querySelector('#reply-text');
      ta.setRangeText(RESPONSE_TEMPLATE, ta.selectionStart, ta.selectionEnd, 'end');
      ta.focus();
    });
    body.querySelector('#sheet-reply').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type="submit"]');
      setBusy(btn, true);
      try {
        await api(`/advisor/cases/${id}/reply`, {
          method: 'POST',
          body: { kind: body.querySelector('#reply-kind').value, content: body.querySelector('#reply-text').value },
        });
        closeSheet();
        toast('ok', 'Sent to member.');
        renderCase(id);
      } catch (err) {
        setBusy(btn, false);
        body.querySelector('#sheet-msg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
      }
    });
  });

  // ── Status sheet ──
  document.getElementById('ab-status')?.addEventListener('click', () => {
    const quick = quickTransition(c.status);
    const body = openSheet('Case status', `
      ${quick ? `<p><button class="btn primary" type="button" id="quick-status">${quick.label}</button></p><p class="muted small">or set everything by hand:</p>` : ''}
      <form id="sheet-status">
        <label for="ctl-status">Status</label>
        <select id="ctl-status">${Object.entries(STATUS_OPTIONS).map(([v, l]) => `<option value="${v}" ${v === c.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label for="ctl-urgency">Urgency</label>
        <select id="ctl-urgency">${URGENCY_OPTIONS.map((v) => `<option value="${v}" ${v === c.urgency ? 'selected' : ''}>${v.replace('_', ' ')}</option>`).join('')}</select>
        <label for="ctl-next">Next important date</label>
        <input type="date" id="ctl-next" value="${escAttr(c.nextImportantAt || '')}">
        <p><button class="btn" type="submit">Save</button></p>
        <div id="sheet-msg"></div>
      </form>`);
    const patch = (payload) =>
      api(`/advisor/cases/${id}`, { method: 'PATCH', body: payload })
        .then(() => { closeSheet(); toast('ok', 'Case updated.'); renderCase(id); });
    body.querySelector('#quick-status')?.addEventListener('click', (e) => {
      setBusy(e.target, true);
      patch({ status: quick.to, urgency: c.urgency, nextImportantAt: c.nextImportantAt || '' })
        .catch((err) => { setBusy(e.target, false); body.querySelector('#sheet-msg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`; });
    });
    body.querySelector('#sheet-status').addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type="submit"]');
      setBusy(btn, true);
      patch({
        status: body.querySelector('#ctl-status').value,
        urgency: body.querySelector('#ctl-urgency').value,
        nextImportantAt: body.querySelector('#ctl-next').value,
      }).catch((err) => { setBusy(btn, false); body.querySelector('#sheet-msg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`; });
    });
  });

  // ── Note sheet ──
  document.getElementById('ab-note')?.addEventListener('click', () => {
    const body = openSheet('🔒 Private advisor note', `
      <p class="muted small">Never visible to the member.</p>
      <form id="sheet-note">
        <textarea id="note-text" required rows="6"></textarea>
        <p><button class="btn" type="submit">Save note</button></p>
        <div id="sheet-msg"></div>
      </form>`);
    body.querySelector('#sheet-note').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      setBusy(btn, true);
      try {
        await api(`/advisor/cases/${id}/notes`, { method: 'POST', body: { content: body.querySelector('#note-text').value } });
        closeSheet();
        toast('ok', 'Note saved.');
        renderCase(id);
      } catch (err) {
        setBusy(btn, false);
        body.querySelector('#sheet-msg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
      }
    });
  });
}

// ── Router ───────────────────────────────────────────────────────────────
async function route() {
  const hash = window.location.hash || '#/';
  try {
    const caseMatch = hash.match(/^#\/case\/(\d+)$/);
    const queueMatch = hash.match(/^#\/queue(?:\/(\w+))?$/);
    if (caseMatch) await renderCase(Number(caseMatch[1]));
    else if (hash.startsWith('#/banding')) {
      // Band review workspace: heavy view code loads on demand.
      setActionBar(false);
      view.innerHTML = '<p class="muted">Loading\u2026</p>';
      const m = await import('/banding-advisor.js');
      await m.route(view, user, hash);
    } else if (queueMatch) await renderQueue(queueMatch[1] || 'urgent');
    else await renderToday();
  } catch (err) {
    setActionBar(false);
    errorBox(err);
  }
  window.scrollTo(0, 0);
}

user = await requireUser('advisor', 'cases.review');
if (user) {
  window.addEventListener('hashchange', route);
  route();
}
