import { Router } from 'express';
import { db } from '../db/connection.js';
import { requireAuth } from '../auth/middleware.js';

export const notificationsRouter = Router();

notificationsRouter.get('/', requireAuth, (req, res) => {
  const rows = db
    .prepare(`SELECT id, type, title, body, case_id, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30`)
    .all(req.user.id);
  res.json({ notifications: rows, unread: rows.filter((n) => !n.read_at).length });
});

notificationsRouter.post('/read', requireAuth, (req, res) => {
  db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`).run(req.user.id);
  res.json({ ok: true });
});
