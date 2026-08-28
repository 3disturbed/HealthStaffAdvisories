// Header hamburger + slide-in drawer.
//
// The header can only hold a handful of top-level links (and hides all of them
// on mobile, where the five-slot tab bar takes over), so the deep sections —
// the ten admin tabs, the band review workspaces — were reachable only from
// inside their own page. The drawer lists every destination the account holds,
// from anywhere on the site.
//
// Behaviour follows openSheet() in /ui.js — scrim click, Escape, .open applied
// on the next frame — plus the focus trap a navigation dialog needs. Styling
// lives in styles.css (strict CSP: no inline style or handler).
import { ICONS, REDUCED } from '/ui.js';
import { escAttr } from '/escape.js';
import { menuGroups } from '/nav-model.js';

const PANEL_ID = 'nav-drawer';

let overlay = null;
let toggle = null;
let signOutFn = null;

// Does this href point at what the browser is showing right now?
function isHere(href) {
  const [path, hash] = href.split('#');
  if (path !== window.location.pathname) return false;
  if (!hash) return true;
  const want = `#${hash}`;
  const now = window.location.hash || '#/';
  if (want === '#/') return now === '#/' || now === '';
  return now === want || now.startsWith(`${want}/`);
}

function focusables() {
  return [...overlay.querySelectorAll('a[href], button:not([disabled])')];
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
    return;
  }
  if (e.key !== 'Tab') return;
  // Trap: Tab past either end wraps inside the panel rather than escaping to
  // the page behind the scrim.
  const items = focusables();
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

export function close({ restoreFocus = true } = {}) {
  if (!overlay) return;
  const node = overlay;
  overlay = null;
  document.removeEventListener('keydown', onKeydown);
  document.body.classList.remove('drawer-open');
  node.classList.remove('open');
  if (REDUCED.matches) node.remove();
  else setTimeout(() => node.remove(), 320);
  if (toggle) {
    toggle.setAttribute('aria-expanded', 'false');
    toggle.removeAttribute('aria-controls');
    if (restoreFocus) toggle.focus();
  }
}

function open(user) {
  if (overlay) return;
  const groups = menuGroups(user);
  overlay = document.createElement('div');
  overlay.id = PANEL_ID;
  overlay.className = 'nav-drawer';
  overlay.innerHTML = `
    <div class="nav-drawer-panel" role="dialog" aria-modal="true" aria-label="Menu">
      <div class="nav-drawer-head">
        <strong>Menu</strong>
        <button class="nav-drawer-close" type="button" aria-label="Close menu">✕</button>
      </div>
      <nav class="nav-drawer-nav" aria-label="Sections">
        ${groups.map((group) => `
          <h2 class="nav-drawer-group">${escAttr(group.title)}</h2>
          ${group.items.map((item) => `
            <a href="${escAttr(item.href)}" data-menu="${escAttr(item.id)}"${isHere(item.href) ? ' aria-current="page"' : ''}>${escAttr(item.label)}</a>`).join('')}`).join('')}
      </nav>
    </div>`;
  document.body.appendChild(overlay);
  document.body.classList.add('drawer-open');
  requestAnimationFrame(() => overlay?.classList.add('open'));

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.nav-drawer-close').addEventListener('click', () => close());
  // Optional: an anonymous menu has no sign-out item.
  overlay.querySelector('[data-menu="logout"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    close({ restoreFocus: false });
    signOutFn?.();
  });
  // Same-page hash links do not reload, so the drawer has to stand down itself.
  overlay.querySelectorAll('a[href]:not([data-menu="logout"])').forEach((a) =>
    a.addEventListener('click', () => close({ restoreFocus: false })));

  document.addEventListener('keydown', onKeydown);
  focusables()[0]?.focus();

  if (toggle) {
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-controls', PANEL_ID);
  }
}

// Appends the toggle to the header nav. Mounted for every visitor: the header
// carries no links of its own, so this is the only way into the rest of the
// site besides the mobile tab bar.
export function mountNavDrawer(nav, user, signOut) {
  signOutFn = signOut;
  toggle = document.createElement('button');
  toggle.className = 'nav-toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Menu');
  toggle.setAttribute('aria-haspopup', 'dialog');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = ICONS.menu;
  toggle.addEventListener('click', () => (overlay ? close() : open(user)));
  nav.appendChild(toggle);
  return toggle;
}
