// Reusable multi-step wizard engine, extracted from the portal case wizard.
// No framework: template-literal HTML into a mount element, re-rendered per
// step. The caller owns state and persistence; the engine owns navigation,
// progress, focus management and the save-state line.
//
// Step definition (same shape the case wizard used):
//   { title, hint, body() -> html, collect() -> bool, error, wire(next),
//     skippable, hideContinue, review, group }
//
// config:
//   mount        element to render into
//   heading      h1 text (html-safe string from the caller)
//   steps        step definitions
//   groups       optional [{ id, label }] — renders a grouped segment bar
//   getStep()/setStep(n)   caller persists the current step
//   onPersist()            called after every collect (sync or async)
//   onSubmit()             review-step submit; caller handles the POST
//   submitLabel            review submit button text
//   exit         optional { href, label } — "Save and finish later"
//   cancelHref   step-1 cancel link
//   saveState    true -> render the autosave status line (caller drives it
//                via the returned setSaveState)
//   announce(text)         polite live-region announcement hook

import { esc } from '/common.js';
import { enterView, setBusy } from '/ui.js';

export function createWizard(config) {
  const {
    mount, heading, steps, groups = null,
    getStep, setStep, onPersist, onSubmit,
    submitLabel = 'Send', exit = null, cancelHref = '#/',
    saveState = false, announce = () => {},
  } = config;

  let saveStateText = '';
  let saveStateKind = '';

  function setSaveState(kind, text) {
    saveStateKind = kind;
    saveStateText = text;
    const el = mount.querySelector('.wiz-save-state');
    if (el) {
      el.textContent = text;
      el.dataset.kind = kind;
      el.hidden = !text;
    }
  }

  function groupBar(step) {
    if (!groups) return '';
    const current = steps[step - 1]?.group;
    const currentIdx = groups.findIndex((g) => g.id === current);
    return `<div class="wiz-groups" aria-hidden="true">${groups
      .map((g, i) => `<span class="wiz-group-seg ${i < currentIdx ? 'done' : i === currentIdx ? 'active' : ''}">${esc(g.label)}</span>`)
      .join('')}</div>`;
  }

  function render() {
    const total = steps.length;
    const step = Math.min(Math.max(getStep(), 1), total);
    const def = steps[step - 1];

    mount.innerHTML = `
      <h1>${heading}</h1>
      <p class="muted small">Step ${step} of ${total}</p>
      ${groupBar(step)}
      <div class="wiz-progress" role="progressbar" aria-valuenow="${step}" aria-valuemin="1" aria-valuemax="${total}" aria-valuetext="Step ${step} of ${total}">
        <div class="wiz-progress-fill" id="wiz-fill"></div></div>
      ${saveState ? `<p class="wiz-save-state" data-kind="${saveStateKind}" ${saveStateText ? '' : 'hidden'}>${esc(saveStateText)}</p>` : ''}
      <div class="card" id="wiz-card">
        <h3 class="mt0" id="wiz-heading" tabindex="-1">${def.title}</h3>
        ${def.hint ? `<p class="hint">${def.hint}</p>` : ''}
        <div id="msg"></div>
        <form id="wiz-form">${def.body()}
          <p>
            ${step > 1 ? '<button class="btn quiet" type="button" id="wiz-back">Back</button>' : `<a class="btn quiet" href="${cancelHref}">Cancel</a>`}
            ${def.hideContinue ? '' : def.review
              ? `<button class="btn" type="submit" id="wiz-submit">${esc(submitLabel)}</button>`
              : `<button class="btn" type="submit">Continue</button>${def.skippable ? '<button class="btn quiet" type="button" id="wiz-skip">Skip for now</button>' : ''}`}
            ${exit && !def.review ? `<a class="btn quiet wiz-exit" href="${exit.href}">${esc(exit.label)}</a>` : ''}
          </p>
        </form>
      </div>`;

    requestAnimationFrame(() => {
      const fill = mount.querySelector('#wiz-fill');
      if (fill) fill.style.transform = `scaleX(${step / total})`;
    });
    enterView(mount.querySelector('#wiz-card'));

    // Keyboard/screen-reader users must not be stranded on <body> after a
    // re-render: focus the step heading and announce the transition.
    const headingEl = mount.querySelector('#wiz-heading');
    headingEl?.focus({ preventScroll: false });
    announce(`Step ${step} of ${total}. ${def.plainTitle || def.title}`);

    const go = async (n) => { setStep(n); await Promise.resolve(onPersist?.()); render(); };

    mount.querySelector('#wiz-back')?.addEventListener('click', async () => {
      def.collect?.();
      await Promise.resolve(onPersist?.());
      go(step - 1);
    });
    mount.querySelector('#wiz-skip')?.addEventListener('click', () => go(step + 1));
    def.wire?.(() => go(step + 1), { render, setSaveState });
    mount.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.goto))));

    mount.querySelector('#wiz-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!def.collect()) {
        mount.querySelector('#msg').innerHTML = `<div class="notice error">${esc(def.error || 'Please check this step.')}</div>`;
        return;
      }
      await Promise.resolve(onPersist?.());
      if (!def.review) return go(step + 1);
      const btn = mount.querySelector('#wiz-submit');
      setBusy(btn, true);
      try {
        await onSubmit();
      } catch (err) {
        setBusy(btn, false);
        mount.querySelector('#msg').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
      }
    });
  }

  return { render, setSaveState };
}
