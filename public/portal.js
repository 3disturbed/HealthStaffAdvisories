import { api, esc, fmtDate, fmtDay, requireUser } from '/common.js';
import { installPanel, wireInstallPanel } from '/install-ui.js';
import { enterView, stagger, setBusy, toast, openSheet, closeSheet, dueChip, emptyState, skelCases, skelCaseDetail } from '/ui.js';

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

// What the member should understand is happening right now.
const NEXT_STEP_TEXT = {
  gathering: 'We are gathering the details. Add anything that helps, or ask Kelly to review when you are ready.',
  waiting_for_kelly: 'Your case is in Kelly’s queue. She will reply here — you don’t need to do anything.',
  kelly_reviewing: 'Kelly is looking at your case right now.',
  need_member_info: 'Kelly has asked you a question — your reply moves things forward.',
  action_plan_ready: 'Your action plan is ready. Read it below and reply if anything is unclear.',
  ongoing: 'Kelly is keeping this case open and checking in.',
  closed: 'This case is closed. Kelly can reopen it if anything changes.',
};

const JOURNEY_LABELS = ['Received', 'Understanding', 'With Kelly', 'Action plan'];

function journeyPosition(status, hasIntake) {
  if (status === 'closed') return 5; // everything complete
  if (status === 'action_plan_ready' || status === 'ongoing') return 4;
  if (['waiting_for_kelly', 'kelly_reviewing', 'need_member_info'].includes(status)) return 3;
  return hasIntake ? 2 : 1;
}

function journeyStepper(status, hasIntake) {
  const pos = journeyPosition(status, hasIntake);
  return `<div class="journey" role="img" aria-label="Case progress: step ${Math.min(pos, 4)} of 4">
    ${JOURNEY_LABELS.map((label, i) => {
      const step = i + 1;
      const cls = step < pos ? 'done' : step === pos ? 'active' : '';
      return `<div class="journey-step ${cls}"><span class="journey-dot"></span><span class="journey-label">${label}</span></div>`;
    }).join('')}
  </div>`;
}

function errorBox(err) {
  view.innerHTML = `<div class="notice error">${esc(err.message)}</div><p><a href="#/">Back to home</a></p>`;
}

const URGENCY_RANK = { critical: 0, high: 1, normal: 2, self_service: 3 };
function pickPrimaryCase(cases) {
  return [...cases]
    .filter((c) => c.status !== 'closed')
    .sort((a, b) =>
      (URGENCY_RANK[a.urgency] ?? 9) - (URGENCY_RANK[b.urgency] ?? 9) ||
      (a.next_important_at || '9999').localeCompare(b.next_important_at || '9999') ||
      (b.updated_at || '').localeCompare(a.updated_at || ''))[0] || null;
}

function greeting() {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const first = (user.displayName || '').split(' ')[0];
  return `${part}${first ? `, ${esc(first)}` : ''}`;
}

// ── Home ─────────────────────────────────────────────────────────────────
async function renderHome() {
  view.innerHTML = skelCases(2);
  const { cases } = await api('/cases');
  const primary = pickPrimaryCase(cases);
  const open = cases.filter((c) => c.status !== 'closed');

  view.innerHTML = `
    <p class="greeting">${greeting()}</p>
    ${primary ? `
      <a class="case-card next-up" href="#/case/${primary.id}">
        <h3>${esc(primary.title)}</h3>
        ${journeyStepper(primary.status, true)}
        <p class="small">${esc(NEXT_STEP_TEXT[primary.status] || primary.statusLabel)}</p>
        <p class="mt0">
          <span class="tag ${esc(primary.urgency)}">${esc(primary.urgency.replace('_', ' '))}</span>
          <span class="tag status">${esc(primary.statusLabel)}</span>
          ${primary.next_important_at ? dueChip(primary.next_important_at) : ''}
        </p>
        ${primary.status === 'need_member_info' ? '<p class="mt0"><span class="btn small primary">Reply to Kelly</span></p>' : ''}
      </a>` : ''}
    <div class="big-actions">
      <a class="btn" href="#/new">Start a case</a>
      ${open.length ? `<button class="btn secondary" type="button" id="quick-evidence">Add evidence</button>` : '<a class="btn secondary" href="#/cases">My cases</a>'}
    </div>
    ${installPanel({ variant: 'card' })}
    ${cases.length === 0 ? emptyState({
      icon: 'folderPlus',
      title: 'No cases yet',
      body: 'When something happens at work, start a case and we’ll help you make sense of it — in plain English, with Kelly behind it.',
      actionHref: '#/new', actionLabel: 'Start your first case',
    }) : cases.length > (primary ? 1 : 0) ? `<p class="small right"><a href="#/cases">All my cases (${cases.length}) →</a></p>` : ''}
  `;
  enterView(view);
  wireInstallPanel(() => renderHome());
  document.getElementById('quick-evidence')?.addEventListener('click', () => {
    if (open.length === 1) openEvidenceSheet(open[0].id);
    else window.location.hash = '#/cases';
  });
}

