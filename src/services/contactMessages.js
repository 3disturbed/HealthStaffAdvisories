// Contact messages — the whole of the contact form / Inbox business logic.
// Routes in src/api/contact.js and src/api/messages.js stay thin.
//
// Two kinds of sender share one thread model:
//   • signed in  → user_id set; reads the thread in /inbox.html
//   • anonymous  → user_id NULL; reads it through an emailed magic link
// Anonymous has to keep working: data-rights requests arrive here from
// ex-members whose accounts are already closed.
import { db } from '../db/connection.js';
import { audit } from '../audit/log.js';
import { config } from '../config.js';
import { randomToken, sha256 } from '../auth/passwords.js';
import { sendEmail, notifyUserThread, sendNotificationEmail } from '../notify/mailer.js';
import { assessUrgency } from '../safety/urgency.js';
import { userHas } from '../rbac/permissions.js';

const MAX_NAME = 120;
const MAX_SUBJECT = 200;
const MAX_BODY = 5000;
const TOPICS = ['general', 'pilot', 'data_rights', 'billing', 'other'];
const TOPIC_LABELS = {
  general: 'General question',
  pilot: 'Pilot access',
  data_rights: 'Data export or deletion',
  billing: 'Membership and billing',
  other: 'Something else',
};
const STATUSES = ['new', 'open', 'answered', 'closed'];
const TOKEN_TTL_DAYS = 30;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── helpers (mirroring src/services/faqActions.js) ────────────────────────
function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function enumOr(list, value, fallback) {
  return list.includes(value) ? value : fallback;
}

// req.user is the raw users row, so permissions are resolved through the
// RBAC helper rather than read off the object (see src/auth/middleware.js).
function canReview(actor) {
  return !!actor && userHas(actor, 'contact.review');
}

// ── mappers (snake → camel, mirroring caseCard() in src/api/advisor.js) ───
function threadCard(t) {
  return {
    id: t.id,
    subject: t.subject,
    topic: t.topic,
    topicLabel: TOPIC_LABELS[t.topic] || t.topic,
    status: t.status,
    urgency: t.urgency,
    urgencyReason: t.urgency_reason,
    senderName: t.sender_name,
    anonymous: !t.user_id,
    lastMessageAt: t.last_message_at,
    lastMessageBy: t.last_message_by,
    createdAt: t.created_at,
    unread: !!t.unread,
  };
}

function messageCard(m) {
  return {
    id: m.id,
    authorRole: m.author_role,
    authorName: m.author_name || null,
    body: m.body,
    createdAt: m.created_at,
  };
}

function messagesFor(threadId) {
  return db
    .prepare(
      `SELECT m.*, u.display_name AS author_name
         FROM thread_messages m LEFT JOIN users u ON u.id = m.author_user_id
        WHERE m.thread_id = ? ORDER BY m.id`
    )
    .all(threadId)
    .map(messageCard);
}

