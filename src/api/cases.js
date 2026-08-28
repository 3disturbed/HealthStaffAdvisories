import { Router } from 'express';
import { db } from '../db/connection.js';
import { requirePermission } from '../auth/middleware.js';
import { assessUrgency, maxUrgency } from '../safety/urgency.js';
import { assessJeSignals } from '../safety/jeUrgency.js';
import { audit } from '../audit/log.js';
import { notifyUser, sendNotificationEmail } from '../notify/mailer.js';
import { userHas } from '../rbac/permissions.js';
import { aiEnabled } from '../ai/intake.js';
import { enqueueOrRun, caseAiQueueState } from '../services/aiQueue.js';

export const casesRouter = Router();

export const CASE_TYPES = {
  disciplinary: 'Disciplinary / investigation',
  grievance: 'Grievance / bullying / harassment',
  sickness: 'Sickness / absence / adjustments',
  pay: 'Pay / banding / hours / leave',
  flexible: 'Flexible working / family leave',
  speaking_up: 'Speaking up / patient safety',
  contract: 'Contract / employment status',
  dismissal: 'Dismissal / redundancy',
  other: 'Something else',
};

export const MEMBER_STATUS_LABELS = {
  gathering: 'Gathering information',
  waiting_for_kelly: 'Waiting for Kelly',
  kelly_reviewing: 'Kelly reviewing',
  need_member_info: 'Need information from you',
  action_plan_ready: 'Action plan ready',
  ongoing: 'Ongoing support',
  closed: 'Closed',
};

// A member may only load their own case; an advisor may load any case.
export function loadCaseAuthorised(req, caseId) {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(Number(caseId));
  if (!c) return { error: 404 };
  const isOwner = c.member_id === req.user.id;
  const isAdvisor = userHas(req.user, 'cases.review');
  if (!isOwner && !isAdvisor) return { error: 404 }; // do not reveal existence
  return { c, isOwner, isAdvisor };
}

// Resolve case_messages.meta ({"documentIds":[...]}) into attachment info.
// Clients never see raw meta; ids are matched against the case's documents.
export function attachMessageDocuments(messages, caseId) {
  const docs = db.prepare('SELECT id, original_filename FROM documents WHERE case_id = ?').all(caseId);
  const byId = new Map(docs.map((d) => [d.id, d]));
  return messages.map(({ meta, ...m }) => {
    let attachments = [];
    if (meta) {
      try {
        attachments = (JSON.parse(meta).documentIds || [])
          .map((id) => byId.get(id))
          .filter(Boolean)
          .map((d) => ({ id: d.id, filename: d.original_filename }));
      } catch { /* malformed meta renders as no attachments */ }
    }
    return { ...m, attachments };
  });
}

function advisorUserIds() {
  return db
    .prepare(`SELECT DISTINCT u.id FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = 'advisor' AND u.status = 'active'`)
    .all()
    .map((r) => r.id);
}

