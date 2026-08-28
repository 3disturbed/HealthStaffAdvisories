import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-faqsearch-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tmp;
process.env.ADMIN_INITIAL_PASSWORD = 'admin-test-password-1';

const { db, setSetting } = await import('../src/db/connection.js');
const { searchFaqAssisted, validateFaqRerank } = await import('../src/ai/faqSearch.js');
const { faqShortlist } = await import('../src/services/faqSearch.js');

let ids = {};

before(() => {
  // A key must be present or aiEnabled() short-circuits before the fake model.
  setSetting('openai_api_key', 'sk-test-not-a-real-key-000000000000');
  setSetting('ai_disabled', '0');

  const cat = db
    .prepare("INSERT INTO faq_categories (slug, name, status, visibility) VALUES ('t','Testing','published','public')")
    .run().lastInsertRowid;
  const membersCat = db
    .prepare("INSERT INTO faq_categories (slug, name, status, visibility) VALUES ('tm','Members testing','published','members')")
    .run().lastInsertRowid;
  const mk = (slug, question, answer, categoryId = cat, visibility = 'public') =>
    db.prepare(
      `INSERT INTO faq_questions (category_id, slug, question, answer, status, visibility)
       VALUES (?, ?, ?, ?, 'published', ?)`
    ).run(categoryId, slug, question, answer, visibility).lastInsertRowid;

  ids.grievance = mk('grievance', 'How long does a grievance take?', 'Grievance timescales vary between employers.');
  ids.suspension = mk('suspension', 'What happens during suspension?', 'Suspension is a neutral act in most employers.');
  ids.documents = mk('documents', 'Which documents matter?', 'Documents such as letters and meeting invitations.');
  ids.secret = mk('secret', 'Members grievance briefing', 'Members grievance briefing content.', membersCat);
  // Mentions "suspension" only in its ANSWER, so a search for that term yields
  // two hits while the top hit is still the entry whose QUESTION covers it.
  ids.redeploy = mk('redeploy', 'What is redeployment?', 'Redeployment sometimes follows a suspension.');
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const fakeModel = (raw) => async () => ({ model: 'test-model', raw });
const explode = () => { throw new Error('the model must not be called'); };

test('validateFaqRerank keeps only ids we supplied, deduped and capped', () => {
  const allowed = new Set([1, 2, 3, 4, 5, 6]);
  const out = validateFaqRerank({ ids: [3, 999999, 3, 1, 'x', null, 2, 4, 5, 6] }, allowed);
  assert.deepEqual(out.ids, [3, 1, 2, 4, 5]);
  assert.equal(out.noMatch, false);
  assert.ok(out.dropped >= 4);
});

test('validateFaqRerank output has no key where prose could live', () => {
  const out = validateFaqRerank({ ids: [1], answer: 'I am a helpful model', text: 'nope' }, new Set([1]));
  assert.deepEqual(Object.keys(out).sort(), ['dropped', 'ids', 'noMatch']);
});

test('validateFaqRerank tolerates junk without throwing', () => {
  for (const raw of [null, undefined, {}, { ids: null }, { ids: 'nope' }, { ids: [{}] }, []]) {
    const out = validateFaqRerank(raw, new Set([1]));
    assert.deepEqual(out.ids, []);
  }
});

test('the model reorders real entries and invented ids are dropped', async () => {
  const res = await searchFaqAssisted('grievance suspension documents', null, {
    complete: fakeModel({ ids: [ids.documents, 999999, ids.grievance] }),
  });
  assert.equal(res.mode, 'ai');
  assert.equal(res.aiUsed, true);
  assert.equal(res.promptVersion, 'faq-rerank-v1');
  assert.deepEqual(res.results.map((r) => r.id), [ids.documents, ids.grievance]);
  assert.equal(res.dropped, 1);
});

test('a model failure degrades to keyword search rather than erroring', async () => {
  const res = await searchFaqAssisted('grievance suspension documents', null, {
    complete: async () => { throw new Error('provider exploded'); },
  });
  assert.equal(res.mode, 'fts');
  assert.equal(res.aiUsed, false);
  assert.ok(res.results.length > 0);
});

test('noMatch returns the keyword results flagged, never an empty page', async () => {
  const res = await searchFaqAssisted('grievance suspension documents', null, {
    complete: fakeModel({ ids: [], noMatch: true }),
  });
  assert.equal(res.mode, 'fts');
  assert.equal(res.noMatch, true);
  assert.ok(res.results.length > 0);
});

test('a shortlist of fewer than two never reaches the model', async () => {
  const res = await searchFaqAssisted('zzzznothingmatchesthis', null, { complete: explode });
  assert.equal(res.aiUsed, false);
  assert.deepEqual(res.results, []);
});

test('a confident single-intent match short-circuits the model', async () => {
  // Two hits, so the shortlist guard does not fire — but every search term
  // already appears in the top hit's question, so there is nothing to rank.
  const res = await searchFaqAssisted('suspension', null, { complete: explode });
  assert.ok(res.results.length >= 2, 'need a real shortlist for this to be meaningful');
  assert.equal(res.results[0].id, ids.suspension);
  assert.equal(res.aiUsed, false);
  assert.equal(res.confident, true);
});

test('allowAi false (budget spent) skips the model silently', async () => {
  const res = await searchFaqAssisted('grievance suspension documents', null, {
    allowAi: false,
    complete: explode,
  });
  assert.equal(res.aiUsed, false);
  assert.equal(res.mode, 'fts');
  assert.ok(res.results.length > 0);
});

test('the kill switch skips the model and still returns results', async () => {
  setSetting('ai_disabled', '1');
  const res = await searchFaqAssisted('grievance suspension documents', null, { complete: explode });
  setSetting('ai_disabled', '0');
  assert.equal(res.aiUsed, false);
  assert.ok(res.results.length > 0);
});

test('prompt injection inside an answer cannot smuggle an entry into the results', async () => {
  // The validator is the authority: an id outside the shortlist is discarded no
  // matter how persuasive the surrounding text is.
  const res = await searchFaqAssisted('grievance suspension documents', null, {
    complete: fakeModel({ ids: [ids.secret, ids.grievance] }),
  });
  assert.ok(!res.results.some((r) => r.id === ids.secret), 'members-only entry reached an anonymous caller');
  assert.deepEqual(res.results.map((r) => r.id), [ids.grievance]);
});

test('scope is enforced in the shortlist itself, before any model sees it', () => {
  const anonHits = faqShortlist('members grievance briefing', null);
  assert.ok(!anonHits.some((r) => r.id === ids.secret));
  const memberHits = faqShortlist('members grievance briefing', { id: 1 });
  assert.ok(memberHits.some((r) => r.id === ids.secret));
});

test('a malformed FTS query returns empty instead of throwing', () => {
  for (const q of ['"', '* OR', 'a b c', '((((', '']) {
    assert.doesNotThrow(() => faqShortlist(q, null));
    assert.ok(Array.isArray(faqShortlist(q, null)));
  }
});

test('a very short query returns empty without touching the model', async () => {
  const res = await searchFaqAssisted('ab', null, { complete: explode });
  assert.deepEqual(res.results, []);
  assert.equal(res.aiUsed, false);
});
