import { db } from '../db/connection.js';
import { notifyUser, sendNotificationEmail } from '../notify/mailer.js';
import { audit } from '../audit/log.js';
import { MEMBER_STATUS_LABELS } from '../api/cases.js';

// Advisor reply to a member, shared by the advisor API route and the
// assistant's message_member tool. The actor is always the human advisor
// (for assistant sends, the human who approved the draft) and is recorded
// as the approver of the member-visible content.
export function sendAdvisorReply(actor, caseId, { kind, content }, opts = {}) {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(Number(caseId));
  if (!c) return { error: 'Case not found.', status: 404 };
  const k = ['message', 'question', 'action_plan'].includes(kind) ? kind : 'message';
  const text = String(content || '').trim();
  if (!text) return { error: 'Reply is empty.', status: 400 };

  db.prepare(
    `INSERT INTO case_messages (case_id, author_user_id, visibility, kind, content, approved_by) VALUES (?, ?, 'member', ?, ?, ?)`
  ).run(c.id, actor.id, k, text, actor.id);

  const newStatus = k === 'question' ? 'need_member_info'
    : k === 'action_plan' ? 'action_plan_ready'
    : c.status === 'waiting_for_kelly' ? 'kelly_reviewing' : c.status;
  db.prepare(`UPDATE cases SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(newStatus, c.id);

  notifyUser(c.member_id, 'kelly_replied', k === 'action_plan' ? 'Your action plan is ready' : 'Kelly has replied to your case', '', c.id);
  // Neutral subject/body — no case details in email (MVP §10).
  sendNotificationEmail(c.member_id, 'Kelly Online: there is an update on your case', 'Sign in to Kelly Online to read the update on your case.');

  const meta = opts.via ? { via: opts.via, actionId: opts.actionId } : {};
  audit(actor.id, `case.advisor_${k}`, 'case', c.id, meta);
  return { ok: true, status: newStatus, statusLabel: MEMBER_STATUS_LABELS[newStatus] };
}
