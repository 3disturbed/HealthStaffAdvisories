import { Router } from 'express';
import { db } from '../db/connection.js';
import { requireAuth } from '../auth/middleware.js';
import { unreadMessageCount } from '../services/contactMessages.js';

export const notificationsRouter = Router();

// The Inbox merges two feeds: updates (these rows) and message threads. One
// endpoint returns both counts so the badge in public/common.js stays a
// single request on every page load.
notificationsRouter.get('/', requireAuth, (req, res) => {
  const rows = db
    .prepare(`SELECT id, type, title, body, case_id, je_review_id, thread_id, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30`)
    .all(req.user.id);
  const unreadUpdates = rows.filter((n) => !n.read_at).length;
  const unreadMessages = unreadMessageCount(req.user);
  res.json({
    notifications: rows,
    unreadUpdates,
    unreadMessages,
    unread: unreadUpdates + unreadMessages,
  });
});

notificationsRouter.post('/read', requireAuth, (req, res) => {
  db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`).run(req.user.id);
  res.json({ ok: true });
});
