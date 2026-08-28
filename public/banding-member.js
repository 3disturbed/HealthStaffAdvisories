// Band review — member section (#/banding/*), lazy-loaded from portal.js.
// Weeks-long flow: the server draft is the source of truth from the first
// screen; sessionStorage is only a crash buffer. Save state is always
// visible — silent loss of a member's evidence is the worst failure this
// screen can produce.

import { api, esc, escAttr, fmtDate, fmtDay } from '/common.js';
import {
  enterView, stagger, setBusy, toast, openSheet, closeSheet, emptyState,
  skelCases, skelForm, skelReport, announce, confirmSheet, printDoc, ICONS,
} from '/ui.js';
import { createWizard } from '/wizard.js';
import { STAGE_LABELS, KIND_LABELS, DOC_ROLE_LABELS, DECISION_LABELS, STANDARD_SENTENCE, bandDisplay } from '/je-core.js';
import { jeJourneyStepper, stageChips, bandChip } from '/je-ui.js';

let view;
let user;

export async function route(mount, currentUserObj, hash) {
  view = mount;
  user = currentUserObj;
  const stepMatch = hash.match(/^#\/banding\/(\d+)\/step\/(\d+)$/);
  const reportMatch = hash.match(/^#\/banding\/(\d+)\/report$/);
  const idMatch = hash.match(/^#\/banding\/(\d+)$/);
  if (hash === '#/banding/new') await renderStart();
  else if (stepMatch) await renderWizard(Number(stepMatch[1]), Number(stepMatch[2]));
  else if (reportMatch) await renderReport(Number(reportMatch[1]));
  else if (idMatch) await renderOverview(Number(idMatch[1]));
  else await renderHub();
}

function offerCard(offer) {
  if (!offer?.enabled) return '';
  return `
    <div class="card offer-card">
      <h3 class="mt0">${esc(offer.headline)}</h3>
      <p class="offer-price"><strong>£${esc(String(offer.priceGbp))}</strong>${offer.vatApplies ? ' + VAT' : ''} <span class="muted">${esc(offer.unit)}</span></p>
      <ul class="small">${(offer.inclusions || []).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
      ${offer.note ? `<p class="muted small">${esc(offer.note)}</p>` : ''}
    </div>`;
}

// ── Hub ──────────────────────────────────────────────────────────────────
async function renderHub() {
  view.innerHTML = skelCases(2);
  const [status, list] = await Promise.all([api('/je/status'), api('/je/reviews')]);
  const reviews = list.reviews || [];
  const active = reviews.find((r) => r.stage === 'draft');
  const open = reviews.filter((r) => r.stage !== 'closed');

  view.innerHTML = `
    <h1>Banding &amp; fair pay</h1>
    <p class="hint">${esc(STANDARD_SENTENCE)}</p>
    ${!status.ready ? `<div class="notice warn">This section is not available yet — the reference data has not been loaded. Please check back, or <a href="#/new">start an ordinary case</a> about your pay instead.</div>` : ''}
    ${active ? `
      <a class="case-card next-up wiz-resume" href="#/banding/${active.id}/step/1">
        <h3>${esc(active.jobTitle)} — your band review</h3>
        <p class="small">${active.answered} of ${active.questionCount} questions answered · last saved ${esc(fmtDate(active.updatedAt))}</p>
        <p class="mt0"><span class="btn small primary">Carry on where you left off</span></p>
      </a>` : ''}
    <div class="big-actions">
      ${status.ready && !active ? `<a class="btn" href="#/banding/new">Start a band review</a>` : ''}
      <a class="btn secondary" href="#/">Back to home</a>
    </div>
    ${offerCard(status.offer)}
    <div class="card">
      <h3 class="mt0">How this works</h3>
      <ol class="small">
        <li><strong>You tell us about your job</strong> — in your own words, over as many sittings as you need. Everything saves as you go.</li>
        <li><strong>Kelly works through it</strong> — every part of the assessment is reviewed and confirmed by Kelly personally.</li>
        <li><strong>You get a report and a ready-to-send request</strong> — what your evidence supports, what to do next, and the formal papers.</li>
      </ol>
      <p class="small muted">Be aware: a band review looks at the whole job. It can confirm your current band, and in principle it can result in a lower outcome. We always talk this through before anything is submitted.</p>
    </div>
    ${open.length ? `<h2>Your reviews</h2><div class="case-list" id="je-list">${open.map(reviewCard).join('')}</div>` : ''}
    ${reviews.length === 0 && status.ready ? emptyState({
      icon: 'scales', title: 'No band reviews yet',
      body: 'If your job has grown, or you think it was banded wrong, we’ll help you build the case — step by step, in plain English.',
      actionHref: '#/banding/new', actionLabel: 'Start a band review',
    }) : ''}`;
  enterView(view);
  stagger(document.getElementById('je-list'), '.case-card');
}

function reviewCard(r) {
  return `
    <a class="case-card" href="#/banding/${r.id}${r.stage === 'draft' ? '/step/1' : ''}">
      <h3>${esc(r.jobTitle)}${r.currentBand ? ` · Band ${esc(r.currentBand)}` : ''}</h3>
      ${stageChips(r)}
      <span class="tag">${esc(KIND_LABELS[r.kind] || r.kind)}</span>
      <div class="meta">Updated ${esc(fmtDate(r.updatedAt))}</div>
    </a>`;
}

// ── Start (risk acknowledgement + core details) ──────────────────────────
async function renderStart() {
  view.innerHTML = skelForm();
  const status = await api('/je/status');
  if (!status.ready) { window.location.hash = '#/banding'; return; }

  view.innerHTML = `
    <p><a href="#/banding">&larr; Banding &amp; fair pay</a></p>
    <h1>Before you start</h1>
    <div class="card">
      <p><strong>A band review looks at your whole job.</strong> It can confirm your current band. It can, in principle, result in a lower banding outcome. Nobody can promise you a higher one.</p>
      <p>The decision is made by your employer’s matching or evaluation panel — not here, and not by AI. Kelly reviews everything personally before anything leaves this site.</p>
      <p>You can stop at any time, and your material stays yours.</p>
    </div>
    <div class="card">
      <form id="start-form">
        <label for="je-title">Your job title</label>
        <input id="je-title" type="text" required maxlength="120" placeholder="e.g. Healthcare assistant, Ward clerk, Staff nurse">
        <label for="je-employer">Employer / NHS organisation</label>
        <input id="je-employer" type="text" maxlength="120">
        <p class="field-label" id="je-band-label">Your current band</p>
        <div class="option-grid multi" id="je-band" role="group" aria-labelledby="je-band-label">
          ${['1', '2', '3', '4', '5', '6', '7', '8a', '8b', '8c', '8d', '9'].map((b) => `<button type="button" class="option-card band-opt" data-band="${b}">Band ${b}</button>`).join('')}
          <button type="button" class="option-card band-opt" data-band="">I’m not sure</button>
        </div>
        <label for="je-since">Roughly when did you start this job? <span class="muted">(optional)</span></label>
        <input id="je-since" type="date">
        <p class="field-label" id="je-kind-label">What are you asking for?</p>
        <div class="option-grid" id="je-kind" role="group" aria-labelledby="je-kind-label">
          <button type="button" class="option-card" data-kind="band_review">My job has grown — I want it looked at again</button>
          <button type="button" class="option-card" data-kind="job_match">I think my job was banded wrong from the start</button>
          <button type="button" class="option-card" data-kind="equal_pay">Colleagues doing my job are paid more</button>
          <button type="button" class="option-card" data-kind="appeal">I’ve had an outcome I disagree with</button>
        </div>
        <label class="check-row"><input type="checkbox" id="je-ack" required>
          <span>I understand a review can confirm my current band or, in principle, result in a lower outcome — and that only my employer’s panel decides.</span></label>
        <div id="msg"></div>
        <p><button class="btn" type="submit">Start my band review</button>
           <a class="btn quiet" href="#/banding">Cancel</a></p>
      </form>
    </div>`;
  enterView(view);

  let band = '';
  let kind = '';
  view.querySelectorAll('#je-band .band-opt').forEach((b) => b.addEventListener('click', () => {
    band = b.dataset.band;
    view.querySelectorAll('#je-band .band-opt').forEach((x) => x.classList.toggle('on', x === b));
  }));
  view.querySelectorAll('#je-kind .option-card').forEach((b) => b.addEventListener('click', () => {
    kind = b.dataset.kind;
    view.querySelectorAll('#je-kind .option-card').forEach((x) => x.classList.toggle('on', x === b));
  }));

  document.getElementById('start-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    setBusy(btn, true);
    try {
      const data = await api('/je/reviews', {
        method: 'POST',
        body: {
          jobTitle: document.getElementById('je-title').value,
          employer: document.getElementById('je-employer').value,
          currentBand: band,
          inPostSince: document.getElementById('je-since').value || null,
          kind: kind || 'band_review',
          riskAcknowledged: document.getElementById('je-ack').checked,
        },
      });
      window.location.hash = `#/banding/${data.reviewId}/step/1`;
    } catch (err) {
      setBusy(btn, false);
      document.getElementById('msg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    }
  });
}

// ── The wizard (server-draft persistence) ────────────────────────────────
const GROUPS = [
  { id: 'job', label: 'Your job' },
  { id: 'doing', label: 'What you do' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'finish', label: 'Send' },
];

let draft = null; // { reviewId, review, answers, dirty:Set, version, questions }
let saveTimer = null;
let wizardApi = null;

function bufferKey(reviewId) { return `kelly-je-buffer-${reviewId}`; }

function markDirty(code, value) {
  draft.answers[code] = value;
  draft.dirty.add(code);
  try { sessionStorage.setItem(bufferKey(draft.reviewId), JSON.stringify({ at: Date.now(), answers: draft.answers })); } catch { /* private mode */ }
  wizardApi?.setSaveState('saving', 'Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushDraft(), 800);
}

async function flushDraft({ keepalive = false } = {}) {
  if (!draft || draft.dirty.size === 0) return;
  const delta = {};
  for (const code of draft.dirty) delta[code] = draft.answers[code];
  const payload = { expectedVersion: draft.version, answers: delta };
  try {
    if (keepalive) {
      // pagehide flush: fetch keepalive carries the CSRF header (sendBeacon cannot).
      fetch('/api/je/reviews/' + draft.reviewId + '/answers', {
        method: 'PATCH', keepalive: true,
        headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return;
    }
    const r = await api(`/je/reviews/${draft.reviewId}/answers`, { method: 'PATCH', body: payload });
    draft.version = r.answersVersion;
    draft.dirty.clear();
    try { sessionStorage.removeItem(bufferKey(draft.reviewId)); } catch { /* ignore */ }
    wizardApi?.setSaveState('ok', 'All answers saved');
  } catch (err) {
    if (String(err.message).includes('changed somewhere else')) {
      wizardApi?.setSaveState('conflict', 'These answers were changed on another device.');
      showConflictSheet();
    } else {
      wizardApi?.setSaveState('error', 'Not saved — check your connection. Your answers are kept on this device.');
    }
  }
}

function showConflictSheet() {
  const body = openSheet('Answers changed elsewhere', `
    <p>This review was edited somewhere else (another device, or another tab) since this device last saved.</p>
    <p class="sheet-actions">
      <button class="btn" type="button" data-mine>Keep what I wrote here</button>
      <button class="btn secondary" type="button" data-theirs>Use the other version</button>
    </p>`);
  body.querySelector('[data-mine]').addEventListener('click', async () => {
    closeSheet();
    const fresh = await api(`/je/reviews/${draft.reviewId}`);
    draft.version = fresh.review.answersVersion;
    await flushDraft();
  });
  body.querySelector('[data-theirs]').addEventListener('click', async () => {
    closeSheet();
    const fresh = await api(`/je/reviews/${draft.reviewId}`);
    draft.answers = fresh.answers;
    draft.version = fresh.review.answersVersion;
    draft.dirty.clear();
    try { sessionStorage.removeItem(bufferKey(draft.reviewId)); } catch { /* ignore */ }
    wizardApi?.setSaveState('ok', 'Loaded the latest saved answers');
    renderWizard(draft.reviewId, currentStep());
  });
}

window.addEventListener('pagehide', () => { if (draft) flushDraft({ keepalive: true }); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && draft) flushDraft({ keepalive: true });
});

function currentStep() {
  const m = window.location.hash.match(/\/step\/(\d+)$/);
  return m ? Number(m[1]) : 1;
}

function textStep({ title, hint, codes, group, skippable = true }) {
  return {
    title, hint, group, skippable,
    plainTitle: title,
    body: () => codes.map(({ code, prompt, cue }) => `
      <label for="q-${escAttr(code)}">${esc(prompt)}</label>
      ${cue ? `<p class="hint">${esc(cue)}</p>` : ''}
      <textarea id="q-${escAttr(code)}" data-code="${escAttr(code)}" maxlength="8000">${esc(draft.answers[code] || '')}</textarea>`).join(''),
    wire: () => {
      view.querySelectorAll('textarea[data-code]').forEach((t) => {
        t.addEventListener('input', () => markDirty(t.dataset.code, t.value));
      });
    },
    collect: () => {
      view.querySelectorAll('textarea[data-code]').forEach((t) => {
        if ((draft.answers[t.dataset.code] || '') !== t.value) markDirty(t.dataset.code, t.value);
      });
      return true;
    },
  };
}

function q(code) {
  return draft.questions.find((x) => x.code === code) || { code, prompt: code, cue: '' };
}

function buildSteps() {
  const RESP = ['resp_patient_care', 'resp_policy', 'resp_money_equipment', 'resp_supervising', 'resp_records_systems', 'resp_research'];
  const RESP_LABELS = {
    resp_patient_care: 'I’m involved in patient or client care',
    resp_policy: 'I write or change how we do things',
    resp_money_equipment: 'I handle money, stock or equipment',
    resp_supervising: 'I supervise, train or check anyone’s work',
    resp_records_systems: 'I look after records, data or systems',
    resp_research: 'I’m involved in audits, research or trials',
  };
  return [
    { // 1 — JD upload with escape hatches
      title: 'Your job description',
      group: 'job',
      plainTitle: 'Your job description',
      hint: 'Upload it if you have it (PDF, Word or text). <strong>Please redact patient-identifiable information first.</strong> Not having a current one is fine — that matters too.',
      skippable: true,
      body: () => `
        <div id="jd-list" class="small muted">Loading documents…</div>
        <label for="jd-file">Upload your job description</label>
        <input id="jd-file" type="file" accept=".pdf,.docx,.txt">
        <label for="jd-dated">Roughly when is it from? <span class="muted">(optional)</span></label>
        <input id="jd-dated" type="date">
        <p><button class="btn secondary" type="button" id="jd-upload">Upload</button></p>
        <div class="option-grid" id="jd-none">
          <button type="button" class="option-card ${draft.answers.jd_status === 'none' ? 'on' : ''}" data-jd="none">I don’t have a copy</button>
          <button type="button" class="option-card ${draft.answers.jd_status === 'outdated' ? 'on' : ''}" data-jd="outdated">It’s out of date</button>
          <button type="button" class="option-card ${draft.answers.jd_status === 'never' ? 'on' : ''}" data-jd="never">I’ve never been given one</button>
        </div>
        <div id="jd-msg"></div>`,
      wire: () => {
        refreshJdList();
        view.querySelectorAll('[data-jd]').forEach((b) => b.addEventListener('click', () => {
          markDirty('jd_status', b.dataset.jd);
          view.querySelectorAll('[data-jd]').forEach((x) => x.classList.toggle('on', x === b));
        }));
        document.getElementById('jd-upload').addEventListener('click', async () => {
          const file = document.getElementById('jd-file').files[0];
          if (!file) { document.getElementById('jd-msg').innerHTML = '<div class="notice error">Choose a file first.</div>'; return; }
          const btn = document.getElementById('jd-upload');
          setBusy(btn, true);
          try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('docRole', 'jd');
            const dated = document.getElementById('jd-dated').value;
            if (dated) formData.append('documentDated', dated);
            await api(`/je/reviews/${draft.reviewId}/documents`, { method: 'POST', formData });
            toast('ok', 'Job description uploaded.');
            refreshJdList();
          } catch (err) {
            document.getElementById('jd-msg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
          }
          setBusy(btn, false);
        });
      },
      collect: () => true,
    },
    textStep({ title: 'A typical shift or day', group: 'doing', codes: [q('typical_day')], skippable: false }),
    textStep({ title: 'Who you deal with', group: 'doing', codes: [q('communication_who')] }),
    textStep({ title: 'What it takes to do your job', group: 'doing', codes: [q('knowledge_needed'), q('judgement_calls')] }),
    { // 5 — responsibilities multi-select with per-tick detail
      title: 'What you’re responsible for',
      group: 'doing',
      plainTitle: 'What you are responsible for',
      hint: 'Tick everything that’s true — then tell us a little about each. Things people often forget: supervising students, ordering stock, being the person who fixes the rota.',
      skippable: true,
      body: () => `
        <div class="option-grid multi" id="resp-grid">
          ${RESP.map((code) => `<button type="button" class="option-card ${draft.answers[code] !== undefined && draft.answers[code] !== '' ? 'on' : ''}" data-resp="${code}">${RESP_LABELS[code]}</button>`).join('')}
        </div>
        <div id="resp-details">
          ${RESP.filter((code) => draft.answers[code] !== undefined && draft.answers[code] !== '').map((code) => respDetail(code)).join('')}
        </div>`,
      wire: () => {
        view.querySelectorAll('[data-resp]').forEach((b) => b.addEventListener('click', () => {
          const code = b.dataset.resp;
          const on = !b.classList.contains('on');
          b.classList.toggle('on', on);
          if (on) {
            if (draft.answers[code] === undefined) markDirty(code, '');
            document.getElementById('resp-details').insertAdjacentHTML('beforeend', respDetail(code));
            wireRespDetail(code);
          } else {
            markDirty(code, '');
            document.getElementById(`resp-wrap-${code}`)?.remove();
          }
        }));
        RESP.forEach((code) => wireRespDetail(code));
      },
      collect: () => true,
    },
    textStep({ title: 'Planning, and deciding on your own', group: 'doing', codes: [q('planning_organising'), q('autonomy')] }),
    textStep({ title: 'Skilled hands, hard shifts', group: 'doing', codes: [q('physical_precision'), q('physical_demands')] }),
    textStep({ title: 'Concentration and emotional load', group: 'doing', codes: [q('concentration_demands'), q('emotional_demands')] }),
    textStep({ title: 'Where you work', group: 'doing', codes: [q('environment')] }),
    { // 10 — duty log
      title: 'What has changed, and when?',
      group: 'evidence',
      plainTitle: 'What has changed and when',
      hint: 'List the duties you now do that have grown or been added — roughly when each started, and how often. This becomes the heart of the formal request. One line per duty is fine.',
      skippable: true,
      body: () => {
        const rows = dutyRows();
        return `
          <div id="duty-rows">${rows.map((d, i) => dutyRowHtml(d, i)).join('')}</div>
          <p><button class="btn secondary small" type="button" id="duty-add">+ Add a duty</button></p>`;
      },
      wire: () => {
        document.getElementById('duty-add').addEventListener('click', () => {
          const rows = dutyRows();
          rows.push({ duty: '', since: '', frequency: '', evidence: '' });
          saveDutyRows(rows);
          document.getElementById('duty-rows').insertAdjacentHTML('beforeend', dutyRowHtml(rows[rows.length - 1], rows.length - 1));
          wireDutyRows();
        });
        wireDutyRows();
      },
      collect: () => { collectDutyRows(); return true; },
    },
    { // 11 — comparators
      title: 'Anyone doing the same work at a higher band?',
      group: 'evidence',
      plainTitle: 'Colleagues on a higher band',
      hint: 'We don’t need their name to make the point — and it’s their information, not yours. Describe them instead: “A colleague in my team, Band 6”.',
      skippable: true,
      body: () => `
        <div id="comp-list" class="small muted">Loading…</div>
        <label for="comp-ref">Who are you comparing to?</label>
        <input id="comp-ref" type="text" maxlength="120" placeholder="e.g. A colleague in my team, Band 6">
        <label for="comp-band">Their band <span class="muted">(if known)</span></label>
        <input id="comp-band" type="text" maxlength="4" placeholder="e.g. 6">
        <label for="comp-sim">What’s the same about the work?</label>
        <textarea id="comp-sim" maxlength="2000"></textarea>
        <label class="check-row"><input type="checkbox" id="comp-consent">
          <span>I want to name them — they know about this and are happy to be named.</span></label>
        <div id="comp-msg"></div>
        <p><button class="btn secondary" type="button" id="comp-add">Add comparator</button></p>`,
      wire: () => {
        refreshComparators();
        document.getElementById('comp-add').addEventListener('click', async () => {
          const ref = document.getElementById('comp-ref').value.trim();
          if (!ref) { document.getElementById('comp-msg').innerHTML = '<div class="notice error">Describe the comparator first.</div>'; return; }
          const btn = document.getElementById('comp-add');
          setBusy(btn, true);
          try {
            await api(`/je/reviews/${draft.reviewId}/comparators`, {
              method: 'POST',
              body: {
                comparatorRef: ref,
                bandLabel: document.getElementById('comp-band').value.trim(),
                similarityNote: document.getElementById('comp-sim').value,
                namedConsent: document.getElementById('comp-consent').checked,
              },
            });
            document.getElementById('comp-ref').value = '';
            document.getElementById('comp-sim').value = '';
            toast('ok', 'Comparator added.');
            refreshComparators();
          } catch (err) {
            document.getElementById('comp-msg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
          }
          setBusy(btn, false);
        });
      },
      collect: () => true,
    },
    { // 12 — review + submit
      title: 'Check and send',
      group: 'finish',
      plainTitle: 'Check and send',
      review: true,
      hint: 'Kelly reads everything and works through it personally. That usually takes days, not minutes — you’ll get an alert when there’s something to see.',
      body: () => {
        const answered = Object.entries(draft.answers).filter(([, v]) => v && String(v).trim()).length;
        const rows = [
          ['Your job description', draft.documents.some((d) => d.doc_role === 'jd') ? `${draft.documents.filter((d) => d.doc_role === 'jd').length} uploaded` : ({ none: 'You don’t have a copy', outdated: 'Out of date', never: 'Never been given one' }[draft.answers.jd_status] || 'Not provided'), 1],
          ['A typical day', draft.answers.typical_day, 2],
          ['Who you deal with', draft.answers.communication_who, 3],
          ['Knowledge and judgement', [draft.answers.knowledge_needed, draft.answers.judgement_calls].filter(Boolean).join(' · '), 4],
          ['Responsibilities', ['resp_patient_care', 'resp_policy', 'resp_money_equipment', 'resp_supervising', 'resp_records_systems', 'resp_research'].filter((c) => draft.answers[c]).length + ' area(s) described', 5],
          ['Planning and independence', [draft.answers.planning_organising, draft.answers.autonomy].filter(Boolean).join(' · '), 6],
          ['Physical demands', [draft.answers.physical_precision, draft.answers.physical_demands].filter(Boolean).join(' · '), 7],
          ['Concentration and emotional load', [draft.answers.concentration_demands, draft.answers.emotional_demands].filter(Boolean).join(' · '), 8],
          ['Where you work', draft.answers.environment, 9],
          ['What changed, when', dutyRows().filter((d) => d.duty).length + ' duty(ies) logged', 10],
          ['Comparators', `${draft.comparators.length} added`, 11],
        ];
        return `
          <p class="small muted">${answered} answers saved.</p>
          ${rows.map(([label, value, step]) => `
            <div class="perm-item">
              <div class="perm-head"><strong>${esc(label)}</strong>
                <button class="btn small quiet" type="button" data-goto="${step}">Edit</button></div>
              <div class="small muted">${esc(String(value || '—').slice(0, 200))}</div>
            </div>`).join('')}`;
      },
      collect: () => true,
    },
  ];
}

function respDetail(code) {
  const labels = {
    resp_patient_care: 'Tell us about your part in care',
    resp_policy: 'What do you write or change?',
    resp_money_equipment: 'What money, stock or equipment?',
    resp_supervising: 'Who do you supervise or train?',
    resp_records_systems: 'Which records or systems?',
    resp_research: 'Which audits, research or trials?',
  };
  return `
    <div id="resp-wrap-${escAttr(code)}">
      <label for="q-${escAttr(code)}">${esc(labels[code] || code)}</label>
      <textarea id="q-${escAttr(code)}" data-code="${escAttr(code)}" maxlength="4000">${esc(draft.answers[code] || '')}</textarea>
    </div>`;
}
function wireRespDetail(code) {
  const t = document.getElementById(`q-${code}`);
  if (t && !t.dataset.wired) {
    t.dataset.wired = '1';
    t.addEventListener('input', () => markDirty(code, t.value));
  }
}

function dutyRows() {
  try {
    const arr = JSON.parse(draft.answers.duty_log || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveDutyRows(rows) {
  markDirty('duty_log', JSON.stringify(rows.filter((r) => r.duty || r.since || r.frequency || r.evidence)));
}
function collectDutyRows() {
  const rows = [];
  document.querySelectorAll('#duty-rows .duty-row').forEach((row) => {
    rows.push({
      duty: row.querySelector('[data-f="duty"]').value,
      since: row.querySelector('[data-f="since"]').value,
      frequency: row.querySelector('[data-f="frequency"]').value,
      evidence: row.querySelector('[data-f="evidence"]').value,
    });
  });
  saveDutyRows(rows);
}
function dutyRowHtml(d, i) {
  return `
    <div class="duty-row card" data-i="${i}">
      <label for="duty-${i}-duty">Duty</label>
      <input id="duty-${i}-duty" name="duty-${i}-duty" type="text" data-f="duty" maxlength="300" value="${escAttr(d.duty || '')}" placeholder="What you now do">
      <div class="duty-row-meta">
        <span><label for="duty-${i}-since">Since (roughly)</label><input id="duty-${i}-since" name="duty-${i}-since" type="text" data-f="since" maxlength="40" value="${escAttr(d.since || '')}" placeholder="e.g. spring 2025"></span>
        <span><label for="duty-${i}-frequency">How often</label><input id="duty-${i}-frequency" name="duty-${i}-frequency" type="text" data-f="frequency" maxlength="60" value="${escAttr(d.frequency || '')}" placeholder="e.g. daily"></span>
      </div>
      <label for="duty-${i}-evidence">Evidence <span class="muted">(optional)</span></label>
      <input id="duty-${i}-evidence" name="duty-${i}-evidence" type="text" data-f="evidence" maxlength="200" value="${escAttr(d.evidence || '')}" placeholder="e.g. rota, email from manager">
    </div>`;
}
function wireDutyRows() {
  document.querySelectorAll('#duty-rows input').forEach((inp) => {
    if (!inp.dataset.wired) {
      inp.dataset.wired = '1';
      inp.addEventListener('input', () => collectDutyRows());
    }
  });
}

async function refreshJdList() {
  const el = document.getElementById('jd-list');
  if (!el) return;
  const fresh = await api(`/je/reviews/${draft.reviewId}`).catch(() => null);
  if (!fresh) return;
  draft.documents = fresh.documents;
  const jds = fresh.documents.filter((d) => d.doc_role === 'jd');
  el.innerHTML = jds.length
    ? `Uploaded: ${jds.map((d) => `<a href="/api/je/documents/${d.id}/download">${esc(d.original_filename)}</a>`).join(', ')}`
    : 'Nothing uploaded yet.';
}

async function refreshComparators() {
  const el = document.getElementById('comp-list');
  if (!el) return;
  const fresh = await api(`/je/reviews/${draft.reviewId}`).catch(() => null);
  if (!fresh) return;
  draft.comparators = fresh.comparators;
  el.innerHTML = fresh.comparators.length
    ? fresh.comparators.map((c) => `<div class="perm-item"><strong>${esc(c.comparator_ref)}</strong>${c.band_label ? ` · Band ${esc(c.band_label)}` : ''}${c.named_consent ? ' · <span class="tag">named with consent</span>' : ' · <span class="tag ok-tag">anonymised</span>'}</div>`).join('')
    : 'None yet — and that’s fine.';
}

async function renderWizard(reviewId, step) {
  if (!draft || draft.reviewId !== reviewId) {
    view.innerHTML = skelForm();
    const data = await api(`/je/reviews/${reviewId}`);
    draft = {
      reviewId,
      review: data.review,
      answers: data.answers,
      documents: data.documents,
      comparators: data.comparators,
      version: data.review.answersVersion,
      questions: data.questions.questions,
      dirty: new Set(),
    };
    // Crash buffer newer than the server? Offer it, never silently apply.
    try {
      const buffered = JSON.parse(sessionStorage.getItem(bufferKey(reviewId)) || 'null');
      if (buffered && Object.keys(buffered.answers || {}).some((k) => (buffered.answers[k] || '') !== (draft.answers[k] || ''))) {
        const keep = await confirmSheet({
          title: 'Unsaved answers found',
          bodyHtml: `<p>This device has answers from ${esc(fmtDate(new Date(buffered.at).toISOString()))} that never reached the server. Keep them?</p>`,
          confirmLabel: 'Keep them',
        });
        if (keep) {
          for (const [k, v] of Object.entries(buffered.answers)) {
            if ((v || '') !== (draft.answers[k] || '')) { draft.answers[k] = v; draft.dirty.add(k); }
          }
          flushDraft();
        } else {
          try { sessionStorage.removeItem(bufferKey(reviewId)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
  if (draft.review.stage !== 'draft') { window.location.hash = `#/banding/${reviewId}`; return; }
  if (!draft.review.memberEditable) {
    view.innerHTML = `<p><a href="#/banding/${reviewId}">&larr; Your review</a></p>
      <div class="notice">Kelly is reviewing this right now — editing is paused. Message her from the review page if something needs changing.</div>`;
    return;
  }

  const steps = buildSteps();
  wizardApi = createWizard({
    mount: view,
    heading: 'Your band review',
    steps,
    groups: GROUPS,
    getStep: () => step,
    setStep: (n) => {
      step = Math.min(Math.max(n, 1), steps.length);
      history.replaceState(null, '', `#/banding/${reviewId}/step/${step}`);
    },
    onPersist: () => flushDraft(),
    submitLabel: 'Send to Kelly',
    cancelHref: '#/banding',
    exit: { href: '#/banding', label: 'Save and finish later' },
    saveState: true,
    announce,
    onSubmit: async () => {
      await flushDraft();
      const sure = await confirmSheet({
        title: 'Send to Kelly?',
        bodyHtml: `<p>Kelly will read everything and work through your job area by area. You can still add documents and reply to her questions afterwards — but the answers themselves are handed over now.</p>
          <p class="small muted">${esc(STANDARD_SENTENCE)}</p>`,
        confirmLabel: 'Send to Kelly',
      });
      if (!sure) return;
      const r = await api(`/je/reviews/${reviewId}/submit`, { method: 'POST' });
      draft = null;
      toast('ok', 'Sent — Kelly will take it from here.');
      window.location.hash = `#/banding/${reviewId}`;
    },
  });
  wizardApi.render();
  wizardApi.setSaveState('ok', 'All answers saved');
}

// ── Overview ─────────────────────────────────────────────────────────────
async function renderOverview(reviewId) {
  view.innerHTML = skelCases(2);
  const data = await api(`/je/reviews/${reviewId}`);
  const r = data.review;
  const memberMessages = data.messages || [];
  const issuedReports = (data.reports || []).filter((x) => x.audience === 'member');

  view.innerHTML = `
    <p><a href="#/banding">&larr; Banding &amp; fair pay</a></p>
    <h1>${esc(r.jobTitle)}</h1>
    ${jeJourneyStepper(r.stage)}
    <p class="small"><strong>${esc(STAGE_LABELS[r.stage] || r.stage)}</strong></p>
    <p>${stageChips(r)} <span class="tag">${esc(KIND_LABELS[r.kind] || r.kind)}</span></p>
    <div id="msg"></div>
    ${r.stage === 'draft' ? `<p><a class="btn" href="#/banding/${r.id}/step/1">Carry on with your answers</a></p>` : ''}
    ${issuedReports.length ? `<p><a class="btn" href="#/banding/${r.id}/report">Read your report</a></p>` : ''}
    <div class="card">
      <h3 class="mt0">Messages with Kelly</h3>
      <div id="je-thread">
        ${memberMessages.map((m) => `
          <div class="msg ${m.author_user_id === user.id ? 'member' : 'advisor'}${m.kind === 'question' ? ' question-msg' : ''}">
            <div class="who">${m.author_user_id === user.id ? 'You' : 'Kelly'} · ${esc(fmtDate(m.created_at))}${m.kind === 'question' ? ' · <strong>Kelly asked you</strong>' : ''}</div>
            <div class="body">${esc(m.content)}</div>
          </div>`).join('') || '<p class="muted small">No messages yet.</p>'}
      </div>
      ${r.stage !== 'closed' ? `
        <form id="je-reply">
          <label for="je-msg-input">Message Kelly about this review</label>
          <textarea id="je-msg-input" required maxlength="8000"></textarea>
          <p><button class="btn" type="submit">Send</button></p>
        </form>` : ''}
    </div>
    <div class="card">
      <h3 class="mt0">Documents</h3>
      <ul>${data.documents.map((d) => `<li><a href="/api/je/documents/${d.id}/download">${esc(d.original_filename)}</a> <span class="muted small">(${esc(DOC_ROLE_LABELS[d.doc_role] || d.doc_role)})</span></li>`).join('') || '<li class="muted">None yet.</li>'}</ul>
      ${r.stage !== 'closed' ? `
        <form id="je-upload">
          <p class="hint">PDF, Word (.docx) or plain text, up to 15 MB. Please redact patient-identifiable information first.</p>
          <input type="file" id="je-file" accept=".pdf,.docx,.txt" required>
          <label for="je-file-role">What is it?</label>
          <select id="je-file-role">${Object.entries(DOC_ROLE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
          <p><button class="btn quiet" type="submit">Upload</button></p>
        </form>` : ''}
    </div>`;
  enterView(view);

  document.getElementById('je-reply')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    setBusy(btn, true);
    try {
      await api(`/je/reviews/${reviewId}/messages`, { method: 'POST', body: { content: document.getElementById('je-msg-input').value } });
      renderOverview(reviewId);
    } catch (err) {
      setBusy(btn, false);
      document.getElementById('msg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    }
  });
  document.getElementById('je-upload')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    const file = document.getElementById('je-file').files[0];
    if (!file) return;
    setBusy(btn, true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('docRole', document.getElementById('je-file-role').value);
    try {
      await api(`/je/reviews/${reviewId}/documents`, { method: 'POST', formData });
      toast('ok', 'Document uploaded.');
      renderOverview(reviewId);
    } catch (err) {
      setBusy(btn, false);
      document.getElementById('msg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    }
  });
}

// ── The member report ────────────────────────────────────────────────────
async function renderReport(reviewId) {
  view.innerHTML = skelReport();
  const data = await api(`/je/reviews/${reviewId}`);
  const report = (data.reports || []).filter((x) => x.audience === 'member')[0];
  if (!report) { window.location.hash = `#/banding/${reviewId}`; return; }
  const b = report.body;

  view.innerHTML = `
    <p class="screen-only"><a href="#/banding/${reviewId}">&larr; Your review</a></p>
    <div class="doc-sheet" id="report-doc">
      <div class="doc-meta">
        <h1>Your band review report</h1>
        <p class="muted small">Prepared for ${esc(user.displayName || 'you')} · ${esc(fmtDay(report.approved_at || ''))}</p>
      </div>
      <div class="notice">
        ${report.includes_band_range && (b.headline.bandLabel || b.headline.bandLow) ? `<p class="mt0"><strong>Where this landed:</strong> the evidence points towards ${b.headline.bandLabel ? bandChip(b.headline.bandLabel) : `${bandChip(b.headline.bandLow)}–${bandChip(b.headline.bandHigh)}`}${b.headline.currentBand ? ` (your current band: ${esc(b.headline.currentBand)})` : ''}.</p>` : ''}
        <p class="small">${esc(b.standardSentence)}</p>
      </div>
      <div class="doc-section"><p>${esc(b.opening)}</p></div>
      <div class="doc-section"><h2>What we looked at</h2><p class="small">${esc(b.whatWeLookedAt)}</p></div>
      ${b.why?.length ? `<div class="doc-section"><h2>Why</h2><ul>${b.why.map((w) => `<li><strong>${esc(w.area)}:</strong> ${esc(w.text)}</li>`).join('')}</ul></div>` : ''}
      <div class="doc-section"><h2>What’s strong</h2><p class="small">${esc(b.strong)}</p></div>
      <div class="doc-section"><h2>Where more would help</h2><p class="small">${esc(b.thin)}</p></div>
      <div class="doc-section">
        <h2>What to do next</h2>
        <ol>${(b.actions || []).map((a) => `<li><strong>${esc(a.title)}</strong>${a.who ? ` <span class="muted small">— ${esc(a.who)}</span>` : ''}${a.when ? ` <span class="due-chip soon">${esc(a.when)}</span>` : ''}<div class="small muted">${esc(a.why)}${a.evidenceNeeded ? ` Evidence: ${esc(a.evidenceNeeded)}` : ''}</div></li>`).join('')}</ol>
      </div>
      ${b.dates?.length ? `<div class="doc-section"><h2>Dates that matter</h2><ul>${b.dates.map((d) => `<li>${esc(d.label)}${d.date ? ` — <strong>${esc(fmtDay(d.date))}</strong>` : ''} <span class="muted small">${esc(d.note)}</span></li>`).join('')}</ul></div>` : ''}
      ${b.uncertainty ? `<div class="doc-section"><h2>What’s uncertain</h2><p class="small">${esc(b.uncertainty)}</p></div>` : ''}
      <div class="print-footer small muted">
        <p>${esc(b.footer.standardSentence)}</p>
        <p>Reference data: ${esc(b.footer.rulesetLabel)} (${esc(b.footer.rulesetChecksum)}${b.footer.rulesetVerified ? ', verified' : ', not yet verified against the published handbook'}).
        ${esc(b.footer.datesNote)} Second opinion: ${esc(b.footer.secondOpinion)}. Review ref ${reviewId}.</p>
      </div>
    </div>
    <p class="screen-only"><button class="btn secondary" type="button" id="print-report">Print / Save as PDF</button></p>`;
  enterView(view);
  document.getElementById('print-report').addEventListener('click', () => printDoc(`band-review-report-${reviewId}`));
}
