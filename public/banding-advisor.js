// Band review — advisor workspace (#/banding/*), lazy-loaded from advisor.js.
// The oversight screen: factor-by-factor confirmation with evidence quotes,
// honest running arithmetic, fairness checks, and a sign-off gate. Nothing
// reaches the member unapproved.

import { api, esc, escAttr, fmtDate, fmtDay } from '/common.js';
import {
  enterView, stagger, setBusy, toast, openSheet, closeSheet, skelCases, skelFactors,
  announce, confirmSheet, printDoc, ICONS, countUp,
} from '/ui.js';
import { STAGE_LABELS, KIND_LABELS, DOC_ROLE_LABELS, DECISION_LABELS, AMEND_REASON_LABELS, bandDisplay } from '/je-core.js';
import { bandMeter, wireBandMeter, evidenceQuote, factorStateChip, checksList, limitsList, stageChips, bandChip } from '/je-ui.js';

let view;
let user;

export async function route(mount, currentUserObj, hash) {
  view = mount;
  user = currentUserObj;
  const subMatch = hash.match(/^#\/banding\/(\d+)\/submission$/);
  const idMatch = hash.match(/^#\/banding\/(\d+)$/);
  if (hash === '#/banding/oversight') await renderOversight();
  else if (subMatch) await renderSubmission(Number(subMatch[1]));
  else if (idMatch) await renderWorkbench(Number(idMatch[1]));
  else await renderQueue(hash.match(/^#\/banding\/queue\/(\w+)$/)?.[1] || 'needs_review');
}

// ── Queue ────────────────────────────────────────────────────────────────
const VIEW_LABELS = {
  needs_review: 'Needs review', analysing: 'Analysing', report_ready: 'Report ready',
  awaiting_employer: 'With employer', appeal: 'Outcome & appeal', all: 'All open',
};

async function renderQueue(viewName) {
  view.innerHTML = skelCases(3);
  const data = await api(`/je/queue?view=${encodeURIComponent(viewName)}`);
  view.innerHTML = `
    <h1>Band reviews</h1>
    <p class="small"><a href="#/banding/oversight">Oversight &amp; quality →</a></p>
    <div class="tabs" id="je-views">
      ${Object.entries(VIEW_LABELS).map(([v, label]) =>
        `<button type="button" class="${v === data.view ? 'active' : ''}" data-view="${v}">${label}${data.counts[v] ? ` (${data.counts[v]})` : ''}</button>`).join('')}
    </div>
    <div class="case-list" id="je-queue">
      ${data.reviews.map((r) => `
        <a class="case-card" href="#/banding/${r.id}">
          <h3>${esc(r.jobTitle)} <span class="muted small">· ${esc(r.member)}</span></h3>
          ${stageChips(r)}
          ${r.currentBand ? `<span class="tag">Band ${esc(r.currentBand)}</span>` : ''}
          ${r.openFlags ? `<span class="tag high">${r.openFlags} flag${r.openFlags === 1 ? '' : 's'}</span>` : ''}
          <span class="tag">${r.confirmedCount}/${r.factorCount} confirmed</span>
          <div class="meta">Updated ${esc(fmtDate(r.updatedAt))}</div>
        </a>`).join('') || '<p class="muted">Nothing in this view.</p>'}
    </div>`;
  enterView(view);
  stagger(document.getElementById('je-queue'), '.case-card');
  view.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => { window.location.hash = `#/banding/queue/${b.dataset.view}`; }));
}

// ── Workbench ────────────────────────────────────────────────────────────
let wb = null; // current workbench payload

async function loadWorkbench(id) {
  wb = await api(`/je/reviews/${id}/workbench`);
  return wb;
}

function factorByCode(code) {
  return wb.bundle?.factors.find((f) => f.code === code);
}

async function renderWorkbench(id, { openFactor = null } = {}) {
  view.innerHTML = skelFactors(6);
  await loadWorkbench(id);
  const r = wb.review;
  const outcome = wb.liveOutcome;
  const provenanceRun = wb.runs?.[0];

  view.innerHTML = `
    <p><a href="#/banding">&larr; Band reviews</a></p>
    <div class="wb-header">
      <h1>${esc(r.job_title)} <span class="muted small">· ${esc(wb.member.name)}</span></h1>
      <p class="mt0">
        ${stageChips({ stage: r.stage, urgency: r.urgency })}
        <span class="tag">${esc(KIND_LABELS[r.kind] || r.kind)}</span>
        ${r.current_band ? `<span class="band-chip current">Band ${esc(r.current_band)} now</span>` : ''}
        ${r.claimed_band ? `<span class="tag">hopes: ${esc(r.claimed_band)}</span>` : ''}
        ${wb.bundle ? `<span class="tag role">${esc(wb.bundle.label)}${wb.bundle.origin === 'seed' && !wb.bundle.verifiedAt ? ' · seed, unverified' : ''}</span>` : ''}
      </p>
      ${provenanceRun ? `<p class="muted small"><span class="tag ai">AI</span> last analysis: ${esc(provenanceRun.status)} · ${esc(fmtDate(provenanceRun.started_at))} · stages: ${provenanceRun.stages.map((s) => `${esc(s.stage)}:${esc(s.status)}${s.dropped ? ` (${s.dropped} dropped)` : ''}`).join(', ')}</p>` : ''}
      <p class="muted small">Indicative only. Nothing here is visible to the member until every factor is confirmed and the report approved.</p>
    </div>
    <div id="msg"></div>
    <div class="band-meter-sticky" id="meter-wrap">
      ${wb.bundle && outcome ? bandMeter({ outcome, bands: wb.bundle.bands, currentBand: r.current_band }) : '<div class="notice warn">No approved reference ruleset — scoring unavailable. Load one in Admin → Job evaluation.</div>'}
    </div>
    <p class="wb-actions">
      ${wb.review.stage !== 'closed' ? `<button class="btn secondary small" type="button" id="run-analysis">Run AI analysis</button>` : ''}
      <button class="btn quiet small" type="button" id="toggle-lock">${r.memberEditable ? 'Pause member editing' : 'Hand back to member'}</button>
      <a class="btn quiet small" href="#/banding/${id}/submission">Employer submission</a>
    </p>
    ${wb.matches?.length ? profilePanel() : ''}
    <h2>The ${wb.factors.length} areas</h2>
    <div class="factor-list" id="factor-list">${wb.factors.map((f) => factorRow(f, openFactor === f.factor_code)).join('')}</div>
    <div class="card" id="checks-card">
      <h3 class="mt0">Checks &amp; fairness</h3>
      ${checksList(wb.checks, { withAck: true, flags: wb.flags })}
    </div>
    ${limitsList(wb.limits)}
    ${messagesCard()}
    ${signoffCard()}
    ${reportsCard()}
    ${decisionsCard()}
  `;
  enterView(view);
  wireBandMeter(view);
  wireWorkbench(id);
}

function profilePanel() {
  const selected = wb.matches.find((m) => m.selected_by);
  return `
    <div class="card">
      <h3 class="mt0">National profiles worth comparing</h3>
      ${wb.matches.slice(0, 5).map((m) => `
        <div class="perm-item ${m.selected_by ? 'on' : ''}">
          <div class="perm-head">
            <strong>${esc(m.profile_title)} <span class="tag">Band ${esc(m.profile_band)}</span>
              <span class="tag ${m.fit === 'match' ? 'ok-tag' : m.fit === 'partial' ? 'status' : ''}">${esc(m.fit.replace('_', ' '))}</span></strong>
            <button class="btn small ${m.selected_by ? 'quiet' : 'secondary'}" type="button" data-select-profile="${m.id}">${m.selected_by ? 'Selected' : 'Select'}</button>
          </div>
          ${m.ai_rationale ? `<div class="small muted"><span class="tag ai">AI</span> ${esc(m.ai_rationale)}</div>` : ''}
          ${JSON.parse(m.factors_outside_json || '[]').length ? `<div class="small muted">Outside range: ${JSON.parse(m.factors_outside_json).map((f) => `${esc(f.factorCode)} (${esc(String(f.level))} vs ${esc(String(f.min))}–${esc(String(f.max))})`).join(', ')}</div>` : ''}
        </div>`).join('')}
      <p class="small muted">Fit verdicts are computed against the loaded profile ranges — never by AI. ${wb.matches.length === 0 ? '' : 'Selecting a profile records your working comparison; it does not decide anything.'}</p>
    </div>`;
}

function factorRow(f, open = false) {
  const factor = factorByCode(f.factor_code);
  const evidence = wb.evidence.filter((e) => e.factor_code === f.factor_code && e.strength !== 'rejected');
  const levels = factor?.levels || [];
  const proposed = f.aiMasked ? null : f.ai_level;
  return `
    <details class="factor-row st-${f.confirmed_decision ? (f.confirmed_decision === 'amend' ? 'changed' : f.confirmed_decision === 'insufficient' ? 'insufficient' : 'confirmed') : 'unreviewed'}" data-factor="${escAttr(f.factor_code)}" ${open ? 'open' : ''}>
      <summary class="factor-head">
        <span class="factor-name">${esc(factor?.name || f.factor_code)}</span>
        <span class="factor-meta">
          ${f.aiMasked ? '<span class="tag">blind check — record yours first</span>'
            : proposed ? `<span class="tag ai">AI: level ${esc(proposed)} · ${esc(f.ai_confidence || '')}</span>` : ''}
          ${f.adjustment_flag ? '<span class="tag high">adjustment — job not person</span>' : ''}
          ${f.outlier_flag ? '<span class="tag high">outlier</span>' : ''}
          ${f.claimed_level ? `<span class="tag">member: ${esc(f.claimed_level)}</span>` : ''}
          ${f.confirmed_level ? `<span class="tag ok-tag">Kelly: ${esc(f.confirmed_level)}</span>` : ''}
          ${factorStateChip(f)}
        </span>
      </summary>
      <div class="factor-body">
        ${factor ? `<p class="small muted">${esc(factor.description)}</p>` : ''}
        ${proposed && !f.aiMasked ? `
          <div class="notice">
            <p class="mt0"><span class="tag ai">AI</span> <strong>Proposed level ${esc(proposed)}</strong>${f.ai_alternative_level ? ` (or ${esc(f.ai_alternative_level)})` : ''} · confidence ${esc(f.ai_confidence || 'unknown')}</p>
            ${f.ai_rationale ? `<p class="small">${esc(f.ai_rationale)}</p>` : ''}
            ${f.gap_note ? `<p class="small"><strong>What would settle it:</strong> ${esc(f.gap_note)}</p>` : ''}
            ${levels.find((l) => String(l.label) === String(proposed)) ? `<p class="small muted"><strong>Descriptor (level ${esc(proposed)}):</strong> ${esc(levels.find((l) => String(l.label) === String(proposed)).descriptor)}</p>` : ''}
          </div>` : ''}
        ${evidence.length ? evidence.slice(0, 4).map((e) => evidenceQuote(e)).join('') : '<p class="notice warn small">No evidence recorded for this area — a proposal here cannot be confirmed until there is some.</p>'}
        ${f.confirm_note ? `<p class="small"><strong>Kelly’s note:</strong> ${esc(f.confirm_note)}</p>` : ''}
        <div class="level-picker" role="radiogroup" aria-label="Level for ${escAttr(factor?.name || f.factor_code)}">
          ${levels.map((l) => `<button type="button" role="radio" aria-checked="${String(f.confirmed_level ?? proposed ?? '') === String(l.label) ? 'true' : 'false'}" data-level="${escAttr(String(l.label))}" title="${escAttr(l.descriptor)}">${esc(String(l.label))}</button>`).join('')}
        </div>
        <div class="factor-actions">
          <button class="btn small" type="button" data-decide="agree" ${proposed ? '' : 'disabled'}>Confirm proposal</button>
          <button class="btn small secondary" type="button" data-decide="amend">Set selected level</button>
          <button class="btn small quiet" type="button" data-decide="insufficient">Not enough information</button>
          <button class="btn small quiet" type="button" data-decide="not_applicable">Not applicable</button>
        </div>
      </div>
    </details>`;
}

function messagesCard() {
  const msgs = wb.messages || [];
  return `
    <div class="card">
      <h3 class="mt0">Messages</h3>
      ${msgs.slice(-6).map((m) => `
        <div class="msg ${m.visibility === 'advisor_private' ? 'private' : m.author_user_id === wb.member.id ? 'theirs' : 'mine'}">
          <div class="who">${m.author_user_id === wb.member.id ? esc(wb.member.name) : 'Advisor'} · ${esc(fmtDate(m.created_at))}${m.visibility === 'advisor_private' ? ' · <strong>private note</strong>' : ''}${m.kind === 'question' ? ' · question' : ''}</div>
          <div class="body">${esc(m.content)}</div>
        </div>`).join('') || '<p class="muted small">No messages yet.</p>'}
      <form id="advisor-msg">
        <label for="advisor-msg-input">Message the member <span class="muted">(batch your questions into one message)</span></label>
        <textarea id="advisor-msg-input" maxlength="8000"></textarea>
        <p>
          <button class="btn small" type="submit" data-kind="question">Send as questions</button>
          <button class="btn small secondary" type="submit" data-kind="message">Send as update</button>
          <button class="btn small quiet" type="submit" data-kind="note">Private note</button>
        </p>
      </form>
    </div>`;
}

function signoffCard() {
  const unresolved = wb.factors.filter((f) => !f.confirmed_decision);
  const unacked = wb.flags.filter((f) => ['critical', 'high'].includes(f.severity) && !f.acknowledged_at && !f.resolved_at);
  const outstanding = [];
  if (unresolved.length) outstanding.push(`${unresolved.length} area${unresolved.length === 1 ? '' : 's'} not yet reviewed`);
  if (unacked.length) outstanding.push(`${unacked.length} check flag${unacked.length === 1 ? '' : 's'} not acknowledged`);
  const canSignOff = outstanding.length === 0 && wb.bundle;
  const so = wb.signoff;
  return `
    <div class="card" id="signoff-card">
      <h3 class="mt0">Sign-off</h3>
      ${so ? `<p class="small"><span class="tag ok-tag">Signed off</span> ${esc(fmtDate(so.created_at))} · recommendation: <strong>${esc(so.recommendation.replace(/_/g, ' '))}</strong>${so.second_opinion_required ? ` · second opinion: ${wb.secondOpinionRecord ? 'recorded' : so.second_opinion_waived_reason ? `waived — ${esc(so.second_opinion_waived_reason)}` : 'outstanding'}` : ''}</p>` : ''}
      ${wb.secondOpinion?.required ? `<p class="notice warn small">A second opinion is indicated: ${wb.secondOpinion.reasons.map((x) => esc(x.replace(/_/g, ' '))).join(', ')}.</p>` : ''}
      <div id="signoff-outstanding" class="small ${outstanding.length ? 'notice warn' : 'muted'}">
        ${outstanding.length ? `Still outstanding: ${outstanding.map((o, i) => `<a href="#" data-outstanding="${i === 0 && unresolved.length ? 'factors' : 'flags'}">${esc(o)}</a>`).join(' · ')}` : 'Everything is resolved — ready to sign off.'}
      </div>
      <p><button class="btn" type="button" id="signoff-btn" ${canSignOff ? '' : 'disabled'} aria-describedby="signoff-outstanding">Sign off assessment</button></p>
    </div>`;
}

function reportsCard() {
  const reports = wb.reports || [];
  return `
    <div class="card">
      <h3 class="mt0">Reports</h3>
      ${reports.map((rep) => `
        <div class="perm-item">
          <div class="perm-head">
            <strong>${esc(rep.audience.replace(/_/g, ' '))} v${rep.report_version} <span class="tag ${rep.status === 'issued' ? 'ok-tag' : 'status'}">${esc(rep.status)}</span></strong>
            <span>
              ${rep.status === 'draft' ? `<button class="btn small" type="button" data-approve-report="${rep.id}">Review &amp; approve</button>` : ''}
              ${['approved', 'issued'].includes(rep.status) ? `<button class="btn small quiet" type="button" data-withdraw-report="${rep.id}">Withdraw</button>` : ''}
            </span>
          </div>
          <div class="small muted">${esc(fmtDate(rep.created_at))}${rep.generated_by === 'ai' ? ' · includes AI prose (validated)' : ' · template'}</div>
        </div>`).join('') || '<p class="muted small">No reports yet. Sign off first, then generate.</p>'}
      <p>
        <button class="btn small secondary" type="button" data-gen-report="member" ${wb.signoff ? '' : 'disabled'}>Draft member report</button>
        <button class="btn small secondary" type="button" data-gen-report="employer_submission" ${wb.signoff ? '' : 'disabled'}>Draft employer submission</button>
        <button class="btn small quiet" type="button" data-gen-report="advisor">Working assessment snapshot</button>
      </p>
    </div>`;
}

function decisionsCard() {
  const decisions = wb.decisions || [];
  return `
    <div class="card">
      <h3 class="mt0">Formal record</h3>
      <p class="small muted">The only place a real band enters this system: what the employer’s process actually decided.</p>
      ${decisions.map((d) => `
        <div class="timeline-item ${d.date_confirmed ? 'confirmed' : ''}">
          <span class="date">${esc(fmtDay(d.decision_date) || '—')}</span>
          <span>${esc(DECISION_LABELS[d.kind] || d.kind)}${d.band_awarded ? ` — Band ${esc(d.band_awarded)}` : ''}${d.date_confirmed ? '' : ' <span class="unconfirmed">date unconfirmed</span>'}</span>
        </div>`).join('') || '<p class="muted small">Nothing recorded yet.</p>'}
      <form id="decision-form">
        <label for="dec-kind">Record an event</label>
        <select id="dec-kind">${Object.entries(DECISION_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <div class="duty-row-meta">
          <span><label for="dec-date">Date</label><input id="dec-date" type="date"></span>
          <span><label for="dec-band">Band awarded <span class="muted">(if any)</span></label><input id="dec-band" type="text" maxlength="4"></span>
        </div>
        <label class="check-row"><input type="checkbox" id="dec-confirmed"><span>The date is confirmed (seen in writing)</span></label>
        <p><button class="btn small secondary" type="submit">Record</button></p>
      </form>
    </div>`;
}

function wireWorkbench(id) {
  const msg = document.getElementById('msg');
  const fail = (err) => { msg.innerHTML = `<div class="notice error">${esc(err.message)}</div>`; window.scrollTo(0, 0); };

  document.getElementById('run-analysis')?.addEventListener('click', async (e) => {
    setBusy(e.target, true);
    try {
      await api(`/je/reviews/${id}/analyse`, { method: 'POST' });
      toast('ok', 'Analysis queued — refresh in a minute.');
    } catch (err) { fail(err); }
    setBusy(e.target, false);
  });

  document.getElementById('toggle-lock')?.addEventListener('click', async () => {
    try {
      await api(`/je/reviews/${id}/lock`, { method: 'POST', body: { memberEditable: !wb.review.memberEditable } });
      renderWorkbench(id);
    } catch (err) { fail(err); }
  });

  view.querySelectorAll('[data-select-profile]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/je/reviews/${id}/profiles/${b.dataset.selectProfile}/select`, { method: 'POST' });
      renderWorkbench(id);
    } catch (err) { fail(err); }
  }));

  // Factor rows: level picker + decisions
  view.querySelectorAll('.factor-row').forEach((row) => {
    const code = row.dataset.factor;
    let selected = row.querySelector('.level-picker [aria-checked="true"]')?.dataset.level || '';
    const picker = row.querySelector('.level-picker');
    picker?.querySelectorAll('[role="radio"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selected = btn.dataset.level;
        picker.querySelectorAll('[role="radio"]').forEach((x) => x.setAttribute('aria-checked', x === btn ? 'true' : 'false'));
      });
      btn.addEventListener('keydown', (e) => {
        if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
        e.preventDefault();
        const all = [...picker.querySelectorAll('[role="radio"]')];
        const idx = all.indexOf(btn);
        const next = all[(idx + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length];
        next.focus();
        next.click();
      });
    });
    row.querySelectorAll('[data-decide]').forEach((btn) => btn.addEventListener('click', async () => {
      const decision = btn.dataset.decide;
      const body = { decision };
      if (decision === 'agree') body.level = selected || undefined;
      if (decision === 'amend') {
        if (!selected) { fail(new Error('Pick a level first, then "Set selected level".')); return; }
        body.level = selected;
        const f = wb.factors.find((x) => x.factor_code === code);
        const hasProposal = f && !f.aiMasked && f.ai_level;
        if (hasProposal && String(f.ai_level) !== String(selected)) {
          // Changing a proposal needs a recorded reason (the fairness trail).
          const reason = await amendReasonSheet();
          if (!reason) return;
          body.reasonCode = reason.code;
          body.note = reason.note;
        } else {
          // Manual scoring (no proposal, or same level) is a plain confirm.
          body.decision = 'agree';
        }
      }
      setBusy(btn, true);
      try {
        const r = await api(`/je/reviews/${id}/factors/${code}/confirm`, { method: 'PATCH', body });
        announce(`${code.replace(/_/g, ' ')} ${decision === 'insufficient' ? 'marked not enough information' : `set to level ${body.level || ''}`}. ${r.outcome ? `${r.outcome.totalPoints} points confirmed.` : ''}`);
        await renderWorkbench(id, { openFactor: nextUnresolved(code) });
      } catch (err) { setBusy(btn, false); fail(err); }
    }));
  });

  view.querySelectorAll('[data-ack-flag]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/je/reviews/${id}/flags/${b.dataset.ackFlag}/ack`, { method: 'POST' });
      renderWorkbench(id);
    } catch (err) { fail(err); }
  }));

  view.querySelectorAll('[data-outstanding]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const target = a.dataset.outstanding === 'factors'
      ? view.querySelector('.factor-row.st-unreviewed')
      : document.getElementById('checks-card');
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (target?.tagName === 'DETAILS') target.open = true;
  }));

  document.getElementById('advisor-msg')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const kind = e.submitter?.dataset.kind || 'message';
    const content = document.getElementById('advisor-msg-input').value.trim();
    if (!content) return;
    try {
      await api(`/je/reviews/${id}/messages/advisor`, {
        method: 'POST',
        body: { content, kind: kind === 'note' ? 'note' : kind, visibility: kind === 'note' ? 'advisor_private' : 'member' },
      });
      toast('ok', kind === 'note' ? 'Private note saved.' : 'Sent to the member.');
      renderWorkbench(id);
    } catch (err) { fail(err); }
  });

  document.getElementById('signoff-btn')?.addEventListener('click', () => signoffFlow(id));

  view.querySelectorAll('[data-gen-report]').forEach((b) => b.addEventListener('click', async () => {
    const audience = b.dataset.genReport;
    let body = { audience };
    if (audience === 'employer_submission') {
      const include = await confirmSheet({
        title: 'Include the indicative range?',
        bodyHtml: `<p>By default the employer submission contains the organised evidence and factor table but <strong>not</strong> your indicative band range — publishing a self-assessed band to a panel usually weakens the member’s position.</p>
          <label for="range-reason">To include it anyway, give the reason:</label>
          <input id="range-reason" type="text" maxlength="300">`,
        confirmLabel: 'Include range',
      });
      if (include) {
        const reason = document.getElementById('range-reason')?.value?.trim();
        body = { audience, includesBandRange: true, includeRangeReason: reason };
        if (!reason) { fail(new Error('Including the range needs a recorded reason.')); return; }
      }
    }
    setBusy(b, true);
    try {
      await api(`/je/reviews/${id}/reports`, { method: 'POST', body });
      toast('ok', 'Draft created.');
      renderWorkbench(id);
    } catch (err) { setBusy(b, false); fail(err); }
  }));

  view.querySelectorAll('[data-approve-report]').forEach((b) => b.addEventListener('click', () => approveReportFlow(id, Number(b.dataset.approveReport))));
  view.querySelectorAll('[data-withdraw-report]').forEach((b) => b.addEventListener('click', async () => {
    const sure = await confirmSheet({ title: 'Withdraw this report?', bodyHtml: '<p>The issued report stays on record but is marked withdrawn. Generate and approve a new version to replace it.</p>', confirmLabel: 'Withdraw', danger: true });
    if (!sure) return;
    try {
      await api(`/je/reports/${b.dataset.withdrawReport}/withdraw`, { method: 'POST' });
      renderWorkbench(id);
    } catch (err) { fail(err); }
  }));

  document.getElementById('decision-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/je/reviews/${id}/decisions`, {
        method: 'POST',
        body: {
          kind: document.getElementById('dec-kind').value,
          decisionDate: document.getElementById('dec-date').value || null,
          bandAwarded: document.getElementById('dec-band').value.trim(),
          dateConfirmed: document.getElementById('dec-confirmed').checked,
          source: 'advisor',
        },
      });
      toast('ok', 'Recorded.');
      renderWorkbench(id);
    } catch (err) { fail(err); }
  });
}