// ── Case list ────────────────────────────────────────────────────────────
async function renderCaseList() {
  view.innerHTML = skelCases(3);
  const { cases } = await api('/cases');
  view.innerHTML = `
    <h1>My cases</h1>
    <p><a class="btn" href="#/new">Start a case</a></p>
    <div class="case-list" id="case-list">
      ${cases.map((c) => `
        <a class="case-card" href="#/case/${c.id}">
          <h3>${esc(c.title)}</h3>
          <span class="tag ${esc(c.urgency)}">${esc(c.urgency.replace('_', ' '))}</span>
          <span class="tag status">${esc(c.statusLabel)}</span>
          <span class="tag">${esc(c.typeLabel)}</span>
          ${c.next_important_at ? dueChip(c.next_important_at) : ''}
          <div class="meta">Updated ${esc(fmtDate(c.updated_at))}</div>
        </a>`).join('') || emptyState({
          icon: 'folderPlus', title: 'No cases yet',
          body: 'Start a case and we’ll help you make sense of what’s happening.',
          actionHref: '#/new', actionLabel: 'Start a case',
        })}
    </div>`;
  enterView(view);
  stagger(document.getElementById('case-list'), '.case-card');
}

// ── Guided case wizard ───────────────────────────────────────────────────
const WIZ_KEY = 'kelly-wizard';
const emptyWizard = () => ({ step: 1, whatHappened: '', caseType: '', employer: '', staffGroup: '', formalStage: '', meetingOrDeadline: '', desiredOutcome: '' });
let wiz = emptyWizard();
try { wiz = { ...emptyWizard(), ...JSON.parse(sessionStorage.getItem(WIZ_KEY) || '{}') }; } catch { /* fresh */ }

function saveWiz() {
  try { sessionStorage.setItem(WIZ_KEY, JSON.stringify(wiz)); } catch { /* private mode */ }
}
function clearWiz() {
  wiz = emptyWizard();
  try { sessionStorage.removeItem(WIZ_KEY); } catch { /* ignore */ }
}