casesRouter.post('/', requirePermission('cases.own'), (req, res) => {
  const whatHappened = String(req.body.whatHappened || '').trim();
  if (whatHappened.length < 10) {
    return res.status(400).json({ error: 'Please tell us what happened in a sentence or two.' });
  }
  const caseType = CASE_TYPES[req.body.caseType] ? req.body.caseType : 'other';
  const fields = {
    employer: String(req.body.employer || '').trim().slice(0, 120),
    staffGroup: String(req.body.staffGroup || '').trim().slice(0, 120),
    formalStage: String(req.body.formalStage || '').trim().slice(0, 400),
    meetingOrDeadline: String(req.body.meetingOrDeadline || '').trim().slice(0, 400),
    desiredOutcome: String(req.body.desiredOutcome || '').trim().slice(0, 400),
  };

  const base = assessUrgency(whatHappened, fields);
  const jeSignals = assessJeSignals(whatHappened, fields);
  const urgency = maxUrgency(base.urgency, jeSignals.urgency);
  const triggers = [...base.triggers, ...jeSignals.triggers];
  const title = whatHappened.split('\n')[0].slice(0, 80);

  const info = db
    .prepare(
      `INSERT INTO cases (member_id, title, case_type, status, urgency, urgency_reason, what_happened,
        employer, staff_group, formal_stage, desired_outcome, meeting_or_deadline)
       VALUES (?, ?, ?, 'gathering', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.id, title, caseType, urgency,
      triggers.map((t) => t.reason).join('; ') || null,
      whatHappened, fields.employer, fields.staffGroup, fields.formalStage,
      fields.desiredOutcome, fields.meetingOrDeadline
    );
  const caseId = info.lastInsertRowid;

  db.prepare(`INSERT INTO case_messages (case_id, author_user_id, visibility, kind, content) VALUES (?, ?, 'member', 'message', ?)`)
    .run(caseId, req.user.id, whatHappened);

  for (const t of triggers) {
    db.prepare(`INSERT INTO escalations (case_id, rule_id, reason, severity, detected_by) VALUES (?, ?, ?, ?, 'rules')`)
      .run(caseId, t.id, t.reason, t.severity);
  }
  if (triggers.length > 0) {
    for (const advisorId of advisorUserIds()) {
      notifyUser(advisorId, 'urgent_case', `Urgent case #${caseId}`, 'A new case has triggered urgency rules.', caseId);
      sendNotificationEmail(advisorId, 'Kelly Online: a case needs urgent attention', 'An urgent case is waiting in your queue. Sign in to view it.');
    }
  }

  audit(req.user.id, 'case.created', 'case', caseId, { urgency, triggers: triggers.map((t) => t.id) });

  // AI intake runs in the background through the member's allowance: it
  // either starts now or waits its turn — never rejected (membership rule).
  const gate = enqueueOrRun({ caseId, userId: req.user.id, task: 'intake' });

  res.json({
    ok: true, caseId, urgency, urgent: triggers.length > 0,
    aiQueued: !!(gate.ran || gate.queued),
    aiExpectedAt: gate.expectedAt || null,
    jeInterest: jeSignals.flags.length > 0,
  });
});

