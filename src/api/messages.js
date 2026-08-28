import { Router } from 'express';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import {
  listThreads,
  getThread,
  replyToThread,
  setThreadStatus,
} from '../services/contactMessages.js';

export const messagesRouter = Router();

messagesRouter.use(requireAuth);

function respond(res, result) {
  if (result?.error) {
    const { error, status = 400, ...rest } = result;
    return res.status(status).json({ error, ...rest });
  }
  res.json(result);
}

// The same URL returns a different body per session (own threads vs the staff
// queue), and the app runs behind a proxy.
messagesRouter.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
  next();
});

messagesRouter.get('/', (req, res) => {
  respond(res, listThreads(req.user, String(req.query.view || 'unanswered')));
});

messagesRouter.get('/:id', (req, res) => {
  respond(res, getThread(req.user, req.params.id));
});

messagesRouter.post('/:id/reply', (req, res) => {
  respond(res, replyToThread(req.user, req.params.id, req.body?.body));
});

messagesRouter.post('/:id/status', requirePermission('contact.review'), (req, res) => {
  respond(res, setThreadStatus(req.user, req.params.id, req.body || {}));
});
