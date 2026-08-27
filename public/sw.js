// Kelly Online service worker. Deliberately minimal: everything goes to the
// network (case data must never be served stale), with a friendly offline
// page for navigations. Static freshness is handled by Cache-Control headers.
self.addEventListener('install', () => self.skipWaiting());

// Take control immediately and drop every cache: this worker serves nothing
// from cache, so any cache present belongs to a previous version and would
// only risk serving stale app code.
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  )
);

// Pages can ask for an immediate purge (used by the update banner).
self.addEventListener('message', (event) => {
  if (event.data === 'purge-caches') {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))));
  }
});

const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline — Kelly Online</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f4f7fa;color:#1a2733;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1rem;text-align:center}</style>
</head><body><div><h1>You're offline</h1><p>Kelly Online needs a connection to keep your case data safe and current.<br>Reconnect and try again.</p></div></body></html>`;

self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(
        () => new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html' } })
      )
    );
  }
});