function nextUnresolved(afterCode) {
  const codes = wb.factors.map((f) => f.factor_code);
  const start = codes.indexOf(afterCode);
  for (let i = 1; i <= codes.length; i += 1) {
    const f = wb.factors[(start + i) % codes.length];
    if (!f.confirmed_decision) return f.factor_code;
  }
  return null;
}

function amendReasonSheet() {
  return new Promise((resolve) => {
    const body = openSheet('Why are you changing the level?', `
      <p class="hint">A reason is required whenever a proposed level is changed — it is the fairness audit trail, and it feeds evaluation.</p>
      <div class="option-grid" id="reason-grid">
        ${Object.entries(AMEND_REASON_LABELS).map(([code, label]) => `<button type="button" class="option-card" data-reason="${code}">${label}</button>`).join('')}
      </div>
      <label for="reason-note">Note <span class="muted">(kept advisor-private)</span></label>
      <textarea id="reason-note" maxlength="2000"></textarea>
      <p class="sheet-actions"><button class="btn" type="button" data-ok>Change level</button>
      <button class="btn quiet" type="button" data-cancel>Cancel</button></p>`);
    let code = null;
    body.querySelectorAll('[data-reason]').forEach((b) => b.addEventListener('click', () => {
      code = b.dataset.reason;
      body.querySelectorAll('[data-reason]').forEach((x) => x.classList.toggle('on', x === b));
    }));
    body.querySelector('[data-ok]').addEventListener('click', () => {
      if (!code) return;
      const note = body.querySelector('#reason-note').value;
      closeSheet();
      resolve({ code, note });
    });
    body.querySelector('[data-cancel]').addEventListener('click', () => { closeSheet(); resolve(null); });
  });
}

