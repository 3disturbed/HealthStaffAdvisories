import { db } from '../db/connection.js';

// Retrieve approved knowledge chunks relevant to a query via SQLite FTS5.
// Only approved, non-superseded versions are searched.
export function retrieveChunks(query, limit = 8) {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (terms.length === 0) return [];
  const ftsQuery = [...new Set(terms)].slice(0, 24).map((t) => `"${t}"`).join(' OR ');
  try {
    return db
      .prepare(
        `SELECT c.id AS chunk_id, c.content, s.title, s.publisher, s.source_type, s.canonical_url,
                v.version_label, v.effective_from, v.id AS version_id
         FROM knowledge_fts f
         JOIN knowledge_chunks c ON c.id = f.rowid
         JOIN knowledge_versions v ON v.id = c.version_id
         JOIN knowledge_sources s ON s.id = v.source_id
         WHERE knowledge_fts MATCH ? AND v.review_status = 'approved'
         ORDER BY rank LIMIT ?`
      )
      .all(ftsQuery, limit);
  } catch {
    return []; // malformed FTS query must never break intake
  }
}