casesRouter.get('/', requirePermission('cases.own'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, title, case_type, status, urgency, next_important_at, created_at, updated_at
       FROM cases WHERE member_id = ? ORDER BY updated_at DESC`
    )
    .all(req.user.id);
  res.json({
    cases: rows.map((c) => ({
      ...c,
      statusLabel: MEMBER_STATUS_LABELS[c.status] || c.status,
      typeLabel: CASE_TYPES[c.case_type] || c.case_type,
    })),
  });
});

casesRouter.get('/:id', requirePermission('cases.own'), (req, res) => {
  const { c, error, isOwner } = loadCaseAuthorised(req, req.params.id);
  if (error) return res.status(error).json({ error: 'Case not found.' });
  if (!isOwner) return res.status(404).json({ error: 'Case not found.' }); // member endpoint: owners only

  const messages = attachMessageDocuments(
    db
      .prepare(
        `SELECT m.id, m.author_user_id, m.kind, m.content, m.meta, m.created_at, u.display_name AS author_name
         FROM case_messages m LEFT JOIN users u ON u.id = m.author_user_id
         WHERE m.case_id = ? AND m.visibility = 'member' ORDER BY m.created_at, m.id`
      )
      .all(c.id),
    c.id
  );
  const timeline = db
    .prepare(`SELECT id, event_date, description, source, confidence, confirmed FROM case_timeline WHERE case_id = ? ORDER BY event_date IS NULL, event_date`)
    .all(c.id);
  const documents = db
    .prepare(`SELECT id, original_filename, media_type, size_bytes, status, created_at FROM documents WHERE case_id = ? AND owner_user_id = ?`)
    .all(c.id, req.user.id);
  const escalations = db
    .prepare(`SELECT reason, severity, created_at FROM escalations WHERE case_id = ? AND resolved_at IS NULL`)
    .all(c.id);
  const latestIntake = db
    .prepare(`SELECT output_json, created_at FROM ai_outputs WHERE case_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 1`)
    .get(c.id);

  let memberIntake = null;
  if (latestIntake) {
    const parsed = JSON.parse(latestIntake.output_json);
    // Members see the member-facing portions only — never the advisor brief.
    memberIntake = {
      explanation: parsed.memberExplanation,
      missingQuestions: parsed.missingQuestions,
      importantDates: parsed.importantDates,
      sources: parsed.sources,
      uncertainty: parsed.uncertainty,
      generatedAt: latestIntake.created_at,
    };
  }

  res.json({
    case: {
      id: c.id, title: c.title, caseType: c.case_type,
      typeLabel: CASE_TYPES[c.case_type] || c.case_type,
      status: c.status, statusLabel: MEMBER_STATUS_LABELS[c.status] || c.status,
      urgency: c.urgency, urgencyReason: c.urgency_reason,
      desiredOutcome: c.desired_outcome, employer: c.employer,
      nextImportantAt: c.next_important_at, createdAt: c.created_at,
    },
    messages, timeline, documents, escalations, intake: memberIntake,
    aiQueue: caseAiQueueState(c.id),
  });
});

casesRouter.post('/:id/messages', requirePermission('cases.own'), (req, res) => {
  const { c, error, isOwner } = loadCaseAuthorised(req, req.params.id);
  if (error || !isOwner) return res.status(404).json({ error: 'Case not found.' });
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Message is empty.' });
  if (c.status === 'closed') return res.status(400).json({ error: 'This case is closed. Ask Kelly to reopen it.' });

  db.prepare(`INSERT INTO case_messages (case_id, author_user_id, visibility, kind, content) VALUES (?, ?, 'member', 'message', ?)`)
    .run(c.id, req.user.id, content);
  const newStatus = c.status === 'need_member_info' ? 'waiting_for_kelly' : c.status;
  db.prepare(`UPDATE cases SET updated_at = datetime('now'), status = ? WHERE id = ?`).run(newStatus, c.id);
  audit(req.user.id, 'case.member_message', 'case', c.id);
  res.json({ ok: true });
});

// Evidence flow: statement + previously uploaded documents, as one clearly
// labelled entry in the case conversation.
casesRouter.post('/:id/evidence', requirePermission('cases.own'), (req, res) => {
  const { c, error, isOwner } = loadCaseAuthorised(req, req.params.id);
  if (error || !isOwner) return res.status(404).json({ error: 'Case not found.' });
  if (c.status === 'closed') return res.status(400).json({ error: 'This case is closed. Ask Kelly to reopen it.' });

  const statement = String(req.body.statement || '').trim();
  if (statement.length < 10 || statement.length > 4000) {
    return res.status(400).json({ error: 'Please describe what this evidence shows (a sentence or two).' });
  }
  const ids = Array.isArray(req.body.documentIds) ? req.body.documentIds.map(Number) : [];
  if (ids.length < 1 || ids.length > 10 || ids.some((id) => !Number.isInteger(id))) {
    return res.status(400).json({ error: 'Attach between 1 and 10 uploaded documents.' });
  }
  for (const id of ids) {
    const owned = db
      .prepare('SELECT id FROM documents WHERE id = ? AND case_id = ? AND owner_user_id = ?')
      .get(id, c.id, req.user.id);
    if (!owned) return res.status(400).json({ error: 'One of the attached documents does not belong to this case.' });
  }

  db.prepare(
    `INSERT INTO case_messages (case_id, author_user_id, visibility, kind, content, meta) VALUES (?, ?, 'member', 'evidence', ?, ?)`
  ).run(c.id, req.user.id, statement, JSON.stringify({ documentIds: ids }));
  const newStatus = c.status === 'need_member_info' ? 'waiting_for_kelly' : c.status;
  db.prepare(`UPDATE cases SET updated_at = datetime('now'), status = ? WHERE id = ?`).run(newStatus, c.id);
  audit(req.user.id, 'case.evidence_submitted', 'case', c.id, { documentIds: ids });
  res.json({ ok: true, caseId: c.id });
});

casesRouter.post('/:id/request-review', requirePermission('cases.own'), (req, res) => {
  const { c, error, isOwner } = loadCaseAuthorised(req, req.params.id);
  if (error || !isOwner) return res.status(404).json({ error: 'Case not found.' });
  if (c.status === 'closed') return res.status(400).json({ error: 'This case is closed.' });

  db.prepare(`UPDATE cases SET status = 'waiting_for_kelly', updated_at = datetime('now') WHERE id = ?`).run(c.id);
  for (const advisorId of advisorUserIds()) {
    notifyUser(advisorId, 'review_requested', `Review requested on case #${c.id}`, '', c.id);
  }
  audit(req.user.id, 'case.review_requested', 'case', c.id);
  res.json({ ok: true, statusLabel: MEMBER_STATUS_LABELS.waiting_for_kelly });
});
