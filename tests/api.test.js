import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolated environment must be set before the app is imported.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-test-'));
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

// Minimal client with a cookie jar per user.
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
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  };
}

async function registerAndVerify(api, email, name) {
  const reg = await api('/api/auth/register', { method: 'POST', body: { email, password: 'longpassword-1', displayName: name, payBand: 'band_5' } });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  // Tests may read the DB directly to simulate clicking the emailed link.
  db.prepare(`UPDATE users SET status = 'active', email_verified_at = datetime('now') WHERE id = ?`).run(userId);
  const login = await api('/api/auth/login', { method: 'POST', body: { email, password: 'longpassword-1' } });
  assert.equal(login.status, 200);
  return userId;
}

const admin = client();
const memberA = client();
const memberB = client();

test('unverified account cannot sign in', async () => {
  const api = client();
  // Band is required at sign-up — missing or invalid values are rejected.
  const noBand = await api('/api/auth/register', { method: 'POST', body: { email: 'unverified@example.com', password: 'longpassword-1', displayName: 'Unverified' } });
  assert.equal(noBand.status, 400);
  const badBand = await api('/api/auth/register', { method: 'POST', body: { email: 'unverified@example.com', password: 'longpassword-1', displayName: 'Unverified', payBand: 'band_11' } });
  assert.equal(badBand.status, 400);
  await api('/api/auth/register', { method: 'POST', body: { email: 'unverified@example.com', password: 'longpassword-1', displayName: 'Unverified', payBand: 'band_6' } });
  const login = await api('/api/auth/login', { method: 'POST', body: { email: 'unverified@example.com', password: 'longpassword-1' } });
  assert.equal(login.status, 403);
});

test('main admin can sign in with the configured initial password', async () => {
  const login = await admin('/api/auth/login', { method: 'POST', body: { email: 'mapadocrew@gmail.com', password: 'admin-test-password-1' } });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.isMainAdmin, true);
  assert.ok(login.data.user.permissions.includes('users.manage'));
});

let caseId;

test('member A creates a case; urgency rules fire', async () => {
  await registerAndVerify(memberA, 'membera@example.com', 'Member A');
  const res = await memberA('/api/cases', {
    method: 'POST',
    body: { whatHappened: 'I have been suspended pending an investigation meeting next week', caseType: 'disciplinary' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.urgent, true);
  caseId = res.data.caseId;
});

test('member B cannot see or message member A case', async () => {
  await registerAndVerify(memberB, 'memberb@example.com', 'Member B');
  const view = await memberB(`/api/cases/${caseId}`);
  assert.equal(view.status, 404); // existence not revealed
  const msg = await memberB(`/api/cases/${caseId}/messages`, { method: 'POST', body: { content: 'intrusion' } });
  assert.equal(msg.status, 404);
  const list = await memberB('/api/cases');
  assert.equal(list.data.cases.length, 0);
});

test('member cannot access advisor or admin routes', async () => {
  assert.equal((await memberA('/api/advisor/queue')).status, 403);
  assert.equal((await memberA(`/api/advisor/cases/${caseId}`)).status, 403);
  assert.equal((await memberA('/api/admin/users')).status, 403);
  assert.equal((await memberA('/api/admin/settings')).status, 403);
  assert.equal((await memberA('/api/knowledge/sources')).status, 403);
});

test('state-changing requests without the CSRF header are rejected', async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'x@example.com', password: 'y' }),
  });
  assert.equal(res.status, 403);
});

test('admin grants advisor role to member B; B gains queue access', async () => {
  const bId = db.prepare('SELECT id FROM users WHERE email = ?').get('memberb@example.com').id;
  const grant = await admin(`/api/admin/users/${bId}/roles`, { method: 'POST', body: { role: 'advisor', action: 'add' } });
  assert.equal(grant.status, 200);
  const queue = await memberB('/api/advisor/queue');
  assert.equal(queue.status, 200);
  const card = queue.data.cases.find((c) => c.id === caseId);
  assert.ok(card);
  // Queue cards expose who spoke last, powering the "member replied" bucket.
  assert.equal(card.lastMessageBy, 'member');
  assert.ok(card.lastMessageAt);
});

test('advisor B can open the case; advisor reply reaches member A only as member-visible', async () => {
  const detail = await memberB(`/api/advisor/cases/${caseId}`);
  assert.equal(detail.status, 200);
  const note = await memberB(`/api/advisor/cases/${caseId}/notes`, { method: 'POST', body: { content: 'private strategy note' } });
  assert.equal(note.status, 200);
  const reply = await memberB(`/api/advisor/cases/${caseId}/reply`, { method: 'POST', body: { kind: 'question', content: 'When did the suspension letter arrive?' } });
  assert.equal(reply.status, 200);

  const memberView = await memberA(`/api/cases/${caseId}`);
  const contents = memberView.data.messages.map((m) => m.content);
  assert.ok(contents.includes('When did the suspension letter arrive?'));
  assert.ok(!contents.includes('private strategy note')); // private notes never leak
  assert.equal(memberView.data.case.status, 'need_member_info');
});

test('member reply flips status back to waiting for Kelly', async () => {
  await memberA(`/api/cases/${caseId}/messages`, { method: 'POST', body: { content: 'The letter arrived on Monday.' } });
  const view = await memberA(`/api/cases/${caseId}`);
  assert.equal(view.data.case.status, 'waiting_for_kelly');
});

