import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolated environment must be set before the app is imported.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-contact-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tmp;
process.env.ADMIN_INITIAL_PASSWORD = 'admin-test-password-1';

const { app } = await import('../src/server.js');
const { db } = await import('../src/db/connection.js');
const { hashPassword } = await import('../src/auth/passwords.js');

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

function client() {
  let cookie = '';
  return async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        'x-requested-with': 'fetch',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const c of setCookie) {
      if (c.startsWith('kelly_session=')) cookie = c.split(';')[0];
    }
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, data, headers: res.headers };
  };
}

const anon = client();
const advisor = client();
const member = client();
const other = client();

const made = {};

function makeMember(email, name) {
  const info = db
    .prepare(`INSERT INTO users (email, password_hash, display_name, status, email_verified_at)
              VALUES (?, ?, ?, 'active', datetime('now'))`)
    .run(email, hashPassword('member-test-password-1'), name);
  db.prepare('INSERT INTO user_roles (user_id, role) VALUES (?, ?)').run(info.lastInsertRowid, 'member');
  return Number(info.lastInsertRowid);
}

test('setup: sign in the admin/advisor account and two members', async () => {
  const login = await advisor('/api/auth/login', {
    method: 'POST',
    body: { email: 'mapadocrew@gmail.com', password: 'admin-test-password-1' },
  });
  assert.equal(login.status, 200, JSON.stringify(login.data));

  made.memberId = makeMember('contact-member@example.com', 'Contact Member');
  made.otherId = makeMember('contact-other@example.com', 'Other Member');

  for (const [c, email] of [[member, 'contact-member@example.com'], [other, 'contact-other@example.com']]) {
    const res = await c('/api/auth/login', { method: 'POST', body: { email, password: 'member-test-password-1' } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
  }
});

// ── public submission ─────────────────────────────────────────────────────
test('anyone can send a message with no session at all', async () => {
  const res = await anon('/api/contact', {
    method: 'POST',
    body: {
      name: 'Anon Visitor',
      email: 'visitor@example.com',
      topic: 'data_rights',
      subject: 'Please delete my data',
      message: 'I closed my account last year and would like everything deleted.',
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.ok, true);
  assert.equal(res.data.signedIn, false);
  // Same URL, different body per session — a shared cache must not reuse it.
  assert.equal(res.headers.get('cache-control'), 'no-store');
  made.anonThreadId = res.data.threadId;

  const row = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(made.anonThreadId);
  assert.equal(row.user_id, null);
  assert.equal(row.topic, 'data_rights');
  assert.equal(row.status, 'new');
});

test('a signed-in sender gets the thread attached to their account', async () => {
  const res = await member('/api/contact', {
    method: 'POST',
    body: { topic: 'billing', subject: 'Membership question', message: 'How does the pilot pricing work after launch?' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.signedIn, true);
  made.memberThreadId = res.data.threadId;
  assert.equal(
    db.prepare('SELECT user_id FROM message_threads WHERE id = ?').get(made.memberThreadId).user_id,
    made.memberId
  );
});

test('crisis wording is flagged urgent and signposted back to the sender', async () => {
  const res = await anon('/api/contact', {
    method: 'POST',
    body: {
      name: 'Worried Person',
      email: 'worried@example.com',
      subject: 'I cannot cope',
      message: 'I have been suspended and I feel suicidal about going back to work.',
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.urgent, true);
  assert.equal(res.data.signpost, true);
  const row = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(res.data.threadId);
  assert.equal(row.urgency, 'critical');
  assert.ok(row.urgency_reason, 'the advisor needs to see why it was raised');
});

test('a filled honeypot looks like success and stores nothing', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM message_threads').get().n;
  const res = await anon('/api/contact', {
    method: 'POST',
    body: { name: 'Bot', email: 'bot@example.com', subject: 'Cheap pills', message: 'Buy now buy now', website: 'http://spam.example' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_threads').get().n, before);
});

test('an incomplete message is refused in plain English', async () => {
  const res = await anon('/api/contact', {
    method: 'POST',
    body: { name: 'Someone', email: 'not-an-email', subject: 'Hi', message: 'Hello there please help' },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /email address/);
});

// ── the advisor queue ─────────────────────────────────────────────────────
test('an account with contact.review sees every thread, sorted urgent first', async () => {
  const res = await advisor('/api/messages?view=all');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.scope, 'staff');
  assert.ok(res.data.threads.length >= 3);
  assert.equal(res.data.threads[0].urgency, 'critical');
  assert.ok(res.data.counts.urgent >= 1);
  assert.ok(res.data.counts.unanswered >= 1);
});

test('a member sees only their own threads', async () => {
  const res = await member('/api/messages');
  assert.equal(res.status, 200);
  assert.equal(res.data.scope, 'own');
  assert.deepEqual(res.data.threads.map((t) => t.id), [made.memberThreadId]);
});

test("another member's thread is a 404, never a 403 that confirms it exists", async () => {
  const res = await other(`/api/messages/${made.memberThreadId}`);
  assert.equal(res.status, 404);
  const reply = await other(`/api/messages/${made.memberThreadId}/reply`, { method: 'POST', body: { body: 'Nosing around.' } });
  assert.equal(reply.status, 404);
});

test('triage needs contact.review', async () => {
  const res = await member(`/api/messages/${made.memberThreadId}/status`, { method: 'POST', body: { status: 'closed' } });
  assert.equal(res.status, 403);
});

test('a revoked contact.review drops an advisor back to their own threads', async () => {
  const advisorId = db.prepare('SELECT id FROM users WHERE email = ?').get('mapadocrew@gmail.com').id;
  // The main admin holds every permission unconditionally, so test the
  // override on a plain advisor account instead.
  const id = makeMember('reviewer@example.com', 'Reviewer');
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id);
  db.prepare('INSERT INTO user_roles (user_id, role) VALUES (?, ?)').run(id, 'advisor');
  const reviewer = client();
  await reviewer('/api/auth/login', { method: 'POST', body: { email: 'reviewer@example.com', password: 'member-test-password-1' } });
  assert.equal((await reviewer('/api/messages')).data.scope, 'staff');

  db.prepare('INSERT INTO user_permissions (user_id, permission, mode) VALUES (?, ?, ?)').run(id, 'contact.review', 'revoke');
  assert.equal((await reviewer('/api/messages')).data.scope, 'own');
  assert.ok(advisorId);
});

// ── replies and notifications ─────────────────────────────────────────────
test('an advisor reply notifies a signed-in sender without emailing the content', async () => {
  const secret = 'The pilot price is frozen until the end of the year.';
  const res = await advisor(`/api/messages/${made.memberThreadId}/reply`, { method: 'POST', body: { body: secret } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.messages.at(-1).authorRole, 'advisor');

  const notif = db.prepare('SELECT * FROM notifications WHERE thread_id = ? ORDER BY id DESC').get(made.memberThreadId);
  assert.ok(notif, 'the sender needs an in-app alert');
  assert.equal(notif.user_id, made.memberId);

  const mail = db.prepare('SELECT * FROM outbound_emails WHERE to_email = ? ORDER BY id DESC').get('contact-member@example.com');
  assert.ok(mail, 'the sender needs a nudge to come and read it');
  assert.ok(!mail.body.includes(secret), 'the reply itself must stay behind the sign-in');
  assert.ok(!mail.subject.includes(secret));
  assert.match(mail.body, /\/inbox\.html/);

  assert.equal(db.prepare('SELECT status FROM message_threads WHERE id = ?').get(made.memberThreadId).status, 'answered');
});

test('the sender can reply in their own thread', async () => {
  const res = await member(`/api/messages/${made.memberThreadId}/reply`, { method: 'POST', body: { body: 'Thanks, that answers it.' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.messages.at(-1).authorRole, 'sender');
  assert.equal(db.prepare('SELECT status FROM message_threads WHERE id = ?').get(made.memberThreadId).status, 'open');
});

test('the unread badge counts both feeds', async () => {
  const res = await member('/api/notifications');
  assert.equal(res.status, 200);
  assert.equal(res.data.unread, res.data.unreadUpdates + res.data.unreadMessages);
});

// ── magic link ────────────────────────────────────────────────────────────
test('an anonymous sender gets a link, not the reply text', async () => {
  const secret = 'Your data will be deleted within thirty days.';
  const res = await advisor(`/api/messages/${made.anonThreadId}/reply`, { method: 'POST', body: { body: secret } });
  assert.equal(res.status, 200, JSON.stringify(res.data));

  const mail = db.prepare('SELECT * FROM outbound_emails WHERE to_email = ? ORDER BY id DESC').get('visitor@example.com');
  assert.ok(mail);
  assert.ok(!mail.body.includes(secret), 'the reply must stay behind the link');
  assert.ok(!mail.subject.includes(secret));
  const match = mail.body.match(/\/thread\.html\?token=([A-Za-z0-9_-]+)/);
  assert.ok(match, 'the email needs a magic link');
  made.token = match[1];

  // Only the hash is stored, so reading the database cannot reopen the thread.
  const stored = db.prepare('SELECT token_hash FROM thread_access_tokens WHERE thread_id = ?').get(made.anonThreadId);
  assert.ok(stored && stored.token_hash !== made.token);
});

test('the magic link opens exactly one thread, and lets the sender answer', async () => {
  const res = await anon('/api/contact/thread', { method: 'POST', body: { token: made.token } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.thread.id, made.anonThreadId);
  assert.equal(res.data.messages.length, 2);

  const reply = await anon('/api/contact/thread/reply', { method: 'POST', body: { token: made.token, body: 'Thank you, that is all I needed.' } });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  assert.equal(reply.data.messages.at(-1).authorRole, 'sender');
});

test('a wrong, empty or expired token opens nothing', async () => {
  for (const token of ['', 'nope', `${made.token}x`]) {
    const res = await anon('/api/contact/thread', { method: 'POST', body: { token } });
    assert.equal(res.status, 404, `token ${JSON.stringify(token)} must not open a thread`);
  }
  db.prepare(`UPDATE thread_access_tokens SET expires_at = datetime('now', '-1 day') WHERE thread_id = ?`).run(made.anonThreadId);
  assert.equal((await anon('/api/contact/thread', { method: 'POST', body: { token: made.token } })).status, 404);
});

test('the magic-link endpoints still require the CSRF header', async () => {
  const res = await fetch(`${base}/api/contact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'X', email: 'x@example.com', subject: 'Hi', message: 'Hello there friend' }),
  });
  assert.equal(res.status, 403);
});

// ── privacy ───────────────────────────────────────────────────────────────
test('no message text reaches the audit log', async () => {
  const rows = db.prepare(`SELECT meta FROM audit_events WHERE action LIKE 'contact.%'`).all();
  assert.ok(rows.length >= 3, 'contact actions should be audited');
  for (const { meta } of rows) {
    assert.ok(!/suicidal|delete my data|pilot price/i.test(meta), `free text leaked into audit meta: ${meta}`);
  }
});

test('the submission endpoint is rate limited', async () => {
  const burst = client();
  const send = (n) => burst('/api/contact', {
    method: 'POST',
    body: { name: 'Repeat', email: 'repeat@example.com', subject: `Message ${n}`, message: 'Please can you help me with something.' },
  });
  let limited = false;
  for (let i = 0; i < 12; i += 1) {
    if ((await send(i)).status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'a flood of submissions must eventually be refused');
});
