import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolated environment must be set before the app is imported.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-faq-test-'));
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

// Ids created in "setup", shared by later tests (files run in declaration order).
const made = {};

test('setup: sign in the admin/advisor account and register a member', async () => {
  const login = await advisor('/api/auth/login', {
    method: 'POST',
    body: { email: 'mapadocrew@gmail.com', password: 'admin-test-password-1' },
  });
  assert.equal(login.status, 200, JSON.stringify(login.data));

  // Created directly rather than through /register: this file tests FAQ
  // visibility, and registration's own contract (pay band, verification) is
  // owned by other tests and changes independently.
  const info = db
    .prepare(`INSERT INTO users (email, password_hash, display_name, status, email_verified_at)
              VALUES (?, ?, 'Member', 'active', datetime('now'))`)
    .run('faq-member@example.com', hashPassword('member-test-password-1'));
  db.prepare('INSERT INTO user_roles (user_id, role) VALUES (?, ?)').run(info.lastInsertRowid, 'member');

  const login2 = await member('/api/auth/login', {
    method: 'POST',
    body: { email: 'faq-member@example.com', password: 'member-test-password-1' },
  });
  assert.equal(login2.status, 200, JSON.stringify(login2.data));
});

test('the seeded FAQ is readable with no session at all', async () => {
  const res = await anon('/api/faq');
  assert.equal(res.status, 200);
  assert.ok(res.data.categories.length >= 4);
  assert.ok(res.data.questions.length >= 8);
  assert.equal(res.data.level, 'public');
  // Same URL, different body per session — a shared cache must not reuse it.
  assert.equal(res.headers.get('cache-control'), 'no-store');
  for (const q of res.data.questions) {
    assert.equal(q.status, 'published');
    assert.equal(q.visibility, 'public');
  }
});

test('the seeded members-only entry is hidden from anonymous and shown to members', async () => {
  const slug = 'how-do-i-ask-a-follow-up-question';
  const a = await anon('/api/faq');
  assert.ok(!JSON.stringify(a.data).includes(slug), 'members-only entry leaked to anonymous');
  const m = await member('/api/faq');
  assert.ok(JSON.stringify(m.data).includes(slug), 'member should see the members-only entry');
  assert.equal(m.data.level, 'members');
});

test('advisor creates the visibility matrix', async () => {
  const cat = await advisor('/api/faq/categories', {
    method: 'POST',
    body: { name: 'Visible category', status: 'published', visibility: 'public' },
  });
  assert.equal(cat.status, 200, JSON.stringify(cat.data));
  made.publicCat = cat.data.categoryId;

  const draftCat = await advisor('/api/faq/categories', {
    method: 'POST',
    body: { name: 'Draft category', status: 'draft', visibility: 'public' },
  });
  made.draftCat = draftCat.data.categoryId;

  const membersCat = await advisor('/api/faq/categories', {
    method: 'POST',
    body: { name: 'Members category', status: 'published', visibility: 'members' },
  });
  made.membersCat = membersCat.data.categoryId;

  const mk = async (key, body) => {
    const res = await advisor('/api/faq/questions', { method: 'POST', body });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    made[key] = res.data;
  };
  // a: draft entry in a public category
  await mk('draftEntry', { question: 'Alpha draft entry', answer: 'Alpha answer body.', categoryId: made.publicCat, status: 'draft', visibility: 'public' });
  // b: published members-only entry in a public category
  await mk('membersEntry', { question: 'Bravo members entry', answer: 'Bravo answer body.', categoryId: made.publicCat, status: 'published', visibility: 'members' });
  // c: published public entry in a DRAFT category
  await mk('inDraftCat', { question: 'Charlie in draft category', answer: 'Charlie answer body.', categoryId: made.draftCat, status: 'published', visibility: 'public' });
  // d: published public entry in a MEMBERS category
  await mk('inMembersCat', { question: 'Delta in members category', answer: 'Delta answer body.', categoryId: made.membersCat, status: 'published', visibility: 'public' });
  // e: fully public control
  await mk('publicEntry', { question: 'Echo fully public', answer: 'Echo answer body.', categoryId: made.publicCat, status: 'published', visibility: 'public' });
});

