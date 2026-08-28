import { db } from '../db/connection.js';
import { config } from '../config.js';

// Email adapter. "mailbox" mode captures outbound mail in the local dev
// mailbox (visible in the Admin area) instead of sending. An SMTP transport
// can be added here later without touching callers.
// Never put sensitive case details in subject lines — callers must pass
// neutral subjects and keep specifics behind a sign-in link.
export function sendEmail(to, subject, body) {
  db.prepare('INSERT INTO outbound_emails (to_email, subject, body) VALUES (?, ?, ?)').run(to, subject, body);
  if (config.env !== 'production') {
    console.log(`[mail → ${to}] ${subject}`);
  }
}

export function notifyUser(userId, type, title, body = '', caseId = null) {
  db.prepare(
    'INSERT INTO notifications (user_id, type, title, body, case_id) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, type, title, body, caseId);
}

// Notification that deep-links to a band review instead of a case.
export function notifyUserJe(userId, type, title, jeReviewId, body = '') {
  db.prepare(
    'INSERT INTO notifications (user_id, type, title, body, je_review_id) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, type, title, body, jeReviewId);
}

// Notification email that respects the user's email preference. Account
// emails (verification, reset) must NOT go through this — always delivered.
export function sendNotificationEmail(userId, subject, body) {
  const user = db.prepare('SELECT email, status, email_notifications FROM users WHERE id = ?').get(userId);
  if (!user || user.status !== 'active' || !user.email_notifications) return;
  sendEmail(user.email, subject, body);
}
