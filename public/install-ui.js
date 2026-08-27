import { esc } from '/common.js';

// Install guidance that is ALWAYS actionable. Relying on the browser's
// beforeinstallprompt alone means most users see nothing: Safari and Firefox
// never fire it, Chrome fires it only when its own criteria are met, and it
// never fires over plain http:// on a LAN address. So we detect the
// situation and always tell the user how to install on their device.

export function installState() {
  const ua = navigator.userAgent;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  // iPadOS 13+ reports itself as a Mac, so treat a touch-capable Mac as iOS.
  const ios = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const firefox = /firefox|fxios/i.test(ua);
  const chromium = /chrome|chromium|edg|crios/i.test(ua) && !firefox;
  const android = /android/i.test(ua);

  if (standalone) return { kind: 'installed' };
  if (!window.isSecureContext) return { kind: 'insecure' };
  if (window.__kellyInstallPrompt) return { kind: 'prompt' };
  if (ios) return { kind: 'ios' };
  if (android && chromium) return { kind: 'android-menu' };
  if (chromium) return { kind: 'desktop-menu' };
  if (firefox) return { kind: 'unsupported' };
  return { kind: 'generic' };
}

const BODY = {
  installed: '<p class="small">✅ Kelly Online is installed on this device. Open it from your home screen or app list.</p>',
  insecure:
    '<p class="small">Installing requires a secure (<strong>https://</strong>) connection. You are viewing this over plain http, so your browser will not offer installation. Use the site’s https address, or open it on <strong>localhost</strong> during development.</p>',
  prompt:
    '<p class="small muted">Install Kelly Online on this device — it opens full screen from your home screen, with no browser bars.</p>',
  ios:
    '<p class="small">On iPhone or iPad, open this page in <strong>Safari</strong>, tap the <strong>Share</strong> button (the square with an arrow), then choose <strong>Add to Home Screen</strong>.</p>',
  'android-menu':
    '<p class="small">Tap your browser’s <strong>⋮ menu</strong>, then choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p>',
  'desktop-menu':
    '<p class="small">Look for the <strong>install icon</strong> (a screen with a downward arrow) at the right-hand end of the address bar, or open the <strong>⋮ menu → Cast, save and share → Install page as app</strong>. If it is not offered yet, browse the site for a few moments and check again.</p>',
  unsupported:
    '<p class="small">This browser does not support installing web apps. Open Kelly Online in <strong>Chrome</strong>, <strong>Edge</strong> or (on iPhone/iPad) <strong>Safari</strong> to install it.</p>',
  generic:
    '<p class="small">Use your browser’s menu and look for <strong>Install app</strong> or <strong>Add to Home Screen</strong>.</p>',
};

// `variant`: 'card' for the dashboard (dismissable), 'section' for Account.
export function installPanel({ variant = 'card' } = {}) {
  const state = installState();
  if (variant === 'card') {
    if (state.kind === 'installed') return '';
    if (localStorage.getItem('kelly-install-dismissed')) return '';
  }
  const heading = state.kind === 'installed' ? 'App installed' : 'Get the Kelly Online app';
  return `
    <div class="card" id="install-card">
      <h3 class="mt0"><img src="/icons/icon-192.png" alt="" width="28" height="28" style="vertical-align:-6px"> ${esc(heading)}</h3>
      ${BODY[state.kind]}
      <p>
        ${state.kind === 'prompt' ? '<button class="btn" id="install-app">Install app</button>' : ''}
        ${variant === 'card' && state.kind !== 'installed' ? '<button class="btn quiet small" id="install-dismiss">Not now</button>' : ''}
      </p>
    </div>`;
}

export function wireInstallPanel(onChange) {
  document.getElementById('install-app')?.addEventListener('click', async () => {
    const deferred = window.__kellyInstallPrompt;
    if (!deferred) return;
    deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === 'accepted') window.__kellyInstallPrompt = null;
    onChange?.();
  });
  document.getElementById('install-dismiss')?.addEventListener('click', () => {
    localStorage.setItem('kelly-install-dismissed', '1');
    document.getElementById('install-card')?.remove();
  });
}