const WIZ_STEPS = [
  {
    title: 'What happened?',
    hint: 'In your own words. Include what was said or received, and roughly when. <strong>Please avoid patient-identifiable information</strong> — redact patient names/details unless genuinely necessary.',
    required: true,
    body: () => `<textarea id="wiz-input" required minlength="10" placeholder="Start anywhere — we’ll make sense of it together.">${esc(wiz.whatHappened)}</textarea>`,
    collect: () => { wiz.whatHappened = document.getElementById('wiz-input').value; return wiz.whatHappened.trim().length >= 10; },
    error: 'Please tell us what happened in a sentence or two.',
  },
  {
    title: 'What kind of issue is this?',
    hint: 'Best guess is fine — Kelly checks this.',
    body: () => `<div class="option-grid">${Object.entries(CASE_TYPE_OPTIONS).map(([v, l]) =>
      `<button type="button" class="option-card ${wiz.caseType === v ? 'on' : ''}" data-type="${v}">${l}</button>`).join('')}</div>`,
    wire: (next) => document.querySelectorAll('[data-type]').forEach((b) =>
      b.addEventListener('click', () => { wiz.caseType = b.dataset.type; saveWiz(); next(); })),
    collect: () => true,
    hideContinue: true,
  },
  {
    title: 'Where do you work?',
    hint: 'Employer and your role — this helps us find the right policies.',
    body: () => `
      <label for="wiz-employer">Employer / NHS organisation</label>
      <input id="wiz-employer" type="text" value="${esc(wiz.employer)}">
      <label for="wiz-staff">Your role / staff group</label>
      <input id="wiz-staff" type="text" placeholder="e.g. Band 5 nurse, HCA, AHP" value="${esc(wiz.staffGroup)}">`,
    collect: () => {
      wiz.employer = document.getElementById('wiz-employer').value;
      wiz.staffGroup = document.getElementById('wiz-staff').value;
      return true;
    },
    skippable: true,
  },
  {
    title: 'Has anything already happened formally?',
    hint: 'e.g. an investigation opened, a letter received, a warning given — or “nothing formal yet”.',
    body: () => `<input id="wiz-input" type="text" value="${esc(wiz.formalStage)}">`,
    collect: () => { wiz.formalStage = document.getElementById('wiz-input').value; return true; },
    skippable: true,
  },
  {
    title: 'Is there a meeting, hearing or deadline?',
    hint: 'If yes, tell us the date — this matters for urgency.',
    body: () => `<input id="wiz-input" type="text" value="${esc(wiz.meetingOrDeadline)}">`,
    collect: () => { wiz.meetingOrDeadline = document.getElementById('wiz-input').value; return true; },
    skippable: true,
  },
  {
    title: 'What would you like to happen?',
    hint: 'Your ideal outcome — it guides Kelly’s advice.',
    body: () => `<input id="wiz-input" type="text" value="${esc(wiz.desiredOutcome)}">`,
    collect: () => { wiz.desiredOutcome = document.getElementById('wiz-input').value; return true; },
    skippable: true,
  },
  {
    title: 'Check and send',
    hint: 'You can change anything before it goes to us.',
    review: true,
    body: () => {
      const rows = [
        ['What happened', wiz.whatHappened, 1],
        ['Type of issue', CASE_TYPE_OPTIONS[wiz.caseType] || 'Not sure yet', 2],
        ['Employer & role', [wiz.employer, wiz.staffGroup].filter(Boolean).join(' · ') || '—', 3],
        ['Formal steps so far', wiz.formalStage || '—', 4],
        ['Meeting / deadline', wiz.meetingOrDeadline || '—', 5],
        ['What you want', wiz.desiredOutcome || '—', 6],
      ];
      return rows.map(([label, value, step]) => `
        <div class="perm-item">
          <div class="perm-head"><strong>${label}</strong>
            <button class="btn small quiet" type="button" data-goto="${step}">Edit</button></div>
          <div class="small muted">${esc(String(value).slice(0, 300))}</div>
        </div>`).join('');
    },
    collect: () => true,
  },
];

