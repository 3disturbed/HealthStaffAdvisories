import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/connection.js';
import { requirePermission } from '../auth/middleware.js';
import { userHas } from '../rbac/permissions.js';
import { audit } from '../audit/log.js';
import { config } from '../config.js';
import { aiEnabled } from '../ai/provider.js';
import { DOCUMENT_TYPES, classifyUpload, storeUpload, extractText } from '../services/documentIntake.js';
import * as je from '../services/jobEvaluation.js';
import * as jeReports from '../services/jeReports.js';
import * as jeRef from '../services/jeReference.js';
import { referenceReady } from '../je/reference.js';
import { runJeAnalysis, reapStaleRuns } from '../ai/jePipeline.js';

// Job evaluation & banding API. Thin routes; logic in services. All member
// access is owner-scoped and 404s (never 403s) on other people's reviews.

export const jeRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

function respond(res, result) {
  if (result?.error) {
    const { error, status = 400, ...rest } = result;
    return res.status(status).json({ error, ...rest });
  }
  res.json(result);
}

// ── Section status, offer, questions ─────────────────────────────────────

jeRouter.get('/status', requirePermission('je.own'), (req, res) => {
  const readiness = referenceReady('afc');
  res.json({
    ok: true,
    ready: readiness.ready,
    aiEnabled: aiEnabled(),
    offer: jeRef.getOffer(),
    consentVersion: je.CONSENT_VERSION,
  });
});

jeRouter.get('/offer', requirePermission('je.own'), (req, res) => {
  res.json({ ok: true, offer: jeRef.getOffer() });
});

jeRouter.post('/offer', requirePermission('system.admin'), (req, res) => {
  respond(res, jeRef.setOffer(req.user, req.body || {}));
});

jeRouter.get('/questions', requirePermission('je.own'), (req, res) => {
  res.json({ ok: true, ...je.questionPayload() });
});

// ── Member: reviews ──────────────────────────────────────────────────────

jeRouter.post('/reviews', requirePermission('je.own'), (req, res) => {
  respond(res, je.createReview(req.user, req.body || {}));
});

jeRouter.get('/reviews', requirePermission('je.own'), (req, res) => {
  respond(res, je.listReviewsForMember(req.user.id));
});

jeRouter.get('/reviews/:id', requirePermission('je.own'), (req, res) => {
  // Advisors use the workbench route; this one is the member view.
  respond(res, je.getReviewForMember(req.user, req.params.id));
});

jeRouter.patch('/reviews/:id/answers', requirePermission('je.own'), (req, res) => {
  respond(res, je.saveAnswers(req.user, req.params.id, req.body || {}));
});

jeRouter.patch('/reviews/:id/factors/:code', requirePermission('je.own'), (req, res) => {
  respond(res, je.setClaimedLevel(req.user, req.params.id, req.params.code, req.body || {}));
});

jeRouter.post('/reviews/:id/comparators', requirePermission('je.own'), (req, res) => {
  respond(res, je.addComparator(req.user, req.params.id, req.body || {}));
});

jeRouter.post('/reviews/:id/messages', requirePermission('je.own'), (req, res) => {
  respond(res, je.postMessage(req.user, req.params.id, req.body || {}));
});

jeRouter.post('/reviews/:id/submit', requirePermission('je.own'), (req, res) => {
  const result = je.submitReview(req.user, req.params.id);
  if (!result.error && result.ok && !result.alreadySubmitted && aiEnabled()) {
    runJeAnalysis(Number(req.params.id), { trigger: 'member_submit', requestedBy: req.user.id })
      .catch((err) => console.error(`JE analysis failed for review ${req.params.id}: ${err.message}`));
  }
  respond(res, result);
});

// ── Documents (JE-scoped, shared intake pipeline) ────────────────────────