test('visibility: anonymous sees only the fully-public entry', async () => {
  const res = await anon('/api/faq');
  const blob = JSON.stringify(res.data);
  for (const key of ['draftEntry', 'membersEntry', 'inDraftCat', 'inMembersCat']) {
    assert.ok(!blob.includes(made[key].slug), `${key} leaked to anonymous`);
  }
  assert.ok(blob.includes(made.publicEntry.slug), 'public entry should be visible');
});

test('visibility: a member sees members-only entries but never drafts or draft categories', async () => {
  const res = await member('/api/faq');
  const blob = JSON.stringify(res.data);
  assert.ok(blob.includes(made.membersEntry.slug), 'member should see a members-only entry');
  assert.ok(blob.includes(made.inMembersCat.slug), 'member should see entries in a members category');
  assert.ok(!blob.includes(made.draftEntry.slug), 'draft leaked to member');
  assert.ok(!blob.includes(made.inDraftCat.slug), 'entry in a draft category leaked to member');
});

test('visibility: an advisor sees everything, drafts included', async () => {
  const res = await advisor('/api/faq');
  const blob = JSON.stringify(res.data);
  assert.equal(res.data.level, 'manage');
  for (const key of ['draftEntry', 'membersEntry', 'inDraftCat', 'inMembersCat', 'publicEntry']) {
    assert.ok(blob.includes(made[key].slug), `${key} missing for advisor`);
  }
});

test('an out-of-scope slug is 404, never 403 — no existence oracle', async () => {
  const res = await anon(`/api/faq/questions/${made.draftEntry.slug}`);
  assert.equal(res.status, 404);
  assert.equal(res.data.error, 'That FAQ entry was not found.');
  const missing = await anon('/api/faq/questions/no-such-slug-at-all');
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error, res.data.error, 'the two 404s must be indistinguishable');
});

test('feedback on an out-of-scope entry is 404 and does not move the counter', async () => {
  const res = await anon(`/api/faq/questions/${made.draftEntry.questionId}/feedback`, {
    method: 'POST', body: { helpful: true },
  });
  assert.equal(res.status, 404);
  const row = db.prepare('SELECT helpful_count FROM faq_questions WHERE id = ?').get(made.draftEntry.questionId);
  assert.equal(row.helpful_count, 0);
});

test('FTS: editing an answer removes the OLD wording from search and indexes the new', async () => {
  // The regression this whole feature hinges on. Without the faq_questions_au
  // trigger the row still matches its PRE-EDIT terms while returning its
  // POST-EDIT answer — a confidently wrong answer, not a missing one. BOTH
  // directions are asserted: checking only that the new term is findable
  // passes even with a broken trigger.
  const created = await advisor('/api/faq/questions', {
    method: 'POST',
    body: {
      question: 'Where do aardvarks apply?',
      answer: 'The aardvark procedure applies to everyone.',
      categoryId: made.publicCat,
      status: 'published',
      visibility: 'public',
    },
  });
  const id = created.data.questionId;

  const before = await anon('/api/faq/search', { method: 'POST', body: { q: 'aardvark procedure' } });
  assert.ok(before.data.results.some((r) => r.id === id), 'should be findable before the edit');

  const patched = await advisor(`/api/faq/questions/${id}`, {
    method: 'PATCH',
    body: { answer: 'The buffalo procedure applies to everyone.' },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.data));

  const oldTerm = await anon('/api/faq/search', { method: 'POST', body: { q: 'aardvark' } });
  assert.ok(!oldTerm.data.results.some((r) => r.id === id), 'STALE INDEX: old wording still matches');

  const newTerm = await anon('/api/faq/search', { method: 'POST', body: { q: 'buffalo' } });
  assert.ok(newTerm.data.results.some((r) => r.id === id), 'new wording is not indexed');
  made.aardvarkId = id;
});

