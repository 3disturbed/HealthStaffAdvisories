// Shared renderers for the band review section (member + advisor).
// Template-literal HTML strings; every interpolated value goes through
// esc()/escAttr(). No scoring constants — everything renders server data.

import { esc, escAttr, fmtDay } from '/common.js';
import { ICONS, REDUCED } from '/ui.js';
import { STAGE_LABELS, JOURNEY_LABELS, journeyPosition, factorState, bandDisplay } from '/je-core.js';

export function jeJourneyStepper(stage) {
  const pos = journeyPosition(stage);
  return `<div class="journey" role="img" aria-label="Band review progress: step ${Math.min(pos, JOURNEY_LABELS.length)} of ${JOURNEY_LABELS.length}">
    ${JOURNEY_LABELS.map((label, i) => {
      const step = i + 1;
      const cls = step < pos ? 'done' : step === pos ? 'active' : '';
      return `<div class="journey-step ${cls}"><span class="journey-dot"></span><span class="journey-label">${label}</span></div>`;
    }).join('')}
  </div>`;
}

export function stageChips(review) {
  return `
    <span class="tag status">${esc(STAGE_LABELS[review.stage] || review.stage)}</span>
    ${review.urgency && review.urgency !== 'normal' ? `<span class="tag ${escAttr(review.urgency)}">${esc(review.urgency)}</span>` : ''}`;
}

export function bandChip(label, { current = false } = {}) {
  if (!label) return '';
  return `<span class="band-chip ${current ? 'current' : 'indicative'}">Band ${esc(label)}</span>`;
}

// The honest arithmetic. Never one number while factors are unresolved:
// solid fill = confirmed points; hatched extension = unresolved range.
export function bandMeter({ outcome, bands, currentBand = '', headingId = 'band-meter' }) {
  if (!outcome || !bands?.length) return '';
  const max = bands[bands.length - 1].max;
  const confirmedPct = Math.min(100, Math.round(((outcome.totalPoints || 0) / max) * 100));
  const lowPct = Math.min(100, Math.round(((outcome.pointsLow || 0) / max) * 100));
  const highPct = Math.min(100, Math.round(((outcome.pointsHigh || 0) / max) * 100));
  const resolvedText = outcome.factorsMissing > 0
    ? `${outcome.factorsMissing} area${outcome.factorsMissing === 1 ? '' : 's'} unresolved — range if all resolve: ${bandDisplay({ bandLow: outcome.bandLow, bandHigh: outcome.bandHigh })}`
    : `All areas resolved`;
  const label = `Confirmed so far: ${outcome.totalPoints} points${outcome.bandLabel ? `, Band ${outcome.bandLabel}` : ''}. ${resolvedText}.`;
  return `
    <div class="band-meter" role="img" aria-label="${escAttr(label)}" id="${escAttr(headingId)}">
      <div class="band-meter-scale">
        <div class="band-meter-range" data-low="${lowPct}" data-high="${highPct}"></div>
        <div class="band-meter-fill" data-pct="${confirmedPct}"></div>
        ${bands.map((b) => `<span class="band-meter-tick" data-pct="${Math.round((b.min / max) * 100)}"><i>${esc(b.label)}</i></span>`).join('')}
      </div>
      <div class="band-meter-label">
        <strong>${esc(String(outcome.totalPoints ?? 0))} points confirmed</strong>
        ${outcome.bandLabel ? bandChip(outcome.bandLabel) : outcome.bandLow ? `<span class="muted small">range ${esc(bandDisplay(outcome))}</span>` : ''}
        ${currentBand ? `<span class="muted small">· current: Band ${esc(currentBand)}</span>` : ''}
        ${outcome.factorsMissing > 0 ? `<span class="muted small">· ${outcome.factorsMissing} unresolved</span>` : ''}
      </div>
    </div>`;
}

// Widths are set from JS (CSP forbids inline style attributes).
export function wireBandMeter(root) {
  root.querySelectorAll('.band-meter').forEach((meter) => {
    const fill = meter.querySelector('.band-meter-fill');
    const range = meter.querySelector('.band-meter-range');
    if (fill) {
      const w = `${fill.dataset.pct}%`;
      if (REDUCED.matches) fill.style.setProperty('width', w);
      else requestAnimationFrame(() => fill.style.setProperty('width', w));
    }
    if (range) {
      range.style.setProperty('left', `${range.dataset.low}%`);
      range.style.setProperty('width', `${Math.max(0, Number(range.dataset.high) - Number(range.dataset.low))}%`);
    }
    meter.querySelectorAll('.band-meter-tick').forEach((tick) => {
      tick.style.setProperty('left', `${tick.dataset.pct}%`);
    });
  });
}

export function evidenceQuote(e, { linkText = true } = {}) {
  const provenance = e.source_kind === 'document'
    ? `from document${e.document_id ? ` #${e.document_id}` : ''}`
    : e.source_kind === 'wizard' ? 'from your answers' : `from ${esc(e.source_kind)}`;
  return `
    <blockquote class="evidence-quote ${e.strength === 'rejected' ? 'rejected' : ''}">
      ${e.quote ? `“${esc(e.quote)}”` : esc(e.summary || '')}
      <span class="provenance">${provenance}${e.document_id && linkText ? ` · <a href="/api/je/documents/${Number(e.document_id)}/text" data-doc-text="${Number(e.document_id)}">view text</a>` : ''}
        ${e.strength === 'confirmed' ? ' · <span class="tag ok-tag">checked</span>' : e.strength === 'rejected' ? ' · <span class="tag">rejected</span>' : ''}</span>
    </blockquote>`;
}

export function factorStateChip(f) {
  const st = factorState(f);
  return `<span class="factor-state ${st.cls}">${ICONS[st.icon] || ''}<span>${st.label}</span></span>`;
}

export function checksList(checks, { withAck = false, flags = [] } = {}) {
  if (!checks?.length) return '<p class="muted small">No checks are raising anything.</p>';
  return `<div class="checklist">${checks.map((c) => {
    const flag = flags.find((f) => f.rule_id === c.id && !f.resolved_at);
    return `
    <div class="checklist-item sev-${escAttr(c.severity)} ${flag?.acknowledged_at ? 'done' : ''}">
      <div><strong>${esc(c.message)}</strong>
      ${c.actionable ? `<div class="small muted">${esc(c.actionable)}</div>` : ''}</div>
      ${withAck && flag && !flag.acknowledged_at ? `<button class="btn small quiet" type="button" data-ack-flag="${Number(flag.id)}">Acknowledge</button>` : ''}
    </div>`;
  }).join('')}</div>`;
}

export function limitsList(limits) {
  const relevant = (limits || []).filter((l) => l.status !== 'no_date');
  if (!relevant.length) return '';
  return `<div class="card">
    <h3 class="mt0">Time limits to verify</h3>
    ${relevant.map((l) => `
      <p class="small ${l.status === 'may_have_passed' ? 'notice error' : l.status === 'closing' ? 'notice warn' : ''}">
        <strong>${esc(l.label)}</strong> — indicative date ${esc(fmtDay(l.limitDate) || 'not computable')}
        ${l.status === 'may_have_passed' ? ' — may already have passed: this needs specialist advice today.' : l.daysRemaining !== null ? ` (${l.daysRemaining} days)` : ''}
        <span class="muted">Indicative — must be verified before you rely on it.</span></p>`).join('')}
  </div>`;
}