jeRouter.post('/reviews/:id/documents', requirePermission('je.own'), upload.single('file'), async (req, res) => {
  const loaded = je.loadReviewAuthorised(req.user, req.params.id);
  if (loaded.error) return respond(res, loaded);
  if (!loaded.isOwner && !loaded.isAdvisor) return res.status(404).json({ error: 'Review not found.' });

  const classified = classifyUpload(req.file);
  if (classified.error) return res.status(400).json({ error: classified.error });
  const { kind } = classified;
  const { storageKey, sha256, safeName } = storeUpload(req.file, kind);
  const docRole = je.DOC_ROLES.includes(req.body.docRole) ? req.body.docRole : 'other';
  const documentDated = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.documentDated || '')) ? req.body.documentDated : null;

  const info = db
    .prepare(
      `INSERT INTO je_documents (review_id, owner_user_id, doc_role, storage_key, original_filename, media_type, size_bytes, sha256, document_dated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(loaded.review.id, req.user.id, docRole, storageKey, safeName, DOCUMENT_TYPES[kind].mime, req.file.size, sha256, documentDated);
  const docId = info.lastInsertRowid;
  audit(req.user.id, 'je.document_uploaded', 'je_review', loaded.review.id, { documentId: docId, docRole, bytes: req.file.size });

  try {
    const text = await extractText(kind, req.file.buffer);
    db.prepare(`UPDATE je_documents SET status = 'extracted', extracted_text = ? WHERE id = ?`).run(text, docId);
  } catch {
    db.prepare(`UPDATE je_documents SET status = 'extraction_failed' WHERE id = ?`).run(docId);
  }
  db.prepare(`UPDATE je_reviews SET updated_at = datetime('now') WHERE id = ?`).run(loaded.review.id);
  const doc = db.prepare('SELECT id, doc_role, original_filename, media_type, size_bytes, status, document_dated, created_at FROM je_documents WHERE id = ?').get(docId);
  res.json({ ok: true, document: doc });
});

function loadJeDocumentAuthorised(req, docId) {
  const doc = db.prepare('SELECT * FROM je_documents WHERE id = ?').get(Number(docId));
  if (!doc) return { error: 'Document not found.', status: 404 };
  const isOwner = doc.owner_user_id === req.user.id;
  const isAdvisor = userHas(req.user, 'je.review');
  if (!isOwner && !isAdvisor) return { error: 'Document not found.', status: 404 };
  return { doc };
}

jeRouter.get('/documents/:id/download', requirePermission('je.own'), (req, res) => {
  const loaded = loadJeDocumentAuthorised(req, req.params.id);
  if (loaded.error) return respond(res, loaded);
  const { doc } = loaded;
  const filePath = path.join(config.uploadDir, path.basename(doc.storage_key));
  if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'Stored file is missing.' });
  audit(req.user.id, 'je.document_downloaded', 'je_document', doc.id);
  res.setHeader('Content-Type', doc.media_type);
  res.setHeader('Content-Disposition', `attachment; filename="${doc.original_filename.replace(/"/g, '')}"`);
  fs.createReadStream(filePath).pipe(res);
});

jeRouter.get('/documents/:id/text', requirePermission('je.own'), (req, res) => {
  const loaded = loadJeDocumentAuthorised(req, req.params.id);
  if (loaded.error) return respond(res, loaded);
  const { doc } = loaded;
  res.json({ id: doc.id, filename: doc.original_filename, status: doc.status, text: doc.extracted_text || '' });
});

// ── Advisor: queue & workbench ───────────────────────────────────────────

jeRouter.get('/queue', requirePermission('je.review'), (req, res) => {
  reapStaleRuns();
  respond(res, je.queue(String(req.query.view || 'needs_review')));
});

jeRouter.get('/reviews/:id/workbench', requirePermission('je.review'), (req, res) => {
  reapStaleRuns();
  respond(res, je.getWorkbench(req.user, req.params.id));
});

jeRouter.post('/reviews/:id/analyse', requirePermission('je.review'), (req, res) => {
  if (!aiEnabled()) return res.status(400).json({ error: 'AI is not configured or is disabled.' });
  const loaded = je.loadReviewAuthorised(req.user, req.params.id);
  if (loaded.error) return respond(res, loaded);
  const running = db.prepare(`SELECT id FROM je_runs WHERE review_id = ? AND status = 'running'`).get(loaded.review.id);
  if (running) return res.status(409).json({ error: 'An analysis is already running for this review.' });
  runJeAnalysis(loaded.review.id, { trigger: 'advisor', requestedBy: req.user.id })
    .catch((err) => console.error(`JE analysis failed for review ${loaded.review.id}: ${err.message}`));
  res.json({ ok: true, queued: true });
});

jeRouter.patch('/reviews/:id/factors/:code/confirm', requirePermission('je.review'), (req, res) => {
  respond(res, je.confirmFactor(req.user, req.params.id, req.params.code, req.body || {}));
});

jeRouter.post('/reviews/:id/recompute', requirePermission('je.review'), (req, res) => {
  const loaded = je.loadReviewAuthorised(req.user, req.params.id);
  if (loaded.error) return respond(res, loaded);
  if (req.body?.useLatestRuleset === true) {
    const rebased = je.rebaseRuleset(req.user, req.params.id);
    if (rebased.error) return respond(res, rebased);
  }
  const basis = ['claimed', 'ai_proposed', 'confirmed'].includes(req.body?.basis) ? req.body.basis : 'confirmed';
  respond(res, je.computeAndStoreOutcome(Number(req.params.id), basis, req.user.id));
});