test('FTS: the index passes a real integrity check after edits, deletes and counter bumps', async () => {
  await anon(`/api/faq/questions/${made.publicEntry.questionId}/feedback`, { method: 'POST', body: { helpful: true } });
  const throwaway = await advisor('/api/faq/questions', {
    method: 'POST',
    body: { question: 'Temporary entry', answer: 'Temporary answer body.', categoryId: made.publicCat },
  });
  await advisor(`/api/faq/questions/${throwaway.data.questionId}/delete`, { method: 'POST' });

  // The rank=1 argument is essential: the no-arg and rank=0 forms both PASS
  // against a genuinely stale index, which would make this test worthless.
  assert.doesNotThrow(() => {
    db.exec("INSERT INTO faq_fts(faq_fts, rank) VALUES('integrity-check', 1)");
  });
});

test('a counter bump does not disturb the search index', async () => {
  const before = await anon('/api/faq/search', { method: 'POST', body: { q: 'buffalo' } });
  await anon(`/api/faq/questions/${made.aardvarkId}/feedback`, { method: 'POST', body: { helpful: false } });
  const after = await anon('/api/faq/search', { method: 'POST', body: { q: 'buffalo' } });
  assert.deepEqual(after.data.results.map((r) => r.id), before.data.results.map((r) => r.id));
});

test('search never returns out-of-scope entries', async () => {
  const res = await anon('/api/faq/search', { method: 'POST', body: { q: 'Charlie Delta Bravo Alpha' } });
  const blob = JSON.stringify(res.data);
  for (const key of ['draftEntry', 'membersEntry', 'inDraftCat', 'inMembersCat']) {
    assert.ok(!blob.includes(made[key].slug), `${key} leaked through search`);
  }
});

test('search falls back to keyword ranking when AI is unavailable, and never errors', async () => {
  const { setSetting } = await import('../src/db/connection.js');
  const noKey = await anon('/api/faq/search', { method: 'POST', body: { q: 'documents upload evidence' } });
  assert.equal(noKey.status, 200);
  assert.equal(noKey.data.aiUsed, false);
  assert.equal(noKey.data.mode, 'fts');
  assert.ok(noKey.data.results.length > 0);

  // A configured key with the kill switch ON must still return results, not an
  // error: the public help page cannot become an error page.
  setSetting('openai_api_key', 'sk-test-not-a-real-key-000000000000');
  setSetting('ai_disabled', '1');
  const killed = await anon('/api/faq/search', { method: 'POST', body: { q: 'documents upload evidence' } });
  assert.equal(killed.status, 200);
  assert.equal(killed.data.aiUsed, false);
  assert.ok(killed.data.results.length > 0);
  db.prepare("DELETE FROM settings WHERE key = 'openai_api_key'").run();
  setSetting('ai_disabled', '0');
});

test('a malformed search query returns empty rather than a 500', async () => {
  for (const q of ['"', '* OR', 'a b c', '((((']) {
    const res = await anon('/api/faq/search', { method: 'POST', body: { q } });
    assert.equal(res.status, 200, `query ${q} should not error`);
    assert.ok(Array.isArray(res.data.results));
  }
});

