import { Router } from 'express';
import { db } from '../db/connection.js';
import { requirePermission } from '../auth/middleware.js';
import { audit } from '../audit/log.js';
import { sendAdvisorReply } from '../services/caseActions.js';
import { runIntake, aiEnabled } from '../ai/intake.js';
import { CASE_TYPES, MEMBER_STATUS_LABELS, attachMessageDocuments } from './cases.js';

export const advisorRouter = Router();

const STATUSES = Object.keys(MEMBER_STATUS_LABELS);
const URGENCIES = ['critical', 'high', 'normal', 'self_service'];

function caseCard(c) {
  return {
    id: c.id, title: c.title, status: c.status,
    statusLabel: MEMBER_STATUS_LABELS[c.status] || c.status,
    urgency: c.urgency, urgencyReason: c.urgency_reason,
    caseType: c.case_type, typeLabel: CASE_TYPES[c.case_type] || c.case_type,
    member: c.member_name, employer: c.employer,
    nextImportantAt: c.next_important_at,
    createdAt: c.created_at, updatedAt: c.updated_at,
    openEscalations: c.open_escalations,
    lastMessageBy: c.last_message_by || null,
    lastMessageAt: c.last_message_at || null,
  };
}

// Queue, sorted per PRD: urgency, then next deadline, then awaiting Kelly, then age.
advisorRouter.get('/queue', requirePermission('cases.review'), (req, res) => {
  const view = String(req.query.view || 'all');
  const where = {
    urgent: `c.urgency IN ('critical','high') AND c.status != 'closed'`,
    awaiting: `c.status = 'waiting_for_kelly'`,
    waiting_member: `c.status = 'need_member_info'`,
    action_sent: `c.status IN ('action_plan_ready','ongoing')`,
    closed: `c.status = 'closed'`,
    all: '1=1',
  }[view] || '1=1';

  const rows = db
    .prepare(
      `SELECT c.*, u.display_name AS member_name,
        (SELECT COUNT(*) FROM escalations e WHERE e.case_id = c.id AND e.resolved_at IS NULL) AS open_escalations,
        (SELECT CASE WHEN m.author_user_id = c.member_id THEN 'member' ELSE 'advisor' END
           FROM case_messages m WHERE m.case_id = c.id AND m.visibility = 'member'
           ORDER BY m.id DESC LIMIT 1) AS last_message_by,
        (SELECT m.created_at FROM case_messages m WHERE m.case_id = c.id AND m.visibility = 'member'
           ORDER BY m.id DESC LIMIT 1) AS last_message_at
       FROM cases c JOIN users u ON u.id = c.member_id
       WHERE ${where}
       ORDER BY
         CASE c.urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         c.next_important_at IS NULL, c.next_important_at,
         c.status = 'waiting_for_kelly' DESC,
         c.created_at`
    )
    .all();
  const counts = {};
  for (const [key, clause] of Object.entries({
    urgent: `urgency IN ('critical','high') AND status != 'closed'`,
    awaiting: `status = 'waiting_for_kelly'`,
    waiting_member: `status = 'need_member_info'`,
    action_sent: `status IN ('action_plan_ready','ongoing')`,
    closed: `status = 'closed'`,
    all: '1=1',
  })) {
    counts[key] = db.prepare(`SELECT COUNT(*) AS n FROM cases WHERE ${clause}`).get().n;
  }
  res.json({ view, counts, cases: rows.map(caseCard) });
});

advisorRouter.get('/cases/:id', requirePermission('cases.review'), (req, res) => {
  const c = db
    .prepare(
      `SELECT c.*, u.display_name AS member_name, u.email AS member_email, u.created_at AS member_since, u.pay_band AS member_pay_band
       FROM cases c JOIN users u ON u.id = c.member_id WHERE c.id = ?`
    )
    .get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Case not found.' });

  const messages = attachMessageDocuments(
    db
      .prepare(
        `SELECT m.id, m.author_user_id, m.visibility, m.kind, m.content, m.meta, m.created_at, m.approved_by, u.display_name AS author_name
         FROM case_messages m LEFT JOIN users u ON u.id = m.author_user_id
         WHERE m.case_id = ? ORDER BY m.created_at, m.id`
      )
      .all(c.id),
    c.id
  );
  const timeline = db
    .prepare(`SELECT * FROM case_timeline WHERE case_id = ? ORDER BY event_date IS NULL, event_date`)
    .all(c.id);
  const documents = db
    .prepare(`SELECT id, original_filename, media_type, size_bytes, status, created_at FROM documents WHERE case_id = ?`)
    .all(c.id);
  const escalations = db
    .prepare(
      `SELECT e.*, u.display_name AS resolved_by_name FROM escalations e
       LEFT JOIN users u ON u.id = e.resolved_by WHERE e.case_id = ? ORDER BY e.created_at DESC`
    )
    .all(c.id);
  const aiRow = db
    .prepare(`SELECT id, output_json, model, prompt_version, status, created_at FROM ai_outputs WHERE case_id = ? ORDER BY id DESC LIMIT 1`)
    .get(c.id);
  let ai = null;
  if (aiRow) {
    ai = {
      id: aiRow.id, model: aiRow.model, promptVersion: aiRow.prompt_version,
      status: aiRow.status, createdAt: aiRow.created_at,
      output: aiRow.status === 'ok' ? JSON.parse(aiRow.output_json) : null,
    };
    if (ai.output) {
      ai.citations = db
        .prepare(
          `SELECT ci.claim, ci.chunk_id, s.title, s.publisher, s.source_type, s.canonical_url, v.version_label, k.content AS chunk_content
           FROM citations ci
           JOIN knowledge_chunks k ON k.id = ci.chunk_id
           JOIN knowledge_versions v ON v.id = k.version_id
           JOIN knowledge_sources s ON s.id = v.source_id
           WHERE ci.ai_output_id = ?`
        )
        .all(aiRow.id);
    }
  }

  audit(req.user.id, 'case.advisor_opened', 'case', c.id);
  res.json({
    case: { ...caseCard({ ...c, open_escalations: escalations.filter((e) => !e.resolved_at).length }),
      whatHappened: c.what_happened, staffGroup: c.staff_group, formalStage: c.formal_stage,
      meetingOrDeadline: c.meeting_or_deadline, desiredOutcome: c.desired_outcome,
      memberEmail: c.member_email, memberSince: c.member_since, memberPayBand: c.member_pay_band || '', closedAt: c.closed_at },
    messages, timeline, documents, escalations, ai, aiEnabled: aiEnabled(),
  });
});

