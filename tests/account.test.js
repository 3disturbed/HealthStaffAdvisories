import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-account-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tmp;
process.env.ADMIN_INITIAL_PASSWORD = 'admin-test-password-1';

const { app } = await import('../src/server.js');
const { db } = await import('../src/db/connection.js');

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
  return async (pathname, { method = 'GET', body, formData } = {}) => {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        'x-requested-with': 'fetch',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : formData,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  };
}

async function registerVerifyLogin(api, email, name) {
  await api('/api/auth/register', { method: 'POST', body: { email, password: 'longpassword-1', displayName: name } });
  const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  db.prepare(`UPDATE users SET status = 'active', email_verified_at = datetime('now') WHERE id = ?`).run(userId);
  const login = await api('/api/auth/login', { method: 'POST', body: { email, password: 'longpassword-1' } });
  assert.equal(login.status, 200);
  return userId;
}

const member = client();
const memberSecondDevice = client();
const advisor = client();
let memberId;
let caseId;

test('setup: member (two devices), advisor, case', async () => {
  memberId = await registerVerifyLogin(member, 'account-member@example.com', 'Account Member');
  const login2 = await memberSecondDevice('/api/auth/login', { method: 'POST', body: { email: 'account-member@example.com', password: 'longpassword-1' } });
  assert.equal(login2.status, 200);
  const advisorId = await registerVerifyLogin(advisor, 'account-advisor@example.com', 'Account Advisor');
  db.prepare('INSERT INTO user_roles (user_id, role) VALUES (?, ?)').run(advisorId, 'advisor');

  const c = await member('/api/cases', {
    method: 'POST',
    body: { whatHappened: 'My annual leave calculation looks wrong this year', caseType: 'pay' },
  });
  assert.equal(c.status, 200);
  caseId = c.data.caseId;
});

test('sessions list shows both devices with exactly one current', async () => {
  const res = await member('/api/account/sessions');
  assert.equal(res.status, 200);
  assert.equal(res.data.sessions.length, 2);
  assert.equal(res.data.sessions.filter((s) => s.current).length, 1);
});

test('wrong current password is rejected', async () => {
  const res = await member('/api/account/password', {
    method: 'POST',
    body: { currentPassword: 'not-the-password', newPassword: 'brand-new-password-1' },
  });
  assert.equal(res.status, 400);
});

test('password change keeps this session and kills the other device', async () => {
  const res = await member('/api/account/password', {
    method: 'POST',
    body: { currentPassword: 'longpassword-1', newPassword: 'brand-new-password-1' },
  });
  assert.equal(res.status, 200);
  assert.equal((await member('/api/account')).status, 200); // current session alive
  assert.equal((await memberSecondDevice('/api/account')).status, 401); // other device out
  const relogin = await memberSecondDevice('/api/auth/login', { method: 'POST', body: { email: 'account-member@example.com', password: 'brand-new-password-1' } });
  assert.equal(relogin.status, 200);
});

test('revoke-others signs out the other device only', async () => {
  const res = await member('/api/account/sessions/revoke-others', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await member('/api/account')).status, 200);
  assert.equal((await memberSecondDevice('/api/account')).status, 401);
});

test('display name change is reflected in auth/me', async () => {
  await member('/api/account/profile', { method: 'POST', body: { displayName: 'Renamed Member' } });
  const me = await member('/api/auth/me');
  assert.equal(me.data.user.displayName, 'Renamed Member');
});

test('email preference off suppresses notification email but not in-app or account email', async () => {
  await member('/api/account/email-notifications', { method: 'POST', body: { enabled: false } });
  const mailBefore = db.prepare('SELECT COUNT(*) AS n FROM outbound_emails WHERE to_email = ?').get('account-member@example.com').n;

  const reply = await advisor(`/api/advisor/cases/${caseId}/reply`, { method: 'POST', body: { kind: 'message', content: 'Thanks, looking into it.' } });
  assert.equal(reply.status, 200);

  const mailAfter = db.prepare('SELECT COUNT(*) AS n FROM outbound_emails WHERE to_email = ?').get('account-member@example.com').n;
  assert.equal(mailAfter, mailBefore); // no notification email sent
  const inApp = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(memberId).n;
  assert.ok(inApp > 0); // in-app notification still recorded

  // Account emails (password reset) are unaffected by the preference.
  await member('/api/auth/request-reset', { method: 'POST', body: { email: 'account-member@example.com' } });
  const mailReset = db.prepare('SELECT COUNT(*) AS n FROM outbound_emails WHERE to_email = ?').get('account-member@example.com').n;
  assert.equal(mailReset, mailBefore + 1);
});

let docId;

test('evidence: upload + statement lands as labelled entry with attachments', async () => {
  const formData = new FormData();
  formData.append('file', new Blob(['Shift rota for March showing missing leave days'], { type: 'text/plain' }), 'rota-march.txt');
  const up = await member(`/api/cases/${caseId}/documents`, { method: 'POST', formData });
  assert.equal(up.status, 200);
  docId = up.data.document.id;

  const ev = await member(`/api/cases/${caseId}/evidence`, {
    method: 'POST',
    body: { statement: 'This rota shows my leave was recorded wrongly in March.', documentIds: [docId] },
  });
  assert.equal(ev.status, 200);

  const memberView = await member(`/api/cases/${caseId}`);
  const evidence = memberView.data.messages.find((m) => m.kind === 'evidence');
  assert.ok(evidence);
  assert.equal(evidence.attachments.length, 1);
  assert.equal(evidence.attachments[0].filename, 'rota-march.txt');

  const advisorView = await advisor(`/api/advisor/cases/${caseId}`);
  const advisorEvidence = advisorView.data.messages.find((m) => m.kind === 'evidence');
  assert.ok(advisorEvidence);
  assert.equal(advisorEvidence.attachments[0].id, docId);
});

test('evidence rejects foreign documents, foreign cases and closed cases', async () => {
  // Advisor-owned doc cannot be attached by the member (wrong owner/case).
  const bad = await member(`/api/cases/${caseId}/evidence`, {
    method: 'POST',
    body: { statement: 'Trying to attach a document that is not mine here.', documentIds: [999] },
  });
  assert.equal(bad.status, 400);

  const intruder = client();
  await registerVerifyLogin(intruder, 'account-intruder@example.com', 'Intruder');
  const foreign = await intruder(`/api/cases/${caseId}/evidence`, {
    method: 'POST',
    body: { statement: 'I should not be able to touch this case.', documentIds: [docId] },
  });
  assert.equal(foreign.status, 404);

  db.prepare(`UPDATE cases SET status = 'closed' WHERE id = ?`).run(caseId);
  const closed = await member(`/api/cases/${caseId}/evidence`, {
    method: 'POST',
    body: { statement: 'This case is closed so this should fail.', documentIds: [docId] },
  });
  assert.equal(closed.status, 400);
  db.prepare(`UPDATE cases SET status = 'gathering' WHERE id = ?`).run(caseId);
});

test('audit records events without the statement text', async () => {
  const events = db.prepare('SELECT action, meta FROM audit_events').all();
  const actions = events.map((e) => e.action);
  for (const expected of ['auth.password_changed', 'account.sessions_revoked', 'account.email_pref', 'case.evidence_submitted']) {
    assert.ok(actions.includes(expected), `missing ${expected}`);
  }
  assert.ok(!JSON.stringify(events).includes('recorded wrongly in March'));
});
