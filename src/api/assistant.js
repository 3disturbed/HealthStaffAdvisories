import { Router } from 'express';
import { requireAnyPermission } from '../auth/middleware.js';
import { getSetting } from '../db/connection.js';
import { aiConfigured } from '../ai/intake.js';
import {
  runAssistantTurn, confirmAction, cancelAction, assistantState, expireStalePending,
  listThreads, createThread, renameThread, deleteThread,
} from '../ai/assistant.js';

export const assistantRouter = Router();

// Anyone holding one of the toolbox permissions may use the assistant;
// each tool call is still gated on its own permission server-side.
assistantRouter.use(requireAnyPermission('users.manage', 'cases.review', 'knowledge.manage'));

function killSwitchOn() {
  return getSetting('ai_disabled', '0') === '1';
}

function respond(res, result) {
  if (result?.error) return res.status(result.status || 400).json({ error: result.error });
  return res.json(result);
}

assistantRouter.get('/', (req, res) => {
  expireStalePending(req.user.id);
  res.json({
    configured: aiConfigured(),
    enabled: aiConfigured() && !killSwitchOn(),
    threads: listThreads(req.user.id),
  });
});

assistantRouter.post('/threads', (req, res) => {
  respond(res, createThread(req.user, req.body.title));
});

assistantRouter.get('/threads/:id', (req, res) => {
  const threads = listThreads(req.user.id);
  if (!threads.some((t) => t.id === Number(req.params.id))) return res.status(404).json({ error: 'Conversation not found.' });
  expireStalePending(req.user.id);
  res.json(assistantState(req.user.id, Number(req.params.id)));
});

assistantRouter.post('/threads/:id/rename', (req, res) => {
  respond(res, renameThread(req.user, req.params.id, req.body.title));
});

assistantRouter.post('/threads/:id/delete', (req, res) => {
  respond(res, deleteThread(req.user, req.params.id));
});

assistantRouter.post('/threads/:id/message', async (req, res, next) => {
  const content = String(req.body.content || '').trim();
  if (!content || content.length > 4000) return res.status(400).json({ error: 'Message must be between 1 and 4000 characters.' });
  if (!aiConfigured()) return res.status(400).json({ error: 'No OpenAI API key is configured. Add one in Admin → AI settings.' });
  if (killSwitchOn()) return res.status(400).json({ error: 'AI generation is disabled by the kill switch. Re-enable it in Admin → AI settings.' });
  try {
    respond(res, await runAssistantTurn(req.user, Number(req.params.id), content));
  } catch (err) {
    next(err);
  }
});

// Confirm/cancel are human-approved administrative actions — they work even
// with the kill switch on (only the optional follow-up chat needs the model).
// The body may carry corrections for fields the tool declares editable
// (e.g. the message text of a drafted member message).
assistantRouter.post('/actions/:id/confirm', async (req, res, next) => {
  try {
    const result = await confirmAction(req.user, req.params.id, { edits: { content: req.body?.content } });
    if (result.error && !result.state) return res.status(result.status || 400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

assistantRouter.post('/actions/:id/cancel', (req, res) => {
  respond(res, cancelAction(req.user, req.params.id));
});