advisorRouter.post('/cases/:id/reply', requirePermission('cases.respond'), (req, res) => {
  const result = sendAdvisorReply(req.user, req.params.id, { kind: req.body.kind, content: req.body.content });
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.json(result);
});

advisorRouter.post('/cases/:id/notes', requirePermission('cases.notes'), (req, res) => {
  const c = db.prepare('SELECT id FROM cases WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Case not found.' });
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Note is empty.' });
  db.prepare(
    `INSERT INTO case_messages (case_id, author_user_id, visibility, kind, content) VALUES (?, ?, 'advisor_private', 'note', ?)`
  ).run(c.id, req.user.id, content);
  audit(req.user.id, 'case.private_note', 'case', c.id);
  res.json({ ok: true });
});

advisorRouter.patch('/cases/:id', requirePermission('cases.status'), (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Case not found.' });
  const changes = {};
  if (req.body.status && STATUSES.includes(req.body.status)) changes.status = req.body.status;
  if (req.body.urgency && URGENCIES.includes(req.body.urgency)) changes.urgency = req.body.urgency;
  if (req.body.caseType && CASE_TYPES[req.body.caseType]) changes.case_type = req.body.caseType;
  if ('nextImportantAt' in req.body) {
    const v = String(req.body.nextImportantAt || '');
    changes.next_important_at = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  }
  if (Object.keys(changes).length === 0) return res.status(400).json({ error: 'Nothing to change.' });

  const sets = Object.keys(changes).map((k) => `${k} = ?`).join(', ');
  const closedAt = changes.status === 'closed' ? `, closed_at = datetime('now')` : changes.status ? `, closed_at = NULL` : '';
  db.prepare(`UPDATE cases SET ${sets}${closedAt}, updated_at = datetime('now') WHERE id = ?`)
    .run(...Object.values(changes), c.id);
  audit(req.user.id, 'case.updated', 'case', c.id, changes);
  const updated = db.prepare('SELECT status, urgency, case_type FROM cases WHERE id = ?').get(c.id);
  res.json({ ok: true, case: { ...updated, statusLabel: MEMBER_STATUS_LABELS[updated.status] } });
});

advisorRouter.post('/cases/:id/escalations/:eid/resolve', requirePermission('cases.status'), (req, res) => {
  const info = db
    .prepare(
      `UPDATE escalations SET resolved_at = datetime('now'), resolved_by = ? WHERE id = ? AND case_id = ? AND resolved_at IS NULL`
    )
    .run(req.user.id, Number(req.params.eid), Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Escalation not found or already resolved.' });
  audit(req.user.id, 'escalation.resolved', 'escalation', req.params.eid, { caseId: req.params.id });
  res.json({ ok: true });
});

// Correct AI (BACKLOG E6): confirm or remove candidate timeline entries.
advisorRouter.patch('/timeline/:id', requirePermission('cases.status'), (req, res) => {
  const entry = db.prepare('SELECT * FROM case_timeline WHERE id = ?').get(Number(req.params.id));
  if (!entry) return res.status(404).json({ error: 'Timeline entry not found.' });
  if (req.body.action === 'confirm') {
    db.prepare('UPDATE case_timeline SET confirmed = 1 WHERE id = ?').run(entry.id);
  } else if (req.body.action === 'remove') {
    db.prepare('DELETE FROM case_timeline WHERE id = ?').run(entry.id);
  } else {
    return res.status(400).json({ error: 'Unknown action.' });
  }
  audit(req.user.id, `timeline.${req.body.action}`, 'case', entry.case_id, { entryId: entry.id });
  res.json({ ok: true });
});

advisorRouter.post('/cases/:id/reanalyse', requirePermission('cases.review'), (req, res) => {
  const c = db.prepare('SELECT id FROM cases WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Case not found.' });
  if (!aiEnabled()) return res.status(400).json({ error: 'AI is not configured or is disabled.' });
  runIntake(c.id, 'reanalyse').catch((err) => console.error(`Reanalyse failed for case ${c.id}: ${err.message}`));
  audit(req.user.id, 'ai.reanalyse_requested', 'case', c.id);
  res.json({ ok: true, message: 'Reanalysis started. Refresh in a few seconds.' });
});
