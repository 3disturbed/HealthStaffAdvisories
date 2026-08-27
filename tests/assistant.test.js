import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-assistant-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tmp;
process.env.ADMIN_INITIAL_PASSWORD = 'admin-test-password-1';

const { app } = await import('../src/server.js');
const { db, setSetting } = await import('../src/db/connection.js');
const { runAssistantTurn, confirmAction, cancelAction } = await import('../src/ai/assistant.js');
const { toolByName } = await import('../src/ai/assistantTools.js');
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

// ── helpers ──────────────────────────────────────────────────────────────
function makeUser(email, roles = [], permissionGrants = []) {
  const id = db
    .prepare(`INSERT INTO users (email, password_hash, display_name, status, email_verified_at) VALUES (?, ?, ?, 'active', datetime('now'))`)
    .run(email, hashPassword('longpassword-1'), email.split('@')[0]).lastInsertRowid;
  for (const role of roles) db.prepare('INSERT INTO user_roles (user_id, role) VALUES (?, ?)').run(id, role);
  for (const p of permissionGrants) {
    db.prepare(`INSERT INTO user_permissions (user_id, permission, mode) VALUES (?, ?, 'grant')`).run(id, p);
  }
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

const toolCallResponse = (name, args, id = `call_${Math.trunc(performance.now() * 1000)}`) => ({
  choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
});
const textResponse = (text) => ({ choices: [{ message: { content: text } }] });

// Scripted fake model: shifts queued responses, records the tools it saw.
function fakeModel(queue) {
  const seen = { toolNames: [], calls: 0 };
  const complete = async (messages, tools) => {
    seen.calls += 1;
    seen.toolNames = tools.map((t) => t.function.name);
    if (queue.length === 0) return textResponse('Done.');
    return queue.shift();
  };
  return { complete, seen };
}

const mainAdmin = () => db.prepare('SELECT * FROM users WHERE is_main_admin = 1').get();

test('routes reject members and anonymous users', async () => {
  const anon = await fetch(`${base}/api/admin/assistant`, { headers: { 'x-requested-with': 'fetch' } });
  assert.equal(anon.status, 401);

  // A member with a real session gets 403.
  makeUser('plain-member@example.com', ['member']);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    body: JSON.stringify({ email: 'plain-member@example.com', password: 'longpassword-1' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${base}/api/admin/assistant`, { headers: { cookie, 'x-requested-with': 'fetch' } });
  assert.equal(res.status, 403);
});

test('tool definitions are filtered to the caller permissions', async () => {
  const reviewer = makeUser('queue-only@example.com', ['member'], ['cases.review']);
  const { complete, seen } = fakeModel([textResponse('Hello.')]);
  await runAssistantTurn(reviewer, 'hello', { complete });
  assert.ok(seen.toolNames.includes('queue_overview'));
  assert.ok(seen.toolNames.includes('case_summary'));
  assert.ok(!seen.toolNames.includes('list_users'));
  assert.ok(!seen.toolNames.includes('grant_role'));
  assert.ok(!seen.toolNames.includes('list_knowledge_sources'));
});

test('read tool executes immediately with no pending action', async () => {
  const admin = mainAdmin();
  const { complete } = fakeModel([
    toolCallResponse('list_users', {}, 'call_read_1'),
    textResponse('There are N users.'),
  ]);
  const state = await runAssistantTurn(admin, 'who has accounts?', { complete });
  assert.equal(state.pending.length, 0);
  const toolRow = db
    .prepare(`SELECT content FROM assistant_messages WHERE user_id = ? AND role = 'tool' AND tool_call_id = 'call_read_1'`)
    .get(admin.id);
  assert.ok(toolRow.content.includes('plain-member@example.com'));
  assert.ok(!toolRow.content.includes('password_hash'));
});

let pendingId;
let targetId;

test('write tool creates a pending action and does NOT execute', async () => {
  const admin = mainAdmin();
  targetId = makeUser('promote-me@example.com', ['member']).id;
  const { complete } = fakeModel([
    toolCallResponse('grant_role', { userId: targetId, role: 'advisor' }, 'call_write_1'),
  ]);
  const state = await runAssistantTurn(admin, 'make promote-me an advisor', { complete });
  assert.equal(state.pending.length, 1);
  pendingId = state.pending[0].id;
  assert.match(state.pending[0].summary, /advisor/);
  const roles = db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(targetId).map((r) => r.role);
  assert.ok(!roles.includes('advisor')); // nothing executed yet
});

test('confirm executes through the guarded service and audits via assistant', async () => {
  const admin = mainAdmin();
  const { complete } = fakeModel([textResponse('Done — advisor role granted.')]);
  const result = await confirmAction(admin, pendingId, { complete });
  assert.equal(result.ok, true);
  const roles = db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(targetId).map((r) => r.role);
  assert.ok(roles.includes('advisor'));
  const auditRows = db.prepare(`SELECT action, meta FROM audit_events WHERE object_id = ? AND action = 'role.add'`).all(String(targetId));
  assert.ok(auditRows.some((r) => JSON.parse(r.meta).via === 'assistant'));
  assert.ok(db.prepare(`SELECT 1 FROM audit_events WHERE action = 'assistant.action_executed'`).get());
});

test('double confirm is rejected as already handled', async () => {
  const result = await confirmAction(mainAdmin(), pendingId, { complete: fakeModel([]).complete });
  assert.equal(result.status, 410);
});

test('expired action cannot be confirmed', async () => {
  const admin = mainAdmin();
  const { complete } = fakeModel([toolCallResponse('remove_role', { userId: targetId, role: 'advisor' }, 'call_write_2')]);
  const state = await runAssistantTurn(admin, 'remove advisor again', { complete });
  const id = state.pending[0].id;
  db.prepare(`UPDATE assistant_actions SET expires_at = datetime('now', '-1 minute') WHERE id = ?`).run(id);
  const result = await confirmAction(admin, id, { complete: fakeModel([]).complete });
  assert.equal(result.status, 410);
  const roles = db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(targetId).map((r) => r.role);
  assert.ok(roles.includes('advisor')); // untouched
});

test('declined action never executes', async () => {
  const admin = mainAdmin();
  const { complete } = fakeModel([toolCallResponse('disable_account', { userId: targetId }, 'call_write_3')]);
  const state = await runAssistantTurn(admin, 'disable that account', { complete });
  const result = cancelAction(admin, state.pending[0].id);
  assert.equal(result.ok, true);
  assert.equal(db.prepare('SELECT status FROM users WHERE id = ?').get(targetId).status, 'active');
});

test('main-admin target is blocked even via confirmed assistant action', async () => {
  const admin = mainAdmin();
  const { complete } = fakeModel([toolCallResponse('remove_role', { userId: admin.id, role: 'admin' }, 'call_write_4')]);
  const state = await runAssistantTurn(admin, 'remove my own admin role', { complete });
  const result = await confirmAction(admin, state.pending[0].id, { complete: fakeModel([]).complete });
  assert.equal(result.ok, false);
  assert.match(result.result.error, /main administration account/);
  assert.ok(db.prepare(`SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'admin'`).get(admin.id));
});

test('permission revoked between propose and confirm is rejected', async () => {
  const manager = makeUser('temp-manager@example.com', ['member'], ['users.manage']);
  const { complete } = fakeModel([toolCallResponse('grant_role', { userId: targetId, role: 'member' }, 'call_write_5')]);
  const state = await runAssistantTurn(manager, 'grant member role', { complete });
  db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(manager.id);
  const result = await confirmAction(manager, state.pending[0].id, { complete: fakeModel([]).complete });
  assert.equal(result.status, 403);
});

test('unknown or unpermitted tool calls become error results, not crashes', async () => {
  const reviewer = db.prepare('SELECT * FROM users WHERE email = ?').get('queue-only@example.com');
  const { complete } = fakeModel([
    toolCallResponse('grant_role', { userId: targetId, role: 'admin' }, 'call_unpermitted'),
    textResponse('I cannot do that.'),
  ]);
  const state = await runAssistantTurn(reviewer, 'make them admin', { complete });
  assert.equal(state.pending.length, 0);
  const toolRow = db
    .prepare(`SELECT content FROM assistant_messages WHERE role = 'tool' AND tool_call_id = 'call_unpermitted'`)
    .get();
  assert.match(toolRow.content, /not available/);
});

test('tool loop stops after the cap', async () => {
  const admin = mainAdmin();
  let n = 0;
  const complete = async () => {
    n += 1;
    return toolCallResponse('queue_overview', {}, `call_loop_${n}`);
  };
  await runAssistantTurn(admin, 'loop forever', { complete });
  assert.equal(n, 6);
});

test('priority and timeline tools rank by urgency then deadline', async () => {
  const owner = makeUser('deadline-member@example.com', ['member']);
  const insertCase = (title, urgency, nextAt) =>
    db.prepare(`INSERT INTO cases (member_id, title, what_happened, urgency, next_important_at) VALUES (?, ?, ?, ?, ?)`)
      .run(owner.id, title, 'test narrative', urgency, nextAt).lastInsertRowid;
  const soonNormal = insertCase('Normal case, deadline soonest', 'normal', '2026-08-28');
  const laterCritical = insertCase('Critical case, later deadline', 'critical', '2026-09-15');
  db.prepare(`INSERT INTO case_timeline (case_id, event_date, description, source) VALUES (?, '2026-09-15', 'Disciplinary hearing', 'ai')`).run(laterCritical);

  // Reviewer without cases.review sees neither tool.
  const reviewer = db.prepare('SELECT * FROM users WHERE email = ?').get('queue-only@example.com');
  const { complete, seen } = fakeModel([textResponse('hi')]);
  await runAssistantTurn(reviewer, 'hi', { complete });
  assert.ok(seen.toolNames.includes('top_priority_cases'));
  assert.ok(seen.toolNames.includes('case_timeline'));

  const ranked = toolByName.get('top_priority_cases').run(reviewer, {}).cases;
  const posCritical = ranked.findIndex((c) => c.id === laterCritical);
  const posNormal = ranked.findIndex((c) => c.id === soonNormal);
  assert.ok(posCritical >= 0 && posNormal >= 0);
  assert.ok(posCritical < posNormal, 'critical urgency outranks a sooner deadline on a normal case');
  assert.equal(ranked[posCritical].nextTimelineEvent.description, 'Disciplinary hearing');
  assert.equal(ranked[posCritical].nextImportantAt, '2026-09-15');

  const timeline = toolByName.get('case_timeline').run(reviewer, { caseId: laterCritical }).timeline;
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].confirmed, false);
  assert.ok(toolByName.get('case_timeline').run(reviewer, { caseId: 99999 }).error);
});

test('kill switch blocks chat but not confirmation of pending actions', async () => {
  const admin = mainAdmin();
  const { complete } = fakeModel([toolCallResponse('grant_role', { userId: targetId, role: 'member' }, 'call_write_6')]);
  const state = await runAssistantTurn(admin, 'one more', { complete });
  const id = state.pending[0].id;

  setSetting('openai_api_key', 'sk-test-000000000000000000000000');
  setSetting('ai_disabled', '1');

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    body: JSON.stringify({ email: 'mapadocrew@gmail.com', password: 'admin-test-password-1' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const chat = await fetch(`${base}/api/admin/assistant/message`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    body: JSON.stringify({ content: 'hello?' }),
  });
  assert.equal(chat.status, 400);

  const confirm = await fetch(`${base}/api/admin/assistant/actions/${id}/confirm`, {
    method: 'POST',
    headers: { cookie, 'x-requested-with': 'fetch' },
  });
  assert.equal(confirm.status, 200);
  setSetting('ai_disabled', '0');
});