function renderWizard() {
  const total = WIZ_STEPS.length;
  const step = Math.min(Math.max(wiz.step, 1), total);
  const def = WIZ_STEPS[step - 1];

  view.innerHTML = `
    <h1>Start a case</h1>
    <p class="muted small">Step ${step} of ${total}</p>
    <div class="wiz-progress"><div class="wiz-progress-fill" id="wiz-fill"></div></div>
    <div class="card" id="wiz-card">
      <h3 class="mt0">${def.title}</h3>
      ${def.hint ? `<p class="hint">${def.hint}</p>` : ''}
      <div id="msg"></div>
      <form id="wiz-form">${def.body()}
        <p>
          ${step > 1 ? '<button class="btn quiet" type="button" id="wiz-back">Back</button>' : '<a class="btn quiet" href="#/">Cancel</a>'}
          ${def.hideContinue ? '' : def.review
            ? '<button class="btn" type="submit" id="wiz-submit">Create case</button>'
            : `<button class="btn" type="submit">Continue</button>${def.skippable ? '<button class="btn quiet" type="button" id="wiz-skip">Skip for now</button>' : ''}`}
        </p>
      </form>
    </div>`;
  requestAnimationFrame(() => {
    const fill = document.getElementById('wiz-fill');
    if (fill) fill.style.transform = `scaleX(${step / total})`;
  });
  enterView(document.getElementById('wiz-card'));

  const go = (n) => { wiz.step = n; saveWiz(); renderWizard(); };
  document.getElementById('wiz-back')?.addEventListener('click', () => { def.collect?.(); saveWiz(); go(step - 1); });
  document.getElementById('wiz-skip')?.addEventListener('click', () => go(step + 1));
  def.wire?.(() => go(step + 1));
  view.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.goto))));

  document.getElementById('wiz-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!def.collect()) {
      document.getElementById('msg').innerHTML = `<div class="notice error">${esc(def.error || 'Please check this step.')}</div>`;
      return;
    }
    saveWiz();
    if (!def.review) return go(step + 1);

    const btn = document.getElementById('wiz-submit');
    setBusy(btn, true);
    try {
      const data = await api('/cases', {
        method: 'POST',
        body: {
          whatHappened: wiz.whatHappened,
          caseType: wiz.caseType || 'other',
          employer: wiz.employer,
          staffGroup: wiz.staffGroup,
          formalStage: wiz.formalStage,
          meetingOrDeadline: wiz.meetingOrDeadline,
          desiredOutcome: wiz.desiredOutcome,
        },
      });
      clearWiz();
      if (data.urgent) {
        view.innerHTML = `
          <div class="card anim-page-enter">
            <h2 class="mt0">We’re treating this as a priority</h2>
            <p>What you’ve described has been placed in Kelly’s urgent queue. If a deadline is very close, also see <a href="/emergency.html">urgent help</a> — do not rely on the portal alone.</p>
            <p><a class="btn" href="#/case/${data.caseId}">Open my case</a></p>
          </div>`;
      } else {
        window.location.hash = `#/case/${data.caseId}`;
      }
    } catch (err) {
      setBusy(btn, false);
      document.getElementById('msg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    }
  });
}

// ── AI intake card (labels verbatim) ────────────────────────────────────
function intakeCard(intake) {
  if (!intake) return `
    <div class="card"><h3 class="mt0"><span class="tag ai">AI</span> Making sense of your case</h3>
    <p class="muted small" id="intake-pending">If AI assistance is enabled, an initial explanation appears here shortly — refresh in a few seconds. Kelly reviews anything important either way.</p></div>`;
  return `
    <details class="card">
      <summary><span class="tag ai">AI</span> <strong>What this appears to be</strong> <span class="muted small">(tap to read)</span></summary>
      <p class="small muted">AI assistance, not legal advice, and not yet reviewed by Kelly unless marked. Generated ${esc(fmtDate(intake.generatedAt))}.</p>
      <div class="msg system"><div class="body">${esc(intake.explanation)}</div></div>
      ${intake.uncertainty ? `<p class="small"><strong>What is unclear:</strong> ${esc(intake.uncertainty)}</p>` : ''}
      ${intake.missingQuestions?.length ? `<h4>Questions that would help</h4><ul>${intake.missingQuestions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
      ${intake.importantDates?.length ? `<h4>Possible important dates</h4><ul>${intake.importantDates.map((d) => `<li>${d.date ? `<strong>${esc(fmtDay(d.date))}</strong> — ` : ''}${esc(d.event)} <span class="tag high">potential — verify</span></li>`).join('')}</ul>` : ''}
      ${intake.sources?.length ? `<h4>Sources used</h4>${intake.sources.map((s) => `<div class="source-item"><span class="kind">${esc(s.sourceType.replace('_', ' '))}</span><br>${esc(s.title)} — ${esc(s.publisher)} (${esc(s.version)})${s.url ? ` · <a href="${esc(s.url)}" rel="noopener" target="_blank">source</a>` : ''}</div>`).join('')}` : '<p class="small muted">No knowledge sources matched this case yet.</p>'}
    </details>`;
}

// ── Evidence sheet ───────────────────────────────────────────────────────
function openEvidenceSheet(caseId) {
  const body = openSheet('Add evidence', `
    <p class="hint">Upload documents and tell Kelly what they show. <strong>Please redact patient-identifiable information first.</strong></p>
    <form id="ev-form">
      <label for="ev-files">Documents (PDF, DOCX or TXT — up to 10 files)</label>
      <input id="ev-files" type="file" accept=".pdf,.docx,.txt" multiple required>
      <label for="ev-statement">What does this evidence show?</label>
      <textarea id="ev-statement" required minlength="10" maxlength="4000"></textarea>
      <p><button class="btn" type="submit">Submit evidence</button></p>
      <div id="ev-msg"></div>
    </form>`);
  body.querySelector('#ev-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    const files = [...body.querySelector('#ev-files').files];
    if (files.length === 0 || files.length > 10) {
      body.querySelector('#ev-msg').innerHTML = '<div class="notice error">Choose between 1 and 10 files.</div>';
      return;
    }
    setBusy(btn, true);
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
        body: { statement: body.querySelector('#ev-statement').value, documentIds },
      });
      closeSheet();
      toast('ok', 'Evidence submitted — Kelly will see it on your case.');
      if (window.location.hash === `#/case/${caseId}`) renderCase(caseId, { silent: true });
      else window.location.hash = `#/case/${caseId}`;
    } catch (err) {
      setBusy(btn, false);
      body.querySelector('#ev-msg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    }
  });
}

