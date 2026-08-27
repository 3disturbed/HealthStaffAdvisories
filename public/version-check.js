// Staleness self-heal. The browser may hold old JS/CSS from before the
// caching headers existed, from an intermediary cache, or from a long-lived
// tab. We record the build version this page loaded with, re-check it when
// the tab regains focus and periodically, and when the server reports a
// different build we purge every cache, refresh the service worker and
// offer a one-click reload.

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
let loadedVersion = null;
let banner = null;

async function fetchVersion() {
  const res = await fetch('/api/version', { cache: 'no-store', headers: { 'x-requested-with': 'fetch' } });
  if (!res.ok) throw new Error('version unavailable');
  return (await res.json()).version;
}

export async function purgeCaches() {
  if (window.caches?.keys) {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  }
  if (navigator.serviceWorker?.getRegistrations) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.update().catch(() => {})));
  }
}

function showBanner() {
  if (banner) return;
  banner = document.createElement('div');
  banner.className = 'update-banner';
  banner.innerHTML =
    '<span>A new version of Kelly Online is available.</span> <button class="btn small" type="button" id="update-reload">Refresh now</button>';
  document.body.appendChild(banner);
  document.getElementById('update-reload').addEventListener('click', async () => {
    await purgeCaches();
    window.location.reload(); // documents are no-store, so this refetches
  });
}

async function check() {
  try {
    const current = await fetchVersion();
    if (loadedVersion === null) {
      loadedVersion = current;
      return;
    }
    if (current !== loadedVersion) {
      await purgeCaches();
      showBanner();
    }
  } catch {
    // Offline or server restarting — try again on the next tick.
  }
}

export function startVersionWatch() {
  check();
  setInterval(check, CHECK_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  // A *replacement* service worker taking over mid-session means the assets
  // changed. The first registration also fires this, so ignore that case.
  const hadController = !!navigator.serviceWorker?.controller;
  navigator.serviceWorker?.addEventListener?.('controllerchange', () => {
    if (hadController) showBanner();
  });
}
