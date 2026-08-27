import crypto from 'node:crypto';
import { db } from '../db/connection.js';
import { audit } from '../audit/log.js';

export const SOURCE_TYPES = ['legislation', 'acas', 'nhs_national', 'regulator', 'trust_policy', 'guidance'];

// Paragraph-based chunking, ~1000 chars per chunk.
export function chunkContent(content) {
  const paragraphs = content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const p of paragraphs) {
    if (current && current.length + p.length > 1000) {
      chunks.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function insertVersion(sourceId, { content, versionLabel, effectiveFrom }, supersedesId = null) {
  const checksum = crypto.createHash('sha256').update(content).digest('hex');
  const info = db
    .prepare(
      `INSERT INTO knowledge_versions (source_id, version_label, effective_from, checksum, review_status, supersedes_id, content)
       VALUES (?, ?, ?, ?, 'approved', ?, ?)`
    )
    .run(sourceId, versionLabel || 'v1', effectiveFrom || null, checksum, supersedesId, content);
  const versionId = info.lastInsertRowid;
  const chunks = chunkContent(content);
  const stmt = db.prepare('INSERT INTO knowledge_chunks (version_id, seq, content) VALUES (?, ?, ?)');
  chunks.forEach((chunk, i) => stmt.run(versionId, i, chunk));
  return { versionId, chunkCount: chunks.length };
}

function auditMeta(base, opts) {
  return opts.via ? { ...base, via: opts.via, actionId: opts.actionId } : base;
}

export function addKnowledgeSource(actor, fields, opts = {}) {
  const title = String(fields.title || '').trim().slice(0, 200);
  const content = String(fields.content || '').trim();
  if (!title || content.length < 50) {
    return { error: 'A title and at least a paragraph of source content are required.', status: 400 };
  }
  const info = db
    .prepare(
      `INSERT INTO knowledge_sources (title, publisher, source_type, jurisdiction, canonical_url, created_by) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      title,
      String(fields.publisher || '').trim().slice(0, 120),
      SOURCE_TYPES.includes(fields.sourceType) ? fields.sourceType : 'guidance',
      String(fields.jurisdiction || 'UK').trim().slice(0, 40),
      String(fields.url || '').trim().slice(0, 400),
      actor.id
    );
  const sourceId = info.lastInsertRowid;
  const { versionId, chunkCount } = insertVersion(sourceId, { ...fields, content });
  audit(actor.id, 'knowledge.source_added', 'knowledge_source', sourceId, auditMeta({ versionId, chunkCount }, opts));
  return { ok: true, sourceId, versionId, chunkCount };
}

// New version supersedes the current one; superseded versions stay auditable
// and are excluded from new retrieval (F2, AI-SAFETY-DATA §5).
export function addKnowledgeVersion(actor, sourceId, fields, opts = {}) {
  const source = db.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(Number(sourceId));
  if (!source) return { error: 'Source not found.', status: 404 };
  const content = String(fields.content || '').trim();
  if (content.length < 50) return { error: 'At least a paragraph of source content is required.', status: 400 };

  const current = db
    .prepare(`SELECT id FROM knowledge_versions WHERE source_id = ? AND review_status = 'approved' ORDER BY id DESC LIMIT 1`)
    .get(source.id);
  const { versionId, chunkCount } = insertVersion(source.id, { ...fields, content }, current?.id || null);
  if (current) {
    db.prepare(`UPDATE knowledge_versions SET review_status = 'superseded' WHERE id = ?`).run(current.id);
  }
  audit(actor.id, 'knowledge.version_added', 'knowledge_source', source.id, auditMeta({ versionId, superseded: current?.id || null, chunkCount }, opts));
  return { ok: true, versionId, chunkCount };
}