// ── Case view ────────────────────────────────────────────────────────────
async function renderCase(id, { silent = false } = {}) {
  if (!silent) view.innerHTML = skelCaseDetail();
  const data = await api(`/cases/${id}`);
  const { case: c, messages, timeline, documents, escalations, intake } = data;

  const datedTimeline = timeline.filter((t) => t.event_date);
  let lastDay = '';
  const thread = messages.map((m) => {
    const day = fmtDay(m.created_at);
    const divider = day !== lastDay ? `<div class="day-divider">${esc(day)}</div>` : '';
    lastDay = day;
    return `${divider}
      <div class="msg ${m.author_user_id === user.id ? 'member' : 'advisor'}${m.kind === 'question' ? ' question-msg' : ''}">
        <div class="who">${esc(m.author_name || 'Kelly Online')} · ${esc(fmtDate(m.created_at))}${m.kind === 'action_plan' ? ' · <strong>Action plan</strong>' : ''}${m.kind === 'question' ? ' · <strong>Kelly asked you</strong>' : ''}${m.kind === 'evidence' ? ' · <strong>📎 Evidence</strong>' : ''}</div>
        <div class="body">${esc(m.content)}</div>
        ${m.attachments?.length ? `<ul class="small">${m.attachments.map((a) => `<li><a href="/api/documents/${a.id}/download">${esc(a.filename)}</a></li>`).join('')}</ul>` : ''}
      </div>`;
  }).join('');

  view.innerHTML = `
    <p><a href="#/">&larr; Home</a></p>
    <h1>${esc(c.title)}</h1>
    ${journeyStepper(c.status, !!intake)}
    <p class="small"><strong>${esc(NEXT_STEP_TEXT[c.status] || c.statusLabel)}</strong></p>
    <p>
      <span class="tag ${esc(c.urgency)}">${esc(c.urgency.replace('_', ' '))}</span>
      <span class="tag status">${esc(c.statusLabel)}</span>
      <span class="tag">${esc(c.typeLabel)}</span>
    </p>
    ${escalations.length ? `<div class="notice warn"><strong>This case is being treated as a priority.</strong><br>${escalations.map((e) => esc(e.reason)).join('; ')}. If a deadline is imminent, see <a href="/emergency.html">urgent help</a> — do not rely on the portal alone.</div>` : ''}
    <div id="msg"></div>
    ${datedTimeline.length || c.nextImportantAt ? `
      <div class="card">
        <h3 class="mt0">Important dates</h3>
        <div class="timeline">
          ${datedTimeline.map((t) => `
            <div class="timeline-item ${t.confirmed ? 'confirmed' : ''}">
              <span class="date">${esc(fmtDay(t.event_date))}</span>
              <span>${esc(t.description)} ${dueChip(t.event_date)} ${t.confirmed ? '' : '<span class="unconfirmed">unconfirmed</span>'}</span>
            </div>`).join('')}
        </div>
        <p class="small muted mt0">Dates are collected from your account and documents — Kelly confirms what matters.</p>
      </div>` : ''}
    ${intakeCard(intake)}
    <div class="card">
      <h3>Conversation</h3>
      <div id="thread">${thread || '<p class="muted small">Your case has been received — updates appear here.</p>'}</div>
      ${c.status !== 'closed' ? `
      <form id="reply-form">
        <label for="reply">${c.status === 'need_member_info' ? 'Reply to Kelly' : 'Add to your case'}</label>
        <textarea id="reply" required></textarea>
        <p><button class="btn" type="submit">Send</button>
        <button class="btn secondary" type="button" id="add-evidence">📎 Add evidence</button>
        ${['gathering', 'need_member_info'].includes(c.status) ? '<button class="btn quiet" type="button" id="request-review">Ask Kelly to review</button>' : ''}</p>
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
  if (!silent) enterView(view);

  const msg = document.getElementById('msg');
  document.getElementById('reply-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    setBusy(btn, true);
    try {
      await api(`/cases/${id}/messages`, { method: 'POST', body: { content: document.getElementById('reply').value } });
      renderCase(id, { silent: true });
    } catch (err) { setBusy(btn, false); msg.innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
  });
  document.getElementById('add-evidence')?.addEventListener('click', () => openEvidenceSheet(id));
  document.getElementById('request-review')?.addEventListener('click', async (e) => {
    setBusy(e.target, true);
    try {
      await api(`/cases/${id}/request-review`, { method: 'POST' });
      toast('ok', 'Kelly has been asked to review your case.');
      renderCase(id, { silent: true });
    } catch (err) { setBusy(e.target, false); msg.innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
  });
  document.getElementById('upload-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fileInput = document.getElementById('file');
    if (!fileInput.files[0]) return;
    const btn = e.target.querySelector('button');
    setBusy(btn, true);
    const formData = new FormData();
    formData.append('file', fileInput.files[0]);
    try {
      await api(`/cases/${id}/documents`, { method: 'POST', formData });
      toast('ok', 'Document uploaded.');
      renderCase(id, { silent: true });
    } catch (err) { setBusy(btn, false); msg.innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
  });

  // If intake has not arrived yet, poll a few times.
  if (!intake && !silent) {
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      if (tries > 8 || !window.location.hash.startsWith(`#/case/${id}`)) return clearInterval(timer);
      const fresh = await api(`/cases/${id}`).catch(() => null);
      if (fresh?.intake) {
        clearInterval(timer);
        if (window.location.hash.startsWith(`#/case/${id}`)) renderCase(id, { silent: true });
      }
    }, 4000);
  }
}

// ── Router ───────────────────────────────────────────────────────────────
async function route() {
  const hash = window.location.hash || '#/';
  try {
    const caseMatch = hash.match(/^#\/case\/(\d+)(\/evidence)?$/);
    if (hash === '#/new') renderWizard();
    else if (hash === '#/cases') await renderCaseList();
    else if (caseMatch) {
      await renderCase(Number(caseMatch[1]));
      if (caseMatch[2]) openEvidenceSheet(Number(caseMatch[1]));
    } else await renderHome();
  } catch (err) {
    errorBox(err);
  }
  window.scrollTo(0, 0);
}

user = await requireUser('portal', 'cases.own');
if (user) {
  window.addEventListener('hashchange', route);
  window.addEventListener('kelly-installable', () => {
    if ((window.location.hash || '#/') === '#/') route();
  });
  route();
}
