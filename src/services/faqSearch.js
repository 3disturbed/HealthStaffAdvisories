import { db } from '../db/connection.js';
import { faqScope } from './faqActions.js';

// Deterministic FAQ shortlist via SQLite FTS5. Mirrors src/ai/retrieve.js:
// same tokenising, same OR-of-quoted-terms, same swallow-everything guard.
// This is the path that must ALWAYS work — with no API key, with the kill
// switch on, or with the provider down.
export function faqShortlist(query, user, limit = 12) {
  const terms = String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (terms.length === 0) return [];
  const ftsQuery = [...new Set(terms)].slice(0, 24).map((t) => `"${t}"`).join(' OR ');
  const scope = faqScope(user);
  try {
    // bm25 weights: a hit in the question outranks one in keywords, which
    // outranks a passing mention in a long answer. The FTS table must not be
    // aliased here or bm25() cannot resolve it.
    return db
      .prepare(
        `SELECT q.id, q.slug, q.question, q.answer, q.keywords, q.status, q.visibility,
                q.helpful_count, q.category_id,
                c.slug AS category_slug, c.name AS category_name
           FROM faq_fts
           JOIN faq_questions q ON q.id = faq_fts.rowid
           JOIN faq_categories c ON c.id = q.category_id
          WHERE faq_fts MATCH ? AND ${scope.sql}
          ORDER BY bm25(faq_fts, 8.0, 1.0, 4.0)
          LIMIT ?`
      )
      .all(ftsQuery, limit);
  } catch {
    // A malformed FTS query must never break the public help page. This is
    // load-bearing: MATCH '"' throws "unterminated string".
    return [];
  }
}

// Public-safe wire shape.
export function faqSearchHit(r) {
  return {
    id: r.id,
    slug: r.slug,
    categoryId: r.category_id,
    categorySlug: r.category_slug,
    categoryName: r.category_name,
    question: r.question,
    answer: r.answer,
    status: r.status,
    visibility: r.visibility,
    helpfulCount: r.helpful_count,
  };
}

// True when the top hit already covers every search term — an exact-intent
// match that does not need a model to reorder a list of one good answer.
// Deterministic term coverage, NOT a bm25 threshold: bm25 returns negative,
// corpus-relative scores that are meaningless as an absolute confidence gate.
export function topCoversAllTerms(query, row) {
  if (!row) return false;
  const terms = String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (terms.length === 0) return false;
  const haystack = `${row.question} ${row.keywords}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}
