import { Router } from 'express';
import { requirePermission, rateLimit } from '../auth/middleware.js';
import { getSetting, setSetting } from '../db/connection.js';
import {
  listFaq,
  getFaqQuestion,
  listFaqManage,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
  createQuestion,
  updateQuestion,
  deleteQuestion,
  setQuestionStatus,
  reorderQuestions,
  recordFaqFeedback,
  recordFaqView,
  rebuildFaqIndex,
} from '../services/faqActions.js';
import { searchFaqAssisted } from '../ai/faqSearch.js';

export const faqRouter = Router();

// je.js flavour: spreads extra keys so a 409 can carry questionCount to the UI.
function respond(res, result) {
  if (result?.error) {
    const { error, status = 400, ...rest } = result;
    return res.status(status).json({ error, ...rest });
  }
  res.json(result);
}

// The same URL returns a different body per session (anonymous / member /
// faq.manage), and the app runs behind a proxy. Without this a shared cache
// could hand a member-scoped or draft payload to an anonymous visitor.
function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
}

// ── public reads ──────────────────────────────────────────────────────────
// DELIBERATELY unauthenticated — this is the public help page, and the first
// read API in the app with no permission middleware. That is not an oversight:
// faqScope() in src/services/faqActions.js is the access control, and every
// read path below builds its WHERE from it. Do not "fix" this by adding
// requireAuth; do check that any new read path goes through faqScope().
faqRouter.get('/', (req, res) => {
  noStore(res);
  respond(res, listFaq(req.user));
});

faqRouter.get('/questions/:slug', (req, res) => {
  noStore(res);
  respond(res, getFaqQuestion(req.user, req.params.slug));
});

// ── search ────────────────────────────────────────────────────────────────
// POST, not GET, for two reasons: csrfGuard then requires the
// x-requested-with header (no CORS is configured, so a third-party page cannot
// set it cross-origin), and the member's free text stays out of URLs and proxy
// access logs — that text is exactly what docs/AGENTS.md says never to log.
const AI_BUDGET_WINDOW_MS = 10 * 60 * 1000;
const aiBuckets = new Map();

// Per-IP burst budget. Over budget downgrades SILENTLY to keyword search —
// never a 429, because a public help page must keep working.
function claimIpAiBudget(req) {
  const max = req.user ? 12 : 6;
  const key = req.ip;
  const now = Date.now();
  let bucket = aiBuckets.get(key);
  if (!bucket || now > bucket.reset) {
    bucket = { count: 0, reset: now + AI_BUDGET_WINDOW_MS };
    aiBuckets.set(key, bucket);
  }
  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}

// Global daily cap in settings so it survives restarts and an admin can tune
// it — or set it to 0 as a FAQ-specific off switch, independent of the global
// ai_disabled kill switch.
function claimDailyAiBudget() {
  const max = Number(getSetting('faq_ai_daily_max', '500'));
  if (!Number.isFinite(max) || max <= 0) return false;
  const today = new Date().toISOString().slice(0, 10);
  let state = { day: today, count: 0 };
  try {
    const parsed = JSON.parse(getSetting('faq_ai_budget', '') || '{}');
    if (parsed && parsed.day === today) state = { day: today, count: Number(parsed.count) || 0 };
  } catch {
    // A corrupt counter must not disable search; start the day over.
  }
  if (state.count >= max) return false;
  setSetting('faq_ai_budget', JSON.stringify({ day: today, count: state.count + 1 }));
  return true;
}

faqRouter.post(
  '/search',
  rateLimit({ windowMs: 60 * 1000, max: 20, keyPrefix: 'faq-search' }),
  async (req, res, next) => {
    noStore(res);
    const q = String(req.body?.q || '').trim().slice(0, 300);
    if (q.length < 3) return res.json({ ok: true, mode: 'fts', aiUsed: false, results: [] });
    try {
      const allowAi = claimIpAiBudget(req) && claimDailyAiBudget();
      respond(res, await searchFaqAssisted(q, req.user, { allowAi }));
    } catch (err) {
      next(err);
    }
  }
);

// ── counters ──────────────────────────────────────────────────────────────
faqRouter.post(
  '/questions/:id/feedback',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: 'faq-feedback' }),
  (req, res) => {
    noStore(res);
    respond(res, recordFaqFeedback(req.user, req.params.id, req.body?.helpful === true));
  }
);

faqRouter.post(
  '/questions/:id/viewed',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 60, keyPrefix: 'faq-view' }),
  (req, res) => {
    noStore(res);
    respond(res, recordFaqView(req.user, req.params.id));
  }
);

// ── management (faq.manage) ───────────────────────────────────────────────
faqRouter.get('/manage', requirePermission('faq.manage'), (req, res) => {
  noStore(res);
  respond(res, listFaqManage());
});

faqRouter.post('/categories', requirePermission('faq.manage'), (req, res) => {
  respond(res, createCategory(req.user, req.body || {}));
});

faqRouter.patch('/categories/:id', requirePermission('faq.manage'), (req, res) => {
  respond(res, updateCategory(req.user, req.params.id, req.body || {}));
});

faqRouter.post('/categories/reorder', requirePermission('faq.manage'), (req, res) => {
  respond(res, reorderCategories(req.user, req.body?.ids));
});

faqRouter.post('/categories/:id/delete', requirePermission('faq.manage'), (req, res) => {
  respond(res, deleteCategory(req.user, req.params.id, { reassignTo: req.body?.reassignTo }));
});

faqRouter.post('/questions', requirePermission('faq.manage'), (req, res) => {
  respond(res, createQuestion(req.user, req.body || {}));
});

faqRouter.patch('/questions/:id', requirePermission('faq.manage'), (req, res) => {
  respond(res, updateQuestion(req.user, req.params.id, req.body || {}));
});

faqRouter.post('/questions/reorder', requirePermission('faq.manage'), (req, res) => {
  respond(res, reorderQuestions(req.user, req.body?.categoryId, req.body?.ids));
});

faqRouter.post('/questions/:id/status', requirePermission('faq.manage'), (req, res) => {
  respond(res, setQuestionStatus(req.user, req.params.id, req.body?.status));
});

faqRouter.post('/questions/:id/delete', requirePermission('faq.manage'), (req, res) => {
  respond(res, deleteQuestion(req.user, req.params.id));
});

faqRouter.post('/reindex', requirePermission('faq.manage'), (req, res) => {
  respond(res, rebuildFaqIndex(req.user));
});
