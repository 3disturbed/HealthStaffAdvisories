import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db/connection.js';
import { requirePermission } from '../auth/middleware.js';
import { audit } from '../audit/log.js';

export const knowledgeRouter = Router();

const SOURCE_TYPES = ['legislation', 'acas', 'nhs_national', 'regulator', 'trust_policy', 'guidance'];

// Paragraph-based chunking, ~1000 chars per chunk.
function chunkContent(content) {
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

function insertVersion(sourceId, { content, versionLabel, effectiveFrom }, supersedesId = null) {
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

knowledgeRouter.get('/sources', requirePermission('knowledge.manage'), (req, res) => {
  const sources = db
    .prepare(
      `SELECT s.*,
        (SELECT COUNT(*) FROM knowledge_versions v WHERE v.source_id = s.id) AS version_count,
        (SELECT v.version_label FROM knowledge_versions v WHERE v.source_id = s.id AND v.review_status = 'approved' ORDER BY v.id DESC LIMIT 1) AS current_version,
        (SELECT COUNT(*) FROM knowledge_chunks c JOIN knowledge_versions v ON v.id = c.version_id WHERE v.source_id = s.id AND v.review_status = 'approved') AS chunk_count
       FROM knowledge_sources s ORDER BY s.title`
    )
    .all();
  res.json({ sources, sourceTypes: SOURCE_TYPES });
});

knowledgeRouter.post('/sources', requirePermission('knowledge.manage'), (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 200);
  const content = String(req.body.content || '').trim();
  if (!title || content.length < 50) {
    return res.status(400).json({ error: 'A title and at least a paragraph of source content are required.' });
  }
  const info = db
    .prepare(
      `INSERT INTO knowledge_sources (title, publisher, source_type, jurisdiction, canonical_url, created_by) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      title,
      String(req.body.publisher || '').trim().slice(0, 120),
      SOURCE_TYPES.includes(req.body.sourceType) ? req.body.sourceType : 'guidance',
      String(req.body.jurisdiction || 'UK').trim().slice(0, 40),
      String(req.body.url || '').trim().slice(0, 400),
      req.user.id
    );
  const sourceId = info.lastInsertRowid;
  const { versionId, chunkCount } = insertVersion(sourceId, req.body);
  audit(req.user.id, 'knowledge.source_added', 'knowledge_source', sourceId, { versionId, chunkCount });
  res.json({ ok: true, sourceId, versionId, chunkCount });
});

// New version supersedes the current one; superseded versions stay auditable
// and are excluded from new retrieval (F2, AI-SAFETY-DATA §5).
knowledgeRouter.post('/sources/:id/versions', requirePermission('knowledge.manage'), (req, res) => {
  const source = db.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(Number(req.params.id));
  if (!source) return res.status(404).json({ error: 'Source not found.' });
  const content = String(req.body.content || '').trim();
  if (content.length < 50) return res.status(400).json({ error: 'At least a paragraph of source content is required.' });

  const current = db
    .prepare(`SELECT id FROM knowledge_versions WHERE source_id = ? AND review_status = 'approved' ORDER BY id DESC LIMIT 1`)
    .get(source.id);
  const { versionId, chunkCount } = insertVersion(source.id, req.body, current?.id || null);
  if (current) {
    db.prepare(`UPDATE knowledge_versions SET review_status = 'superseded' WHERE id = ?`).run(current.id);
  }
  audit(req.user.id, 'knowledge.version_added', 'knowledge_source', source.id, { versionId, superseded: current?.id || null, chunkCount });
  res.json({ ok: true, versionId, chunkCount });
});