test('deleting a category is blocked while it holds entries, and reassignment works', async () => {
  const blocked = await advisor(`/api/faq/categories/${made.publicCat}/delete`, { method: 'POST' });
  assert.equal(blocked.status, 409);
  assert.ok(blocked.data.questionCount > 0, 'the 409 must carry questionCount for the UI');
  assert.ok(db.prepare('SELECT id FROM faq_categories WHERE id = ?').get(made.publicCat), 'category was deleted anyway');

  const spare = await advisor('/api/faq/categories', { method: 'POST', body: { name: 'Spare category', status: 'published' } });
  const doomed = await advisor('/api/faq/categories', { method: 'POST', body: { name: 'Doomed category', status: 'published' } });
  await advisor('/api/faq/questions', {
    method: 'POST',
    body: { question: 'Doomed entry', answer: 'Doomed answer body.', categoryId: doomed.data.categoryId },
  });

  const moved = await advisor(`/api/faq/categories/${doomed.data.categoryId}/delete`, {
    method: 'POST', body: { reassignTo: spare.data.categoryId },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data.moved, 1);
  assert.ok(!db.prepare('SELECT id FROM faq_categories WHERE id = ?').get(doomed.data.categoryId));
  const relocated = db.prepare('SELECT category_id FROM faq_questions WHERE question = ?').get('Doomed entry');
  assert.equal(relocated.category_id, spare.data.categoryId);
});

test('slugs stay unique and deep links resolve', async () => {
  const a = await advisor('/api/faq/questions', {
    method: 'POST',
    body: { question: 'Same question text', answer: 'First answer body.', categoryId: made.publicCat, status: 'published' },
  });
  const b = await advisor('/api/faq/questions', {
    method: 'POST',
    body: { question: 'Same question text', answer: 'Second answer body.', categoryId: made.publicCat, status: 'published' },
  });
  assert.notEqual(a.data.slug, b.data.slug);
  assert.ok(b.data.slug.endsWith('-2'), `expected a -2 suffix, got ${b.data.slug}`);
  for (const slug of [a.data.slug, b.data.slug]) {
    const res = await anon(`/api/faq/questions/${slug}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.question.slug, slug);
  }
});

test('publishing and unpublishing move an entry in and out of the public list', async () => {
  const id = made.publicEntry.questionId;
  const before = db.prepare('SELECT published_at FROM faq_questions WHERE id = ?').get(id).published_at;

  await advisor(`/api/faq/questions/${id}/status`, { method: 'POST', body: { status: 'draft' } });
  const hidden = await anon('/api/faq');
  assert.ok(!JSON.stringify(hidden.data).includes(made.publicEntry.slug));

  await advisor(`/api/faq/questions/${id}/status`, { method: 'POST', body: { status: 'published' } });
  const shown = await anon('/api/faq');
  assert.ok(JSON.stringify(shown.data).includes(made.publicEntry.slug));

  const after = db.prepare('SELECT published_at FROM faq_questions WHERE id = ?').get(id).published_at;
  assert.equal(after, before, 'published_at is stamped once and must not move on re-publish');
});

test('reordering is reflected in the public list', async () => {
  const list = await advisor('/api/faq/manage');
  const inCat = list.data.questions.filter((q) => q.categoryId === made.publicCat).map((q) => q.id);
  assert.ok(inCat.length >= 2);
  const reversed = [...inCat].reverse();
  const res = await advisor('/api/faq/questions/reorder', {
    method: 'POST', body: { categoryId: made.publicCat, ids: reversed },
  });
  assert.equal(res.status, 200);
  const after = await advisor('/api/faq/manage');
  const seen = after.data.questions.filter((q) => q.categoryId === made.publicCat).map((q) => q.id);
  assert.deepEqual(seen, reversed);
});

test('permission boundary: members get 403 and anonymous gets 401 on every management route', async () => {
  // Passing for the advisor account also proves faq.manage landed in BOTH
  // ROLE_DEFAULTS entries, since the seeded admin holds admin + advisor.
  const routes = [
    ['GET', '/api/faq/manage'],
    ['POST', '/api/faq/categories'],
    ['PATCH', `/api/faq/categories/${made.publicCat}`],
    ['POST', '/api/faq/categories/reorder'],
    ['POST', `/api/faq/categories/${made.publicCat}/delete`],
    ['POST', '/api/faq/questions'],
    ['PATCH', `/api/faq/questions/${made.publicEntry.questionId}`],
    ['POST', '/api/faq/questions/reorder'],
    ['POST', `/api/faq/questions/${made.publicEntry.questionId}/status`],
    ['POST', `/api/faq/questions/${made.publicEntry.questionId}/delete`],
    ['POST', '/api/faq/reindex'],
  ];
  for (const [method, url] of routes) {
    const asMember = await member(url, { method, ...(method === 'GET' ? {} : { body: {} }) });
    assert.equal(asMember.status, 403, `member should be forbidden from ${method} ${url}`);
    const asAnon = await anon(url, { method, ...(method === 'GET' ? {} : { body: {} }) });
    assert.equal(asAnon.status, 401, `anonymous should be unauthorised for ${method} ${url}`);
  }
});

test('an advisor can reach the management payload', async () => {
  const res = await advisor('/api/faq/manage');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data.categories));
  assert.deepEqual(res.data.statuses, ['draft', 'published']);
  assert.deepEqual(res.data.visibilities, ['public', 'members']);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('a state-changing request without the CSRF header is rejected', async () => {
  const res = await fetch(`${base}/api/faq/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: 'documents' }),
  });
  assert.equal(res.status, 403);
});

