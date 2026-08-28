import { db } from '../db/connection.js';
import { audit } from '../audit/log.js';
import { userHas } from '../rbac/permissions.js';

// FAQ content management. Advisor-authored help content, edited IN PLACE.
//
// Why in-place UPDATE and not the append-and-supersede model knowledge_versions
// uses: that model exists to protect CITATION INTEGRITY. citations.chunk_id and
// the frozen retrieval trace in ai_outputs.output_json mean mutating a chunk
// would change what a closed case cited. Nothing can reference a
// faq_questions.id — not citations, ai_outputs, case_messages, je_evidence or
// je_reports — retrieveChunks() reads knowledge_fts only, and the re-ranker's
// ids are never persisted. So an edit here cannot alter any stored artefact.
//
// THIS HOLDS ONLY WHILE FAQ CONTENT STAYS OUT OF PERSISTED AI OUTPUTS. If a FAQ
// entry ever gets quoted into a case message, or FAQ rows join retrieveChunks,
// the AGENTS.md rule bites and versioning becomes mandatory.

export const FAQ_STATUSES = ['draft', 'published'];
export const FAQ_VISIBILITIES = ['public', 'members'];

const MAX_NAME = 80;
const MAX_DESCRIPTION = 300;
const MAX_QUESTION = 300;
const MAX_ANSWER = 8000;
const MAX_KEYWORDS = 300;
const MAX_SLUG = 80;

// ── visibility ────────────────────────────────────────────────────────────
// THE single source of truth for who sees which rows. Every read path builds
// its WHERE from this — listFaq, getFaqQuestion, faqShortlist, the feedback
// and view counters. The fragments are CONSTANTS; no caller input is ever
// interpolated, so there is no injection surface in the concatenation.
//
// Effective visibility is the MOST RESTRICTIVE of the entry and its category.
// A public entry inside a members category is members-only; a published entry
// inside a draft category is not live. Without the category leg an advisor
// drafting a members-only category would publish its entries to the world.
export function faqScope(user) {
  if (user && userHas(user, 'faq.manage')) return { level: 'manage', sql: '1 = 1' };
  if (user) {
    return { level: 'members', sql: "q.status = 'published' AND c.status = 'published'" };
  }
  return {
    level: 'public',
    sql: "q.status = 'published' AND c.status = 'published'"
      + " AND q.visibility = 'public' AND c.visibility = 'public'",
  };
}

// Category scope for listing categories themselves (no q.* columns in play).
function categoryScopeSql(level) {
  if (level === 'manage') return '1 = 1';
  if (level === 'members') return "c.status = 'published'";
  return "c.status = 'published' AND c.visibility = 'public'";
}

// ── helpers ───────────────────────────────────────────────────────────────
function slugify(value, fallback = 'entry') {
  const base = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG);
  return base || fallback;
}

// Append -2, -3 … until free. `exceptId` lets an update keep its own slug.
function uniqueSlug(table, desired, exceptId = null) {
  const stmt = db.prepare(`SELECT id FROM ${table} WHERE slug = ?`);
  let candidate = desired;
  for (let n = 2; n < 200; n += 1) {
    const row = stmt.get(candidate);
    if (!row || row.id === exceptId) return candidate;
    candidate = `${desired.slice(0, MAX_SLUG - 5)}-${n}`;
  }
  return `${desired.slice(0, MAX_SLUG - 14)}-${Date.now().toString(36)}`;
}

function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function enumOr(list, value, fallback) {
  return list.includes(value) ? value : fallback;
}

function idList(ids) {
  return (Array.isArray(ids) ? ids : [])
    .slice(0, 200)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

// ── mappers (snake → camel, mirroring caseCard() in src/api/advisor.js) ────
function categoryCard(c) {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    description: c.description,
    seq: c.seq,
    status: c.status,
    visibility: c.visibility,
  };
}

function categoryAdminCard(c) {
  return {
    ...categoryCard(c),
    questionCount: c.question_count ?? 0,
    draftCount: c.draft_count ?? 0,
    updatedAt: c.updated_at,
    updatedBy: c.updated_by_email || null,
  };
}