test('revoking a permission overrides the role default', async () => {
  const bId = db.prepare('SELECT id FROM users WHERE email = ?').get('memberb@example.com').id;
  const revoke = await admin(`/api/admin/users/${bId}/permissions`, { method: 'POST', body: { permission: 'cases.notes', mode: 'revoke' } });
  assert.equal(revoke.status, 200);
  const note = await memberB(`/api/advisor/cases/${caseId}/notes`, { method: 'POST', body: { content: 'should fail' } });
  assert.equal(note.status, 403);
  // clear restores the role default
  await admin(`/api/admin/users/${bId}/permissions`, { method: 'POST', body: { permission: 'cases.notes', mode: 'clear' } });
  const note2 = await memberB(`/api/advisor/cases/${caseId}/notes`, { method: 'POST', body: { content: 'works again' } });
  assert.equal(note2.status, 200);
});

test('only the main admin can grant the admin role; main admin is untouchable', async () => {
  const bId = db.prepare('SELECT id FROM users WHERE email = ?').get('memberb@example.com').id;
  const adminId = db.prepare('SELECT id FROM users WHERE email = ?').get('mapadocrew@gmail.com').id;

  // Give B users.manage via permission grant (main admin can do this).
  await admin(`/api/admin/users/${bId}/permissions`, { method: 'POST', body: { permission: 'users.manage', mode: 'grant' } });

  // B (not main admin) cannot grant admin role or admin permissions.
  const aId = db.prepare('SELECT id FROM users WHERE email = ?').get('membera@example.com').id;
  const tryAdminRole = await memberB(`/api/admin/users/${aId}/roles`, { method: 'POST', body: { role: 'admin', action: 'add' } });
  assert.equal(tryAdminRole.status, 403);
  const tryAdminPerm = await memberB(`/api/admin/users/${aId}/permissions`, { method: 'POST', body: { permission: 'system.admin', mode: 'grant' } });
  assert.equal(tryAdminPerm.status, 403);

  // Nobody can modify the main admin account.
  const touchMain = await memberB(`/api/admin/users/${adminId}/roles`, { method: 'POST', body: { role: 'member', action: 'add' } });
  assert.equal(touchMain.status, 403);
  const disableMain = await admin(`/api/admin/users/${adminId}/status`, { method: 'POST', body: { status: 'disabled' } });
  assert.equal(disableMain.status, 403);
});

test('disabled account loses access immediately', async () => {
  const aId = db.prepare('SELECT id FROM users WHERE email = ?').get('membera@example.com').id;
  await admin(`/api/admin/users/${aId}/status`, { method: 'POST', body: { status: 'disabled' } });
  const res = await memberA('/api/cases');
  assert.equal(res.status, 401); // session revoked
  await admin(`/api/admin/users/${aId}/status`, { method: 'POST', body: { status: 'active' } });
});

test('knowledge source ingestion, versioning and retrieval isolation', async () => {
  const add = await admin('/api/knowledge/sources', {
    method: 'POST',
    body: {
      title: 'Acas Code of Practice on disciplinary and grievance procedures',
      publisher: 'Acas', sourceType: 'acas', versionLabel: '2026-01',
      content: 'Where an employee is suspended pending investigation, suspension should be as brief as possible and kept under review. Suspension is not a disciplinary sanction.\n\nEmployees should be informed in writing of the allegations and given the opportunity to respond before any hearing takes place.',
    },
  });
  assert.equal(add.status, 200);
  assert.ok(add.data.chunkCount >= 1);

  const ver = await admin(`/api/knowledge/sources/${add.data.sourceId}/versions`, {
    method: 'POST',
    body: { versionLabel: '2026-02', content: 'Updated guidance: where an employee is suspended pending investigation, alternatives to suspension should first be considered. Suspension should be as brief as possible.\n\nEmployees must be informed in writing of allegations.' },
  });
  assert.equal(ver.status, 200);

  const superseded = db.prepare(`SELECT review_status FROM knowledge_versions WHERE source_id = ? ORDER BY id`).all(add.data.sourceId);
  assert.deepEqual(superseded.map((v) => v.review_status), ['superseded', 'approved']);

  const { retrieveChunks } = await import('../src/ai/retrieve.js');
  const hits = retrieveChunks('suspended pending investigation suspension');
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.version_label === '2026-02')); // superseded excluded
});

test('AI settings: kill switch and key handling never echo the key', async () => {
  const set = await admin('/api/admin/settings', { method: 'POST', body: { openaiApiKey: 'sk-test-000000000000000000000000', aiModel: 'gpt-5.1' } });
  assert.equal(set.status, 200);
  const get = await admin('/api/admin/settings');
  assert.equal(get.data.aiConfigured, true);
  assert.equal(get.data.openaiKeyMasked, 'sk-…0000');
  assert.ok(!JSON.stringify(get.data).includes('sk-test-0000000000'));
  const kill = await admin('/api/admin/settings', { method: 'POST', body: { aiDisabled: true } });
  assert.equal(kill.status, 200);
  const { aiEnabled } = await import('../src/ai/intake.js');
  assert.equal(aiEnabled(), false);
  await admin('/api/admin/settings', { method: 'POST', body: { aiDisabled: false } });
  assert.equal(aiEnabled(), true);
  await admin('/api/admin/settings', { method: 'POST', body: { clearOpenaiApiKey: true } });
  assert.equal(aiEnabled(), false);
});

test('audit log records sensitive actions without narrative', async () => {
  const audit = await admin('/api/admin/audit');
  assert.equal(audit.status, 200);
  const actions = audit.data.events.map((e) => e.action);
  for (const expected of ['case.created', 'role.add', 'permission.revoke', 'user.disabled', 'settings.updated', 'knowledge.source_added']) {
    assert.ok(actions.includes(expected), `missing audit action ${expected}`);
  }
  // No case narrative appears in the audit trail.
  assert.ok(!JSON.stringify(audit.data).includes('suspended pending an investigation'));
});