test('audit metadata carries names and ids only, never content', async () => {
  const rows = db.prepare("SELECT action, meta FROM audit_events WHERE action LIKE 'faq.%'").all();
  assert.ok(rows.length > 0, 'FAQ mutations should be audited');
  const secrets = [
    'aardvark', 'buffalo', 'Alpha answer body', 'Bravo answer body', 'Echo answer body',
    'Where do aardvarks apply', 'faq-member@example.com', 'mapadocrew@gmail.com',
  ];
  for (const row of rows) {
    assert.ok(row.meta.length < 600, `audit meta too large for ${row.action}: ${row.meta.length}`);
    for (const secret of secrets) {
      assert.ok(!row.meta.includes(secret), `${row.action} meta leaked "${secret}": ${row.meta}`);
    }
  }
  const updated = rows.filter((r) => r.action === 'faq.question_updated');
  assert.ok(updated.length > 0);
  for (const row of updated) {
    // `changed` must be FIELD NAMES, never the values written.
    const meta = JSON.parse(row.meta);
    assert.ok(Array.isArray(meta.changed));
    for (const field of meta.changed) {
      assert.match(field, /^[a-zA-Z]+$/, `changed should list field names, got ${field}`);
    }
  }
});

test('feedback counters move for an in-scope entry', async () => {
  const id = made.publicEntry.questionId;
  const before = db.prepare('SELECT helpful_count FROM faq_questions WHERE id = ?').get(id).helpful_count;
  const res = await member(`/api/faq/questions/${id}/feedback`, { method: 'POST', body: { helpful: true } });
  assert.equal(res.status, 200);
  assert.equal(res.data.helpful, before + 1);
});

test('rebuilding the index leaves search working', async () => {
  const res = await advisor('/api/faq/reindex', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.ok(res.data.questionCount > 0);
  const search = await anon('/api/faq/search', { method: 'POST', body: { q: 'documents upload' } });
  assert.ok(search.data.results.length > 0, 'search should still work after a rebuild');
  assert.doesNotThrow(() => db.exec("INSERT INTO faq_fts(faq_fts, rank) VALUES('integrity-check', 1)"));
});

// LAST in the file on purpose: the limiter buckets on 127.0.0.1, so running
// this earlier would poison every test above it.
test('the public search endpoint is rate limited', async () => {
  let sawLimit = false;
  for (let i = 0; i < 30; i += 1) {
    const res = await anon('/api/faq/search', { method: 'POST', body: { q: `probe ${i} documents` } });
    if (res.status === 429) { sawLimit = true; break; }
  }
  assert.ok(sawLimit, 'an unauthenticated LLM-spending endpoint must be rate limited');
});