// Deliberately omits keywords and the raw counters other than helpfulCount.
// status is kept because a faq.manage viewer receives drafts through this same
// read path and the client must be able to badge them.
function questionCard(q) {
  return {
    id: q.id,
    slug: q.slug,
    categoryId: q.category_id,
    categorySlug: q.category_slug,
    question: q.question,
    answer: q.answer,
    status: q.status,
    visibility: q.visibility,
    helpfulCount: q.helpful_count,
  };
}

function questionAdminCard(q) {
  return {
    ...questionCard(q),
    seq: q.seq,
    keywords: q.keywords,
    viewCount: q.view_count,
    notHelpfulCount: q.not_helpful_count,
    createdAt: q.created_at,
    updatedAt: q.updated_at,
    updatedBy: q.updated_by_email || null,
    publishedAt: q.published_at,
  };
}

// ── reads ─────────────────────────────────────────────────────────────────
export function listFaq(user) {
  const scope = faqScope(user);
  const categories = db
    .prepare(`SELECT c.* FROM faq_categories c WHERE ${categoryScopeSql(scope.level)} ORDER BY c.seq, c.name`)
    .all();
  const questions = db
    .prepare(
      `SELECT q.*, c.slug AS category_slug
         FROM faq_questions q
         JOIN faq_categories c ON c.id = q.category_id
        WHERE ${scope.sql}
        ORDER BY c.seq, c.name, q.seq, q.question`
    )
    .all();
  return {
    ok: true,
    level: scope.level,
    categories: categories.map(categoryCard),
    questions: questions.map(questionCard),
  };
}

export function getFaqQuestion(user, slug) {
  const scope = faqScope(user);
  const row = db
    .prepare(
      `SELECT q.*, c.slug AS category_slug
         FROM faq_questions q
         JOIN faq_categories c ON c.id = q.category_id
        WHERE q.slug = ? AND ${scope.sql}`
    )
    .get(String(slug || ''));
  // 404 rather than 403 for out-of-scope rows: never confirm that a draft or
  // members-only entry exists (mirrors loadCaseAuthorised in src/api/cases.js).
  if (!row) return { error: 'That FAQ entry was not found.', status: 404 };
  return { ok: true, question: questionCard(row) };
}

export function listFaqManage() {
  const categories = db
    .prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM faq_questions q WHERE q.category_id = c.id) AS question_count,
        (SELECT COUNT(*) FROM faq_questions q WHERE q.category_id = c.id AND q.status = 'draft') AS draft_count,
        (SELECT u.email FROM users u WHERE u.id = c.updated_by) AS updated_by_email
       FROM faq_categories c ORDER BY c.seq, c.name`
    )
    .all();
  const questions = db
    .prepare(
      `SELECT q.*, c.slug AS category_slug,
        (SELECT u.email FROM users u WHERE u.id = q.updated_by) AS updated_by_email
       FROM faq_questions q
       JOIN faq_categories c ON c.id = q.category_id
       ORDER BY c.seq, c.name, q.seq, q.question`
    )
    .all();
  return {
    ok: true,
    categories: categories.map(categoryAdminCard),
    questions: questions.map(questionAdminCard),
    statuses: FAQ_STATUSES,
    visibilities: FAQ_VISIBILITIES,
  };
}

// ── categories ────────────────────────────────────────────────────────────
export function createCategory(actor, fields) {
  const name = text(fields.name, MAX_NAME);
  if (!name) return { error: 'Give the category a name.', status: 400 };
  const slug = uniqueSlug('faq_categories', slugify(fields.slug || name, 'category'));
  const info = db
    .prepare(
      `INSERT INTO faq_categories (slug, name, description, seq, status, visibility, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      slug,
      name,
      text(fields.description, MAX_DESCRIPTION),
      Number.isFinite(Number(fields.seq)) ? Number(fields.seq) : 0,
      enumOr(FAQ_STATUSES, fields.status, 'draft'),
      enumOr(FAQ_VISIBILITIES, fields.visibility, 'public'),
      actor.id,
      actor.id
    );
  // ids and counts only: a slug is derived from author-written text, so it
  // would smuggle content into audit meta (docs/AGENTS.md). The row id is
  // enough to find the record.
  audit(actor.id, 'faq.category_created', 'faq_category', info.lastInsertRowid, {});
  return { ok: true, categoryId: info.lastInsertRowid, slug };
}

