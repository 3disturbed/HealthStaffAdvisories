import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/connection.js';
import { requirePermission, requireAuth } from '../auth/middleware.js';
import { userHas } from '../rbac/permissions.js';
import { audit } from '../audit/log.js';
import { config } from '../config.js';
import { DOCUMENT_TYPES, classifyUpload, storeUpload, extractText } from '../services/documentIntake.js';

export const documentsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

documentsRouter.post('/cases/:id/documents', requirePermission('cases.own'), upload.single('file'), async (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(Number(req.params.id));
  if (!c || c.member_id !== req.user.id) return res.status(404).json({ error: 'Case not found.' });
  const classified = classifyUpload(req.file);
  if (classified.error) return res.status(400).json({ error: classified.error });
  const { kind } = classified;

  const { storageKey, sha256, safeName } = storeUpload(req.file, kind);
  const info = db
    .prepare(
      `INSERT INTO documents (owner_user_id, case_id, storage_key, original_filename, media_type, size_bytes, sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.user.id, c.id, storageKey, safeName, DOCUMENT_TYPES[kind].mime, req.file.size, sha256);
  const docId = info.lastInsertRowid;
  audit(req.user.id, 'document.uploaded', 'document', docId, { caseId: c.id, bytes: req.file.size });

  try {
    const text = await extractText(kind, req.file.buffer);
    db.prepare(`UPDATE documents SET status = 'extracted', extracted_text = ? WHERE id = ?`).run(text, docId);
  } catch {
    db.prepare(`UPDATE documents SET status = 'extraction_failed' WHERE id = ?`).run(docId);
  }
  db.prepare(`UPDATE cases SET updated_at = datetime('now') WHERE id = ?`).run(c.id);
  const doc = db.prepare('SELECT id, original_filename, media_type, size_bytes, status, created_at FROM documents WHERE id = ?').get(docId);
  res.json({ ok: true, document: doc });
});

// Download: owner or advisor only. Files are private — no static serving.
documentsRouter.get('/documents/:id/download', requireAuth, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  const isOwner = doc.owner_user_id === req.user.id;
  const isAdvisor = userHas(req.user, 'cases.review');
  if (!isOwner && !isAdvisor) return res.status(404).json({ error: 'Document not found.' });

  const filePath = path.join(config.uploadDir, path.basename(doc.storage_key));
  if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'Stored file is missing.' });
  audit(req.user.id, 'document.downloaded', 'document', doc.id);
  res.setHeader('Content-Type', doc.media_type);
  res.setHeader('Content-Disposition', `attachment; filename="${doc.original_filename.replace(/"/g, '')}"`);
  fs.createReadStream(filePath).pipe(res);
});

// Extracted text view for advisors (D2).
documentsRouter.get('/documents/:id/text', requireAuth, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  const isOwner = doc.owner_user_id === req.user.id;
  const isAdvisor = userHas(req.user, 'cases.review');
  if (!isOwner && !isAdvisor) return res.status(404).json({ error: 'Document not found.' });
  res.json({ id: doc.id, filename: doc.original_filename, status: doc.status, text: doc.extracted_text || '' });
});