function touchThread(threadId, by, status) {
  db.prepare(
    `UPDATE message_threads
        SET last_message_at = datetime('now'), last_message_by = ?,
            status = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(by, status, threadId);
}

// ── magic-link tokens ─────────────────────────────────────────────────────
// Same shape as sessions: the raw token is emailed once, only its hash is
// stored, so reading the database can never reopen someone's thread.
function mintToken(threadId) {
  const token = randomToken();
  const expires = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(
    'INSERT INTO thread_access_tokens (thread_id, token_hash, expires_at) VALUES (?, ?, ?)'
  ).run(threadId, sha256(token), expires);
  return token;
}

function threadForToken(token) {
  const raw = String(token || '');
  if (raw.length < 16) return null;
  const row = db
    .prepare(
      `SELECT t.* FROM thread_access_tokens a JOIN message_threads t ON t.id = a.thread_id
        WHERE a.token_hash = ? AND a.expires_at > datetime('now')`
    )
    .get(sha256(raw));
  if (!row) return null;
  db.prepare(`UPDATE thread_access_tokens SET last_used_at = datetime('now') WHERE token_hash = ?`)
    .run(sha256(raw));
  return row;
}

// ── submit (public) ───────────────────────────────────────────────────────
export function submitContact(user, fields) {
  const name = text(user?.display_name || fields.name, MAX_NAME);
  const email = text(user?.email || fields.email, MAX_NAME).toLowerCase();
  const subject = text(fields.subject, MAX_SUBJECT);
  const body = text(fields.message, MAX_BODY);
  const topic = enumOr(TOPICS, text(fields.topic, 40), 'general');

  if (!name) return { error: 'Please tell us your name.', status: 400 };
  if (!EMAIL_RE.test(email)) return { error: 'Please enter a valid email address.', status: 400 };
  if (!subject) return { error: 'Please give your message a subject.', status: 400 };
  if (body.length < 10) return { error: 'Please tell us a little more so we can help.', status: 400 };

  // Deterministic keyword rules, the same ones case intake uses. Deliberately
  // over-inclusive: a false "urgent" costs an advisor a glance, a false
  // "normal" can cost someone a tribunal window — or worse, on a form a
  // person in crisis can reach without an account.
  const { urgency, triggers } = assessUrgency(`${subject}\n${body}`);

  db.exec('BEGIN');
  try {
    const info = db
      .prepare(
        `INSERT INTO message_threads
           (subject, topic, user_id, sender_name, sender_email, status, urgency, urgency_reason, last_message_by)
         VALUES (?, ?, ?, ?, ?, 'new', ?, ?, 'sender')`
      )
      .run(subject, topic, user?.id ?? null, name, email, urgency, triggers[0]?.reason ?? null);
    const threadId = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO thread_messages (thread_id, author_user_id, author_role, body, read_by_sender_at)
       VALUES (?, ?, 'sender', ?, datetime('now'))`
    ).run(threadId, user?.id ?? null, body);
    db.exec('COMMIT');
    // Field names and ids only — never the message text (docs/AGENTS.md).
    audit(user?.id ?? null, 'contact.submitted', 'message_thread', threadId, { topic, urgency });
    return {
      ok: true,
      threadId,
      urgent: urgency === 'critical' || urgency === 'high',
      signpost: urgency === 'critical',
      signedIn: !!user,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ── read (signed in) ──────────────────────────────────────────────────────
const STAFF_VIEWS = {
  unanswered: `t.status IN ('new', 'open') AND t.last_message_by = 'sender'`,
  urgent: `t.urgency IN ('critical', 'high') AND t.status != 'closed'`,
  open: `t.status != 'closed'`,
  closed: `t.status = 'closed'`,
  all: '1=1',
};

export function listThreads(actor, view = 'unanswered') {
  if (!canReview(actor)) {
    const rows = db
      .prepare(
        `SELECT t.*, EXISTS (
             SELECT 1 FROM thread_messages m WHERE m.thread_id = t.id
              AND m.author_role = 'advisor' AND m.read_by_sender_at IS NULL
           ) AS unread
           FROM message_threads t WHERE t.user_id = ?
          ORDER BY t.last_message_at DESC`
      )
      .all(actor.id);
    return { ok: true, scope: 'own', threads: rows.map(threadCard) };
  }

  const where = STAFF_VIEWS[view] || STAFF_VIEWS.unanswered;
  const rows = db
    .prepare(
      `SELECT t.*, EXISTS (
           SELECT 1 FROM thread_messages m WHERE m.thread_id = t.id
            AND m.author_role = 'sender' AND m.read_by_staff_at IS NULL
         ) AS unread
         FROM message_threads t WHERE ${where}
        ORDER BY
          CASE t.urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
          t.last_message_at DESC`
    )
    .all();
  const counts = {};
  for (const [key, clause] of Object.entries(STAFF_VIEWS)) {
    counts[key] = db.prepare(`SELECT COUNT(*) AS n FROM message_threads t WHERE ${clause}`).get().n;
  }
  return { ok: true, scope: 'staff', view: STAFF_VIEWS[view] ? view : 'unanswered', counts, threads: rows.map(threadCard) };
}

// A thread the actor may not see returns 404, not 403 — never confirm a row
// exists (same rule as src/api/cases.js).
function loadThread(actor, id) {
  const t = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(Number(id));
  if (!t) return null;
  if (canReview(actor)) return t;
  return t.user_id && t.user_id === actor.id ? t : null;
}

export function getThread(actor, id) {
  const t = loadThread(actor, id);
  if (!t) return { error: 'Message not found.', status: 404 };
  const staff = canReview(actor) && t.user_id !== actor.id;
  const column = staff ? 'read_by_staff_at' : 'read_by_sender_at';
  const role = staff ? 'sender' : 'advisor';
  db.prepare(
    `UPDATE thread_messages SET ${column} = datetime('now')
      WHERE thread_id = ? AND author_role = ? AND ${column} IS NULL`
  ).run(t.id, role);
  return { ok: true, thread: { ...threadCard(t), senderEmail: staff ? t.sender_email : undefined }, messages: messagesFor(t.id), canReview: staff };
}

// ── reply ─────────────────────────────────────────────────────────────────
export function replyToThread(actor, id, rawBody) {
  const t = loadThread(actor, id);
  if (!t) return { error: 'Message not found.', status: 404 };
  const body = text(rawBody, MAX_BODY);
  if (body.length < 2) return { error: 'Write a reply before sending.', status: 400 };
  if (t.status === 'closed') return { error: 'This conversation is closed. Send a new message instead.', status: 409 };

  const staff = canReview(actor) && t.user_id !== actor.id;
  const role = staff ? 'advisor' : 'sender';
  db.prepare(
    `INSERT INTO thread_messages (thread_id, author_user_id, author_role, body, read_by_sender_at, read_by_staff_at)
     VALUES (?, ?, ?, ?, ${staff ? 'NULL' : "datetime('now')"}, ${staff ? "datetime('now')" : 'NULL'})`
  ).run(t.id, actor.id, role, body);
  touchThread(t.id, role, staff ? 'answered' : 'open');
  audit(actor.id, staff ? 'contact.replied' : 'contact.sender_replied', 'message_thread', t.id, {});
  if (staff) notifySender(t);
  return { ok: true, messages: messagesFor(t.id) };
}

// ── magic link (anonymous) ────────────────────────────────────────────────
export function getThreadByToken(token) {
  const t = threadForToken(token);
  if (!t) return { error: 'This link has expired or is not valid.', status: 404 };
  db.prepare(
    `UPDATE thread_messages SET read_by_sender_at = datetime('now')
      WHERE thread_id = ? AND author_role = 'advisor' AND read_by_sender_at IS NULL`
  ).run(t.id);
  return { ok: true, thread: threadCard(t), messages: messagesFor(t.id) };
}

export function replyByToken(token, rawBody) {
  const t = threadForToken(token);
  if (!t) return { error: 'This link has expired or is not valid.', status: 404 };
  const body = text(rawBody, MAX_BODY);
  if (body.length < 2) return { error: 'Write a reply before sending.', status: 400 };
  if (t.status === 'closed') return { error: 'This conversation is closed. Send a new message instead.', status: 409 };
  db.prepare(
    `INSERT INTO thread_messages (thread_id, author_role, body, read_by_sender_at)
     VALUES (?, 'sender', ?, datetime('now'))`
  ).run(t.id, body);
  touchThread(t.id, 'sender', 'open');
  audit(null, 'contact.sender_replied', 'message_thread', t.id, {});
  return { ok: true, messages: messagesFor(t.id) };
}

// ── triage ────────────────────────────────────────────────────────────────
export function setThreadStatus(actor, id, fields) {
  const t = db.prepare('SELECT * FROM message_threads WHERE id = ?').get(Number(id));
  if (!t) return { error: 'Message not found.', status: 404 };
  const status = enumOr(STATUSES, text(fields.status, 20), t.status);
  // Urgency can be raised automatically but only lowered by a human, so an
  // explicit advisor choice is taken as given here.
  const urgency = ['critical', 'high', 'normal'].includes(fields.urgency) ? fields.urgency : t.urgency;
  db.prepare(
    `UPDATE message_threads SET status = ?, urgency = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(status, urgency, t.id);
  audit(actor.id, 'contact.status_changed', 'message_thread', t.id, { status, urgency });
  return { ok: true, thread: threadCard({ ...t, status, urgency }) };
}

// ── notifications ─────────────────────────────────────────────────────────
// Nothing about what the advisor actually wrote leaves the site: the signed-in
// nudge carries a sign-in link, the anonymous one carries a magic link. See
// the rule at the top of src/notify/mailer.js.
function notifySender(t) {
  if (t.user_id) {
    notifyUserThread(t.user_id, 'message', 'You have a new message from Kelly', t.id);
    sendNotificationEmail(
      t.user_id,
      'You have a new message',
      `Hello ${t.sender_name},\n\nAn adviser has replied to your message. Sign in to read it:\n${config.baseUrl}/inbox.html\n\nWe never put the contents of a message in an email.`
    );
    return;
  }
  const token = mintToken(t.id);
  sendEmail(
    t.sender_email,
    'You have a reply from Kelly Online',
    `Hello ${t.sender_name},\n\nAn adviser has replied to your message. Open this link to read it and reply (valid for ${TOKEN_TTL_DAYS} days):\n${config.baseUrl}/thread.html?token=${token}\n\nCreate an account at ${config.baseUrl}/register.html to keep your messages in one place.`
  );
}

// Combined unread count behind the Inbox badge — cheap, called on every page.
export function unreadMessageCount(actor) {
  if (canReview(actor)) {
    return db
      .prepare(
        `SELECT COUNT(DISTINCT m.thread_id) AS n FROM thread_messages m
          WHERE m.author_role = 'sender' AND m.read_by_staff_at IS NULL`
      )
      .get().n;
  }
  return db
    .prepare(
      `SELECT COUNT(DISTINCT m.thread_id) AS n FROM thread_messages m
         JOIN message_threads t ON t.id = m.thread_id
        WHERE t.user_id = ? AND m.author_role = 'advisor' AND m.read_by_sender_at IS NULL`
    )
    .get(actor.id).n;
}

export { TOPICS, TOPIC_LABELS, STATUSES };