export function updateCategory(actor, id, fields) {
  const row = db.prepare('SELECT * FROM faq_categories WHERE id = ?').get(Number(id));
  if (!row) return { error: 'That category was not found.', status: 404 };

  const next = { ...row };
  const changed = [];
  if (typeof fields.name === 'string') {
    const name = text(fields.name, MAX_NAME);
    if (!name) return { error: 'Give the category a name.', status: 400 };
    next.name = name;
    changed.push('name');
  }
  if (typeof fields.description === 'string') {
    next.description = text(fields.description, MAX_DESCRIPTION);
    changed.push('description');
  }
  if (typeof fields.slug === 'string' && fields.slug.trim()) {
    next.slug = uniqueSlug('faq_categories', slugify(fields.slug, row.slug), row.id);
    changed.push('slug');
  }
  if (fields.seq !== undefined && Number.isFinite(Number(fields.seq))) {
    next.seq = Number(fields.seq);
    changed.push('seq');
  }
  if (FAQ_STATUSES.includes(fields.status)) { next.status = fields.status; changed.push('status'); }
  if (FAQ_VISIBILITIES.includes(fields.visibility)) { next.visibility = fields.visibility; changed.push('visibility'); }
  if (changed.length === 0) return { error: 'Nothing to change.', status: 400 };

  db.prepare(
    `UPDATE faq_categories
        SET slug = ?, name = ?, description = ?, seq = ?, status = ?, visibility = ?,
            updated_by = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(next.slug, next.name, next.description, next.seq, next.status, next.visibility, actor.id, row.id);
  // Field NAMES only — never values (docs/AGENTS.md, enforced by tests/je.test.js).
  audit(actor.id, 'faq.category_updated', 'faq_category', row.id, { changed });
  return { ok: true, categoryId: row.id, changed };
}

// Blocked while entries remain. No cascade (one click would destroy published,
// deep-linked content) and no "Uncategorised" magic row (a new invariant to
// defend forever). reassignTo moves the entries and deletes in one transaction.
export function deleteCategory(actor, id, { reassignTo } = {}) {
  const row = db.prepare('SELECT * FROM faq_categories WHERE id = ?').get(Number(id));
  if (!row) return { error: 'That category was not found.', status: 404 };
  const questionCount = db
    .prepare('SELECT COUNT(*) AS n FROM faq_questions WHERE category_id = ?')
    .get(row.id).n;

  let target = null;
  if (questionCount > 0) {
    if (reassignTo === undefined || reassignTo === null || reassignTo === '') {
      return {
        error: 'This category still has FAQ entries. Move them to another category first, or delete them.',
        status: 409,
        questionCount,
      };
    }
    target = db.prepare('SELECT id FROM faq_categories WHERE id = ?').get(Number(reassignTo));
    if (!target) return { error: 'That category was not found.', status: 404 };
    if (target.id === row.id) {
      return { error: 'Choose a different category to move the entries to.', status: 400 };
    }
  }

  db.exec('BEGIN');
  try {
    if (target) {
      db.prepare(
        `UPDATE faq_questions SET category_id = ?, updated_by = ?, updated_at = datetime('now')
          WHERE category_id = ?`
      ).run(target.id, actor.id, row.id);
    }
    db.prepare('DELETE FROM faq_categories WHERE id = ?').run(row.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  audit(actor.id, 'faq.category_deleted', 'faq_category', row.id, {
    moved: questionCount,
    movedTo: target ? target.id : null,
  });
  return { ok: true, deleted: true, moved: questionCount };
}

export function reorderCategories(actor, ids) {
  const ordered = idList(ids);
  if (ordered.length === 0) return { error: 'Nothing to reorder.', status: 400 };
  const stmt = db.prepare(
    `UPDATE faq_categories SET seq = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`
  );
  db.exec('BEGIN');
  try {
    // Gaps of 10 so a later insert-between needs no full rewrite.
    ordered.forEach((cid, i) => stmt.run((i + 1) * 10, actor.id, cid));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  audit(actor.id, 'faq.categories_reordered', 'faq_category', '', { count: ordered.length });
  return { ok: true, count: ordered.length };
}

// ── questions ─────────────────────────────────────────────────────────────
function requireCategory(categoryId) {
  const row = db.prepare('SELECT id FROM faq_categories WHERE id = ?').get(Number(categoryId));
  return row || null;
}

export function createQuestion(actor, fields) {
  const question = text(fields.question, MAX_QUESTION);
  if (!question) return { error: 'Write the question a member would ask.', status: 400 };
  const answer = text(fields.answer, MAX_ANSWER);
  if (!answer) return { error: 'Write an answer.', status: 400 };
  const category = requireCategory(fields.categoryId);
  if (!category) return { error: 'Choose a category for this entry.', status: 400 };

  const slug = uniqueSlug('faq_questions', slugify(fields.slug || question, 'question'));
  const status = enumOr(FAQ_STATUSES, fields.status, 'draft');
  const info = db
    .prepare(
      `INSERT INTO faq_questions
         (category_id, slug, question, answer, keywords, seq, status, visibility,
          created_by, updated_by, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'published' THEN datetime('now') ELSE NULL END)`
    )
    .run(
      category.id,
      slug,
      question,
      answer,
      text(fields.keywords, MAX_KEYWORDS),
      Number.isFinite(Number(fields.seq)) ? Number(fields.seq) : 0,
      status,
      enumOr(FAQ_VISIBILITIES, fields.visibility, 'public'),
      actor.id,
      actor.id,
      status
    );
  audit(actor.id, 'faq.question_created', 'faq_question', info.lastInsertRowid, {
    categoryId: category.id,
    status,
  });
  return { ok: true, questionId: info.lastInsertRowid, slug };
}

export function updateQuestion(actor, id, fields) {
  const row = db.prepare('SELECT * FROM faq_questions WHERE id = ?').get(Number(id));
  if (!row) return { error: 'That FAQ entry was not found.', status: 404 };

  const next = { ...row };
  const changed = [];
  if (typeof fields.question === 'string') {
    const question = text(fields.question, MAX_QUESTION);
    if (!question) return { error: 'Write the question a member would ask.', status: 400 };
    next.question = question;
    changed.push('question');
  }
  if (typeof fields.answer === 'string') {
    const answer = text(fields.answer, MAX_ANSWER);
    if (!answer) return { error: 'Write an answer.', status: 400 };
    next.answer = answer;
    changed.push('answer');
  }
  if (typeof fields.keywords === 'string') {
    next.keywords = text(fields.keywords, MAX_KEYWORDS);
    changed.push('keywords');
  }
  if (fields.categoryId !== undefined) {
    const category = requireCategory(fields.categoryId);
    if (!category) return { error: 'Choose a category for this entry.', status: 400 };
    next.category_id = category.id;
    changed.push('categoryId');
  }
  if (typeof fields.slug === 'string' && fields.slug.trim()) {
    next.slug = uniqueSlug('faq_questions', slugify(fields.slug, row.slug), row.id);
    changed.push('slug');
  }
  if (fields.seq !== undefined && Number.isFinite(Number(fields.seq))) {
    next.seq = Number(fields.seq);
    changed.push('seq');
  }
  if (FAQ_STATUSES.includes(fields.status)) { next.status = fields.status; changed.push('status'); }
  if (FAQ_VISIBILITIES.includes(fields.visibility)) { next.visibility = fields.visibility; changed.push('visibility'); }
  if (changed.length === 0) return { error: 'Nothing to change.', status: 400 };

  // This statement always names question/answer/keywords, so faq_questions_au
  // fires on every edit. On a status-only change the delete+insert into the FTS
  // index is harmless and idempotent. published_at is stamped once, on first
  // publish, and never moves afterwards.
  db.prepare(
    `UPDATE faq_questions
        SET category_id = ?, slug = ?, question = ?, answer = ?, keywords = ?, seq = ?,
            status = ?, visibility = ?,
            published_at = CASE WHEN ? = 'published' AND published_at IS NULL
                                THEN datetime('now') ELSE published_at END,
            updated_by = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(
    next.category_id, next.slug, next.question, next.answer, next.keywords, next.seq,
    next.status, next.visibility, next.status, actor.id, row.id
  );
  audit(actor.id, 'faq.question_updated', 'faq_question', row.id, { changed });
  return { ok: true, questionId: row.id, changed };
}

export function deleteQuestion(actor, id) {
  const row = db.prepare('SELECT id FROM faq_questions WHERE id = ?').get(Number(id));
  if (!row) return { error: 'That FAQ entry was not found.', status: 404 };
  db.prepare('DELETE FROM faq_questions WHERE id = ?').run(row.id);
  audit(actor.id, 'faq.question_deleted', 'faq_question', row.id, {});
  return { ok: true, deleted: true };
}

export function setQuestionStatus(actor, id, status) {
  if (!FAQ_STATUSES.includes(status)) return { error: 'Choose draft or published.', status: 400 };
  const row = db.prepare('SELECT * FROM faq_questions WHERE id = ?').get(Number(id));
  if (!row) return { error: 'That FAQ entry was not found.', status: 404 };
  if (row.status === status) return { error: 'Nothing to change.', status: 400 };
  db.prepare(
    `UPDATE faq_questions
        SET status = ?,
            published_at = CASE WHEN ? = 'published' AND published_at IS NULL
                                THEN datetime('now') ELSE published_at END,
            updated_by = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(status, status, actor.id, row.id);
  audit(
    actor.id,
    status === 'published' ? 'faq.question_published' : 'faq.question_unpublished',
    'faq_question',
    row.id,
    {}
  );
  return { ok: true, questionId: row.id, status };
}

export function reorderQuestions(actor, categoryId, ids) {
  const category = requireCategory(categoryId);
  if (!category) return { error: 'That category was not found.', status: 404 };
  const ordered = idList(ids);
  if (ordered.length === 0) return { error: 'Nothing to reorder.', status: 400 };
  const stmt = db.prepare(
    `UPDATE faq_questions SET seq = ?, updated_by = ?, updated_at = datetime('now')
      WHERE id = ? AND category_id = ?`
  );
  db.exec('BEGIN');
  try {
    ordered.forEach((qid, i) => stmt.run((i + 1) * 10, actor.id, qid, category.id));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  audit(actor.id, 'faq.questions_reordered', 'faq_question', '', {
    categoryId: category.id,
    count: ordered.length,
  });
  return { ok: true, count: ordered.length };
}

// ── public interactions ───────────────────────────────────────────────────
// Both resolve the id through the SCOPED query first and return the identical
// 404 for "no such row" and "out of scope", so an anonymous caller cannot probe
// for draft or members-only ids. Neither is audited: one audit row per
// anonymous click is unbounded growth on an unauthenticated path.
function scopedQuestionId(user, id) {
  const scope = faqScope(user);
  const row = db
    .prepare(
      `SELECT q.id FROM faq_questions q
         JOIN faq_categories c ON c.id = q.category_id
        WHERE q.id = ? AND ${scope.sql}`
    )
    .get(Number(id));
  return row ? row.id : null;
}

export function recordFaqFeedback(user, id, helpful) {
  const questionId = scopedQuestionId(user, id);
  if (!questionId) return { error: 'That FAQ entry was not found.', status: 404 };
  // Counter-only statement: faq_questions_au is scoped with UPDATE OF, so this
  // deliberately does not touch the FTS index.
  const column = helpful ? 'helpful_count' : 'not_helpful_count';
  db.prepare(`UPDATE faq_questions SET ${column} = ${column} + 1 WHERE id = ?`).run(questionId);
  const row = db
    .prepare('SELECT helpful_count, not_helpful_count FROM faq_questions WHERE id = ?')
    .get(questionId);
  return { ok: true, helpful: row.helpful_count, notHelpful: row.not_helpful_count };
}

export function recordFaqView(user, id) {
  const questionId = scopedQuestionId(user, id);
  if (!questionId) return { error: 'That FAQ entry was not found.', status: 404 };
  db.prepare('UPDATE faq_questions SET view_count = view_count + 1 WHERE id = ?').run(questionId);
  return { ok: true };
}

// Operational repair for a stale external-content index. Verified to fully
// restore one; see the trigger comment in schema.sql.
export function rebuildFaqIndex(actor) {
  db.exec("INSERT INTO faq_fts(faq_fts) VALUES('rebuild')");
  const questionCount = db.prepare('SELECT COUNT(*) AS n FROM faq_questions').get().n;
  audit(actor.id, 'faq.index_rebuilt', 'faq', '', { questionCount });
  return { ok: true, questionCount };
}
