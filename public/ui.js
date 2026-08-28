// Shared UI helpers: motion, skeletons, toasts, icons, empty states.
// Every JS-driven animation routes through here so reduced-motion is
// respected in one place. All styling lives in styles.css (strict CSP).
import { escAttr } from '/escape.js';

// Text-context escape (quotes untouched — fine outside attributes).
const escText = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

// ── icons (inline stroke SVGs, currentColor) ─────────────────────────────
const svg = (paths, viewBox = '0 0 24 24') =>
  `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
  home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h5v-6h4v6h5V9.5"/>'),
  cases: svg('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  plus: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
  bell: svg('<path d="M6 8a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7"/><path d="M10 19a2 2 0 0 0 4 0"/>'),
  account: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>'),
  today: svg('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/><path d="m9 15 2 2 4-4"/>'),
  queue: svg('<path d="M4 6h16M4 12h16M4 18h10"/>'),
  chat: svg('<path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z"/>'),
  overview: svg('<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14.5c2.8 0 4.5 1.8 4.5 4"/>'),
  folderPlus: svg('<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8L10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z"/><path d="M12 10v6M9 13h6"/>', '0 0 24 24'),
  inboxCheck: svg('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5 5h14l3 7v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7z"/><path d="m9 8 2 2 4-4"/>', '0 0 24 24'),
  file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>'),
  scales: svg('<path d="M12 3v18M8 21h8"/><path d="M5 7h14"/><path d="M5 7 2.5 13a3.5 3.5 0 0 0 5 0L5 7zM19 7l-2.5 6a3.5 3.5 0 0 0 5 0L19 7z"/>'),
  clipboardCheck: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4a2 2 0 0 1 6 0"/><path d="m9 13 2 2 4-4"/>'),
  quote: svg('<path d="M7 7h4v5H8a3 3 0 0 0 3 3v2a5 5 0 0 1-5-5V9a2 2 0 0 1 1-2z"/><path d="M14 7h4v5h-3a3 3 0 0 0 3 3v2a5 5 0 0 1-5-5V9a2 2 0 0 1 1-2z"/>'),
};

// ── motion helpers ───────────────────────────────────────────────────────
export function enterView(el) {
  if (REDUCED.matches || !el) return;
  el.classList.remove('anim-page-enter');
  void el.offsetWidth; // restart the animation
  el.classList.add('anim-page-enter');
}

// Progressive enhancement: crossfade route swaps where supported.
export async function renderWith(view, renderFn) {
  if (document.startViewTransition && !REDUCED.matches) {
    await document.startViewTransition(() => renderFn()).updateCallbackDone;
  } else {
    await renderFn();
    enterView(view);
  }
}

export function stagger(container, selector) {
  if (REDUCED.matches || !container) return;
  [...container.querySelectorAll(selector)].slice(0, 8).forEach((el, i) => {
    el.style.setProperty('--stagger-i', i);
    el.classList.add('anim-rise');
  });
}

export function pop(el) {
  if (REDUCED.matches || !el?.animate) return;
  el.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }],
    { duration: 200, easing: 'ease-out' }
  );
}

export function countUp(el, target) {
  const n = Number(target) || 0;
  if (REDUCED.matches || n < 2) {
    el.textContent = String(n);
    return;
  }
  const start = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - start) / 500);
    el.textContent = String(Math.round(n * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ── busy buttons ─────────────────────────────────────────────────────────
export function setBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = busy;
  btn.classList.toggle('loading', busy);
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
}

// ── toasts ───────────────────────────────────────────────────────────────
function toastRegion() {
  let region = document.getElementById('toast-region');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toast-region';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  return region;
}

export function toast(kind, text) {
  const region = toastRegion();
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  node.textContent = text;
  region.appendChild(node);
  requestAnimationFrame(() => node.classList.add('in'));
  setTimeout(() => {
    node.classList.add('out');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    if (REDUCED.matches) node.remove();
  }, 4000);
}

// ── skeletons ────────────────────────────────────────────────────────────
const skelLine = (w) => `<div class="skel skel-line" data-w="${w}"></div>`;

export function skelCases(n = 3) {
  return `<div class="case-list">${Array.from({ length: n }, () =>
    `<div class="case-card skel-card">${skelLine('60')}${skelLine('35')}${skelLine('80')}</div>`
  ).join('')}</div>`;
}

export function skelCaseDetail() {
  return `<div class="card skel-card">${skelLine('40')}${skelLine('90')}${skelLine('75')}</div>
    <div class="card skel-card">${skelLine('30')}${skelLine('85')}${skelLine('85')}${skelLine('50')}</div>`;
}

export function skelTable(rows = 4) {
  return `<div class="card skel-card">${Array.from({ length: rows }, () => skelLine('90')).join('')}</div>`;
}

export function skelForm() {
  return `<div class="card skel-card">${skelLine('30')}${skelLine('100')}${skelLine('25')}${skelLine('100')}</div>`;
}

// ── empty states ─────────────────────────────────────────────────────────
export function emptyState({ icon = 'file', title, body = '', actionHref = '', actionLabel = '' }) {
  return `
    <div class="empty-state">
      <div class="empty-icon">${ICONS[icon] || ICONS.file}</div>
      <h3>${escText(title)}</h3>
      ${body ? `<p class="muted small">${escText(body)}</p>` : ''}
      ${actionHref ? `<p><a class="btn" href="${escAttr(actionHref)}">${escText(actionLabel)}</a></p>` : ''}
    </div>`;
}

// ── bottom sheets ────────────────────────────────────────────────────────
// openSheet returns the sheet element; caller fills sheet.querySelector('.sheet-body').
export function openSheet(title, bodyHtml) {
  closeSheet();
  const overlay = document.createElement('div');
  overlay.id = 'sheet-overlay';
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${escAttr(title)}">
      <div class="sheet-grab" aria-hidden="true"></div>
      <div class="sheet-head"><strong>${escText(title)}</strong>
        <button class="sheet-close" type="button" aria-label="Close">✕</button></div>
      <div class="sheet-body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  const close = () => closeSheet();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.sheet-close').addEventListener('click', close);
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  return overlay.querySelector('.sheet-body');
}

export function closeSheet() {
  const overlay = document.getElementById('sheet-overlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  if (REDUCED.matches) overlay.remove();
  else setTimeout(() => overlay.remove(), 320);
}

// ── date chips ───────────────────────────────────────────────────────────
export function dueChip(dateStr) {
  if (!dateStr) return '';
  const due = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(due.getTime())) return '';
  const days = Math.round((due - new Date().setHours(12, 0, 0, 0)) / 86400000);
  if (days < 0) return '<span class="due-chip overdue">Overdue</span>';
  if (days === 0) return '<span class="due-chip today">Today</span>';
  if (days === 1) return '<span class="due-chip soon">Tomorrow</span>';
  if (days <= 7) return `<span class="due-chip soon">${days} days</span>`;
  return `<span class="due-chip">${days} days</span>`;
}

// ── shared polite live region ────────────────────────────────────────────
let liveRegion = null;
export function announce(text) {
  if (!liveRegion) {
    liveRegion = document.createElement('div');
    liveRegion.id = 'live-region';
    liveRegion.className = 'sr-only';
    liveRegion.setAttribute('aria-live', 'polite');
    document.body.appendChild(liveRegion);
  }
  liveRegion.textContent = '';
  requestAnimationFrame(() => { liveRegion.textContent = text; });
}

// ── confirm sheet (approve-before-send flows) ────────────────────────────
// Shows exactly what will happen; resolves true on confirm, false otherwise.
export function confirmSheet({ title, bodyHtml, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const body = openSheet(title, `${bodyHtml}
      <p class="sheet-actions">
        <button class="btn ${danger ? 'danger' : ''}" type="button" data-confirm>${confirmLabel}</button>
        <button class="btn quiet" type="button" data-cancel>Cancel</button>
      </p>`);
    let done = false;
    const finish = (v) => { if (!done) { done = true; closeSheet(); resolve(v); } };
    body.querySelector('[data-confirm]').addEventListener('click', () => finish(true));
    body.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
    document.getElementById('sheet-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'sheet-overlay') finish(false);
    });
  });
}

// ── printing ─────────────────────────────────────────────────────────────
// Browsers use document.title as the default "Save as PDF" filename —
// which matters for a document Kelly emails to HR.
export function printDoc(title) {
  const previous = document.title;
  if (title) document.title = title;
  window.print();
  setTimeout(() => { document.title = previous; }, 500);
}

// ── JE skeletons ─────────────────────────────────────────────────────────
export function skelFactors(n = 6) {
  return `<div class="factor-list">${Array.from({ length: n }, () =>
    `<div class="factor-row skel-card">${skelLine('55')}${skelLine('30')}</div>`
  ).join('')}</div>`;
}

export function skelReport() {
  return `<div class="card skel-card">${skelLine('45')}${skelLine('90')}${skelLine('85')}${skelLine('70')}${skelLine('88')}</div>`;
}
