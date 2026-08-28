import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-static-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tmp;
process.env.ADMIN_INITIAL_PASSWORD = 'admin-test-password-1';

const { app } = await import('../src/server.js');
const { BUILD_VERSION } = await import('../src/version.js');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('entry documents are never cached, so a new build is always discoverable', async () => {
  const res = await fetch(`${base}/portal.html`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-app-version'), BUILD_VERSION);
});

test('scripts and styles must revalidate before reuse', async () => {
  for (const asset of ['/common.js', '/escape.js', '/markdown.js', '/faq.js', '/faq-ui.js', '/faq-admin.js', '/styles.css', '/version-check.js', '/pwa-early.js']) {
    const res = await fetch(base + asset);
    assert.equal(res.status, 200, `${asset} should be served`);
    assert.equal(res.headers.get('cache-control'), 'no-cache', `${asset} should revalidate`);
    assert.ok(res.headers.get('etag'), `${asset} needs an ETag to revalidate cheaply`);
  }
});

test('unchanged assets revalidate to a cheap 304', async () => {
  const first = await fetch(`${base}/common.js`);
  const etag = first.headers.get('etag');
  // Raw http: node's fetch always sends `cache-control: no-cache`, which
  // (correctly) forces a full response and would hide the 304 path.
  const status = await new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: server.address().port, path: '/common.js', headers: { 'If-None-Match': etag } },
      (res) => { res.resume(); resolve(res.statusCode); }
    );
    req.on('error', reject);
  });
  assert.equal(status, 304);
});

test('version endpoint reports the build fingerprint and is never cached', async () => {
  const res = await fetch(`${base}/api/version`, { headers: { 'x-requested-with': 'fetch' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.version, BUILD_VERSION);
  assert.match(body.version, /^[0-9a-f]{12}$/);
});

test('the build fingerprint changes when a client asset changes', async () => {
  // Recomputing over a modified public/ must produce a different hash,
  // otherwise clients could never detect that they are stale.
  const target = path.join(process.cwd(), 'public', 'styles.css');
  const original = fs.readFileSync(target);
  try {
    fs.writeFileSync(target, `${original}\n/* cache-busting probe */\n`);
    const { BUILD_VERSION: changed } = await import(`../src/version.js?probe=${Date.now()}`);
    assert.notEqual(changed, BUILD_VERSION);
  } finally {
    fs.writeFileSync(target, original);
  }
});

test('the public FAQ page is an uncached entry document, reachable without a session', async () => {
  for (const url of ['/faq.html', '/faq']) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200, `${url} should be served`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-app-version'), BUILD_VERSION);
  }
});

test('the public FAQ API answers with no cookie at all', async () => {
  const res = await fetch(`${base}/api/faq`);
  assert.equal(res.status, 200, 'the FAQ must be readable while signed out');
  const data = await res.json();
  assert.ok(Array.isArray(data.questions));
  assert.equal(data.level, 'public');
});

test('the FAQ page ships no inline script or handler, so the strict CSP holds', async () => {
  const html = await (await fetch(`${base}/faq.html`)).text();
  const inline = [...html.matchAll(/<script\b([^>]*)>/g)].filter((m) => !/\ssrc=/.test(m[1]));
  assert.deepEqual(inline, [], 'inline <script> is blocked by the CSP');
  assert.ok(!/\son(click|load|error|focus)\s*=/i.test(html), 'inline event handlers are blocked by the CSP');
});
