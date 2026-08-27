import { Router } from 'express';
import { requireAnyPermission } from '../auth/middleware.js';
import { getSetting } from '../db/connection.js';
import { aiConfigured } from '../ai/intake.js';
import { runAssistantTurn, confirmAction, cancelAction, resetConversation, assistantState, expireStalePending } from '../ai/assistant.js';

export const assistantRouter = Router();

// Anyone holding one of the toolbox permissions may use the assistant;
// each tool call is still gated on its own permission server-side.
assistantRouter.use(requireAnyPermission('users.manage', 'cases.review', 'knowledge.manage'));

function killSwitchOn() {
  return getSetting('ai_disabled', '0') === '1';
}

assistantRouter.get('/', (req, res) => {
  expireStalePending(req.user.id);
  res.json({
    configured: aiConfigured(),
    enabled: aiConfigured() && !killSwitchOn(),
    ...assistantState(req.user.id),
  });
});

assistantRouter.post('/message', async (req, res, next) => {
  const content = String(req.body.content || '').trim();
  if (!content || content.length > 4000) return res.status(400).json({ error: 'Message must be between 1 and 4000 characters.' });
  if (!aiConfigured()) return res.status(400).json({ error: 'No OpenAI API key is configured. Add one in Admin → AI settings.' });
  if (killSwitchOn()) return res.status(400).json({ error: 'AI generation is disabled by the kill switch. Re-enable it in Admin → AI settings.' });
  try {
    const state = await runAssistantTurn(req.user, content);
    res.json(state);
  } catch (err) {
    next(err);
  }
});

// Confirm/cancel are human-approved administrative actions — they work even
// with the kill switch on (only the optional follow-up chat needs the model).
assistantRouter.post('/actions/:id/confirm', async (req, res, next) => {
  try {
    const result = await confirmAction(req.user, req.params.id);
    if (result.error && !result.state) return res.status(result.status || 400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

assistantRouter.post('/actions/:id/cancel', (req, res) => {
  const result = cancelAction(req.user, req.params.id);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.json(result);
});

assistantRouter.post('/reset', (req, res) => {
  res.json(resetConversation(req.user));
});