jeRouter.post('/reviews/:id/evidence/:eid', requirePermission('je.review'), (req, res) => {
  respond(res, je.confirmEvidence(req.user, req.params.id, req.params.eid, req.body?.action));
});

jeRouter.post('/reviews/:id/profiles/:mid/select', requirePermission('je.review'), (req, res) => {
  respond(res, je.selectProfile(req.user, req.params.id, req.params.mid));
});

jeRouter.patch('/reviews/:id/comparators/:cid', requirePermission('je.review'), (req, res) => {
  respond(res, je.verifyComparator(req.user, req.params.id, req.params.cid, req.body?.action));
});

jeRouter.post('/reviews/:id/lock', requirePermission('je.review'), (req, res) => {
  respond(res, je.setMemberEditable(req.user, req.params.id, req.body?.memberEditable !== false));
});

jeRouter.post('/reviews/:id/flags/:fid/ack', requirePermission('je.review'), (req, res) => {
  respond(res, je.acknowledgeFlag(req.user, req.params.id, req.params.fid));
});

jeRouter.post('/reviews/:id/stage', requirePermission('je.review'), (req, res) => {
  respond(res, je.setStage(req.user, req.params.id, String(req.body?.stage || '')));
});

jeRouter.post('/reviews/:id/messages/advisor', requirePermission('je.review'), (req, res) => {
  respond(res, je.postMessage(req.user, req.params.id, req.body || {}));
});

// ── Sign-off, reports, decisions (je.decide) ─────────────────────────────

jeRouter.post('/reviews/:id/signoff', requirePermission('je.decide'), (req, res) => {
  respond(res, je.signOff(req.user, req.params.id, req.body || {}));
});

jeRouter.post('/reviews/:id/reports', requirePermission('je.decide'), (req, res) => {
  respond(res, jeReports.generateReport(req.user, req.params.id, req.body || {}));
});

jeRouter.post('/reports/:id/approve', requirePermission('je.decide'), (req, res) => {
  respond(res, jeReports.approveReport(req.user, req.params.id, req.body || {}));
});

jeRouter.post('/reports/:id/withdraw', requirePermission('je.decide'), (req, res) => {
  respond(res, jeReports.withdrawReport(req.user, req.params.id));
});

jeRouter.post('/reviews/:id/decisions', requirePermission('je.decide'), (req, res) => {
  respond(res, je.recordDecision(req.user, req.params.id, req.body || {}));
});

// Markdown export of the latest employer submission.
jeRouter.get('/reviews/:id/submission.md', requirePermission('je.review'), (req, res) => {
  const loaded = je.loadReviewAuthorised(req.user, req.params.id);
  if (loaded.error) return respond(res, loaded);
  const report = db
    .prepare(`SELECT * FROM je_reports WHERE review_id = ? AND audience = 'employer_submission' AND status != 'withdrawn' ORDER BY id DESC LIMIT 1`)
    .get(loaded.review.id);
  if (!report) return res.status(404).json({ error: 'No employer submission has been generated yet.' });
  const text = jeReports.submissionMarkdown(JSON.parse(report.body_json));
  audit(req.user.id, 'je.submission_exported', 'je_review', loaded.review.id, { reportId: report.id });
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="band-review-submission-${loaded.review.id}.md"`);
  res.send(text);
});

// ── Oversight & reference administration ─────────────────────────────────

jeRouter.get('/oversight', requirePermission('je.review'), (req, res) => {
  respond(res, je.oversightMetrics());
});

jeRouter.get('/metrics', requirePermission('je.monitor'), (req, res) => {
  respond(res, je.oversightMetrics());
});

jeRouter.get('/reference', requirePermission('je.reference.manage'), (req, res) => {
  respond(res, jeRef.listRulesets(String(req.query.scheme || 'afc')));
});

jeRouter.get('/reference/rulesets/:id', requirePermission('je.reference.manage'), (req, res) => {
  respond(res, jeRef.getRulesetDetail(req.params.id));
});

jeRouter.post('/reference/rulesets', requirePermission('je.reference.manage'), (req, res) => {
  respond(res, jeRef.importRuleset(req.user, req.body || {}));
});

jeRouter.post('/reference/rulesets/:id/approve', requirePermission('je.reference.manage'), (req, res) => {
  respond(res, jeRef.approveRuleset(req.user, req.params.id));
});

jeRouter.post('/reference/rulesets/:id/verify', requirePermission('je.reference.manage'), (req, res) => {
  respond(res, jeRef.verifyRuleset(req.user, req.params.id));
});