async function signoffFlow(id) {
  const checklist = wb.checklist;
  const body = openSheet('Sign off this assessment', `
    <p class="hint">Every item needs an active tick — this is the fairness gate, not a formality.</p>
    <form id="checklist-form">
      ${checklist.items.map((i) => `
        <label class="check-row"><input type="checkbox" id="so-check-${escAttr(i.code)}" name="${escAttr(i.code)}" data-check="${escAttr(i.code)}"><span>${esc(i.label)}</span></label>`).join('')}
      <label for="so-rec">Outcome recommendation</label>
      <select id="so-rec">
        <option value="">Choose…</option>
        <option value="supports">The evidence supports a band review request</option>
        <option value="supports_in_part">Supports it in part</option>
        <option value="not_supported">Not supported on current evidence</option>
        <option value="more_information">More information needed before I can say</option>
      </select>
      ${wb.secondOpinion?.required && !wb.secondOpinionRecord ? `
        <div class="notice warn small">A second opinion is indicated (${wb.secondOpinion.reasons.map((r) => esc(r.replace(/_/g, ' '))).join(', ')}). Record one, or waive it with a reason:</div>
        <label for="so-waive">Waiver reason <span class="muted">(leave empty to hold for a second opinion)</span></label>
        <input id="so-waive" type="text" maxlength="400">` : ''}
      <label class="check-row"><input type="checkbox" id="so-attest"><span><strong>I have reviewed each factor myself against the evidence, and this is my professional assessment.</strong></span></label>
      <div id="so-msg"></div>
      <p class="sheet-actions"><button class="btn" type="submit">Sign off</button>
      <button class="btn quiet" type="button" data-cancel>Cancel</button></p>
    </form>`);
  body.querySelector('[data-cancel]').addEventListener('click', () => closeSheet());
  body.querySelector('#checklist-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ticked = {};
    body.querySelectorAll('[data-check]').forEach((c) => { ticked[c.dataset.check] = c.checked; });
    if (!body.querySelector('#so-attest').checked) {
      body.querySelector('#so-msg').innerHTML = '<div class="notice error">The attestation is required.</div>';
      return;
    }
    const btn = e.target.querySelector('button[type="submit"]');
    setBusy(btn, true);
    try {
      await api(`/je/reviews/${id}/signoff`, {
        method: 'POST',
        body: {
          checklist: ticked,
          recommendation: body.querySelector('#so-rec').value,
          secondOpinionWaivedReason: body.querySelector('#so-waive')?.value || '',
        },
      });
      closeSheet();
      toast('ok', 'Signed off. Now draft and approve the report.');
      renderWorkbench(id);
    } catch (err) {
      setBusy(btn, false);
      body.querySelector('#so-msg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    }
  });
}

async function approveReportFlow(id, reportId) {
  const rep = wb.reports.find((x) => x.id === reportId);
  if (!rep) return;
  const b = rep.body;
  const isMember = rep.audience === 'member';
  const body = openSheet('Exactly what will be released', `
    <p class="hint">${isMember ? 'This is what the member will see, word for word. Edit before approving.' : 'This approves the document for use.'}</p>
    ${isMember ? `
      <label for="rep-opening">Opening</label>
      <textarea id="rep-opening" maxlength="3000">${esc(b.opening || '')}</textarea>
      <div class="small muted">Headline: ${b.headline?.bandLabel ? `Band ${esc(b.headline.bandLabel)}` : b.headline?.bandLow ? `Band ${esc(b.headline.bandLow)}–${esc(b.headline.bandHigh)}` : 'no band asserted'} · ${(b.actions || []).length} actionables · fixed disclaimer included.</div>
      <label for="rep-strong">What’s strong</label>
      <textarea id="rep-strong" maxlength="3000">${esc(b.strong || '')}</textarea>
      <label for="rep-thin">Where more would help</label>
      <textarea id="rep-thin" maxlength="3000">${esc(b.thin || '')}</textarea>` : `
      <p class="small">${esc(rep.audience === 'employer_submission' ? 'Formal request with duties table, factor submission and comparators (anonymised unless consented).' : 'Working assessment snapshot for the file.')}</p>`}
    <div id="rep-msg"></div>
    <p class="sheet-actions">
      <button class="btn" type="button" data-approve>${isMember ? 'Approve &amp; send to member' : 'Approve'}</button>
      <button class="btn quiet" type="button" data-cancel>Cancel</button>
    </p>`);
  body.querySelector('[data-cancel]').addEventListener('click', () => closeSheet());
  body.querySelector('[data-approve]').addEventListener('click', async () => {
    const btn = body.querySelector('[data-approve]');
    setBusy(btn, true);
    try {
      const edits = isMember ? {
        opening: body.querySelector('#rep-opening').value,
        strong: body.querySelector('#rep-strong').value,
        thin: body.querySelector('#rep-thin').value,
      } : undefined;
      await api(`/je/reports/${reportId}/approve`, { method: 'POST', body: { edits } });
      closeSheet();
      toast('ok', isMember ? 'Approved and sent to the member.' : 'Approved.');
      renderWorkbench(id);
    } catch (err) {
      setBusy(btn, false);
      body.querySelector('#rep-msg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    }
  });
}

// ── Employer submission (print view) ─────────────────────────────────────
async function renderSubmission(id) {
  view.innerHTML = skelCases(2);
  await loadWorkbench(id);
  const rep = (wb.reports || []).find((x) => x.audience === 'employer_submission' && x.status !== 'withdrawn');
  if (!rep) {
    view.innerHTML = `<p><a href="#/banding/${id}">&larr; Workbench</a></p>
      <div class="notice">No employer submission has been generated yet. Sign off, then draft it from the workbench.</div>`;
    return;
  }
  const b = rep.body;
  view.innerHTML = `
    <p class="screen-only"><a href="#/banding/${id}">&larr; Workbench</a></p>
    <div class="doc-sheet">
      <div class="doc-meta"><h1>Request for job evaluation review</h1>
        <p class="muted small">${esc(b.request.jobTitle)} · ${esc(b.request.employer || '')} · ${esc(fmtDay(b.request.date))} · <span class="tag status">${esc(rep.status)}</span></p></div>
      <div class="doc-section"><h2>1. Request</h2><p>${esc(b.request.text)}</p></div>
      <div class="doc-section"><h2>2. Basis of the request</h2><p>${esc(b.basis)}</p></div>
      <div class="doc-section"><h2>3. Duties as currently performed</h2>
        <div class="table-scroll"><table class="doc-table"><thead><tr><th>Duty</th><th>Frequency</th><th>Since</th><th>Evidence</th></tr></thead>
        <tbody>${(b.dutiesTable || []).map((d) => `<tr><td>${esc(d.duty)}</td><td>${esc(d.frequency)}</td><td>${esc(d.since)}</td><td>${esc(d.evidence)}</td></tr>`).join('') || '<tr><td colspan="4">See attached statement</td></tr>'}</tbody></table></div></div>
      <div class="doc-section"><h2>4. Factor-level submission</h2>
        <div class="table-scroll"><table class="doc-table"><thead><tr><th>Factor</th><th>Level submitted</th><th>Justification</th><th>Evidence</th></tr></thead>
        <tbody>${(b.factorTable || []).map((f) => `<tr><td>${esc(f.factor)}</td><td>${esc(f.levelSubmitted)}</td><td>${esc(f.justification)}</td><td>${esc(f.evidenceRef)}</td></tr>`).join('')}</tbody></table></div></div>
      ${b.comparators?.length ? `<div class="doc-section"><h2>5. Comparators</h2><ul>${b.comparators.map((c) => `<li>${esc(c.reference)}${c.band ? ` — Band ${esc(c.band)}` : ''} (${esc(c.basis.replace(/_/g, ' '))}${c.sameEmployer ? ', same employer' : ''}). ${esc(c.similarity)}</li>`).join('')}</ul></div>` : ''}
      ${b.indicativeRange ? `<div class="doc-section"><p class="notice small">Indicative range prepared with the postholder’s adviser: ${esc(bandDisplay(b.indicativeRange))}. Indicative only; the panel’s evaluation governs.</p></div>` : ''}
      <div class="doc-section"><h2>6. Outcome sought</h2><p>${esc(b.outcomeSought)}</p></div>
      <div class="doc-section"><h2>Annexes</h2><ul>${(b.annexes || []).map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>
      <div class="print-footer small muted">
        <p>${esc(b.footer.standardSentence)}</p>
        <p>Reference data: ${esc(b.footer.rulesetLabel)} (${esc(b.footer.rulesetChecksum)}${b.footer.rulesetVerified ? ', verified' : ', not yet verified'}). ${esc(b.footer.datesNote)}</p>
      </div>
    </div>
    <p class="screen-only">
      <button class="btn secondary" type="button" id="print-sub">Print / Save as PDF</button>
      <a class="btn quiet" href="/api/je/reviews/${id}/submission.md">Download as Markdown</a>
    </p>`;
  enterView(view);
  document.getElementById('print-sub').addEventListener('click', () => printDoc(`band-review-submission-${id}`));
}

// ── Oversight dashboard ──────────────────────────────────────────────────
async function renderOversight() {
  view.innerHTML = skelCases(2);
  const m = await api('/je/oversight');
  view.innerHTML = `
    <p><a href="#/banding">&larr; Band reviews</a></p>
    <h1>Oversight &amp; quality</h1>
    <p class="muted small">Aggregate only — no names, no narrative. The headline number is AI-vs-Kelly agreement per area: a persistent gap on caring areas with none on technical ones is the bias alarm this page exists to catch.</p>
    <div class="stat-grid">
      <div class="stat-tile"><span class="stat-num" data-count="${m.awaiting}">0</span><span class="stat-label">awaiting review</span></div>
      <div class="stat-tile"><span class="stat-num" data-count="${m.waivers?.waived || 0}">0</span><span class="stat-label">second-opinion waivers</span></div>
      <div class="stat-tile"><span class="stat-num" data-count="${m.anchoring?.total || 0}">0</span><span class="stat-label">reviews with a hoped-for band</span></div>
    </div>
    <div class="card">
      <h3 class="mt0">AI proposal vs Kelly's decision, by area</h3>
      <div class="table-scroll"><table class="doc-table">
        <thead><tr><th>Area</th><th>Decided</th><th>Agreement</th><th>Blind agreement</th><th>Amended</th><th>Not enough info</th></tr></thead>
        <tbody>${(m.perFactor || []).map((f) => `
          <tr><td>${esc(f.factorCode.replace(/_/g, ' '))}</td><td>${f.decided}</td>
            <td>${f.agreementRate === null ? '—' : `${f.agreementRate}%`}</td>
            <td>${f.blindAgreementRate === null ? '—' : `${f.blindAgreementRate}%`}</td>
            <td>${f.amended}</td><td>${f.insufficient}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No decided factors yet.</td></tr>'}</tbody>
      </table></div>
      <p class="small muted">Blind agreement comes from sampled reviews where the proposal was hidden until Kelly recorded her own level — if it runs well below sighted agreement, the sighted number is measuring deference, not accuracy.</p>
    </div>
    <div class="card">
      <h3 class="mt0">Why levels were changed</h3>
      ${(m.amendReasons || []).map((r) => `<p class="small">${esc((r.code || '').replace(/_/g, ' '))} — ${r.n}</p>`).join('') || '<p class="muted small">No amendments yet.</p>'}
    </div>
    <div class="card">
      <h3 class="mt0">Pipeline health</h3>
      ${(m.pipeline || []).map((p) => `<p class="small">${esc(p.stage)}: ${esc(p.status)} ×${p.n}${p.dropped ? ` (${p.dropped} items dropped by validators)` : ''}</p>`).join('') || '<p class="muted small">No runs yet.</p>'}
    </div>
    <div class="card">
      <h3 class="mt0">Open flags</h3>
      ${(m.flags || []).map((f) => `<p class="small"><span class="tag ${f.severity === 'critical' ? 'critical' : f.severity === 'high' ? 'high' : ''}">${esc(f.severity)}</span> ${esc(f.rule_id.replace(/_/g, ' '))} ×${f.n}</p>`).join('') || '<p class="muted small">None.</p>'}
    </div>
    <div class="card">
      <h3 class="mt0">Reference data</h3>
      ${(m.reference || []).map((r) => `<p class="small"><span class="tag ${r.status === 'approved' ? 'ok-tag' : 'status'}">${esc(r.status)}</span> ${esc(r.label)}${r.origin === 'seed' ? ' · seed' : ''}${r.verified_at ? ' · verified' : ' · <strong>not verified</strong>'}</p>`).join('')}
      <p class="small muted">Manage in Admin → Job evaluation.</p>
    </div>`;
  enterView(view);
  view.querySelectorAll('[data-count]').forEach((eln) => countUp(eln, Number(eln.dataset.count)));
}
