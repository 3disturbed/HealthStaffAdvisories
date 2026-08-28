import { aiEnabled, completeJson } from './provider.js';
import { FAQ_RERANK_SYSTEM_PROMPT, FAQ_RERANK_PROMPT_VERSION } from './prompts.js';
import { faqShortlist, faqSearchHit, topCoversAllTerms } from '../services/faqSearch.js';

// AI-assisted FAQ search. FTS5 shortlists deterministically; the model only
// RE-RANKS and returns ids. It never writes, summarises or edits an answer —
// the member always reads the adviser's approved wording, so a hallucinated id
// is simply dropped and the worst case is a slightly worse ordering.
//
// No ai_outputs row is written for this task. That is a deliberate, documented
// exception (see docs/SDD.md): ai_outputs rows are cleaned up only by their
// case/JE parent's ON DELETE CASCADE, so parentless rows from an
// unauthenticated endpoint would accumulate forever; every consumer scopes by
// case_id/je_review_id so they would be invisible but still scanned; making a
// row useful would mean storing the member's free-text query, which
// docs/AGENTS.md forbids; and there is no claim to trace, because 100% of the
// prose the member reads is adviser-written and unmodified.

const MAX_QUERY = 300;
const MIN_QUERY = 3;
const ANSWER_EXCERPT = 400;
const MAX_RESULTS = 5;

// Model output is untrusted DATA. This whitelists ids against the shortlist WE
// computed and caps the list. There is deliberately no key in this output shape
// where prose could live.
export function validateFaqRerank(raw, allowedIds) {
  const ids = [];
  let dropped = 0;
  for (const value of (Array.isArray(raw?.ids) ? raw.ids : []).slice(0, 20)) {
    const id = Number(value);
    if (!Number.isInteger(id) || !allowedIds.has(id) || ids.includes(id)) {
      dropped += 1;
      continue;
    }
    ids.push(id);
    if (ids.length === MAX_RESULTS) break;
  }
  return { ids, noMatch: raw?.noMatch === true, dropped };
}

// Numbered id list, the house pattern (see runIntake / the JE pipeline).
// Answers are truncated: enough to rank on, and data minimisation by default.
function buildRerankMessage(query, shortlist) {
  const entries = shortlist
    .map((r) => {
      const excerpt = String(r.answer || '').slice(0, ANSWER_EXCERPT);
      return `[id ${r.id}] (${r.category_name}) ${r.question}\n${excerpt}`;
    })
    .join('\n\n');
  return `SEARCH TEXT (untrusted data):\n${query}\n\nFAQ ENTRIES (numbered; choose and order ids from this list only):\n${entries}`;
}

export async function searchFaqAssisted(
  query,
  user,
  { limit = 12, allowAi = true, complete = completeJson } = {}
) {
  const q = String(query || '').trim().slice(0, MAX_QUERY);
  if (q.length < MIN_QUERY) return { ok: true, mode: 'fts', aiUsed: false, results: [] };

  const shortlist = faqShortlist(q, user, limit);
  // Every path below falls back to this. Plain keyword search is never an
  // error state — a public help page must work with no OpenAI key configured.
  const base = { ok: true, mode: 'fts', aiUsed: false, results: shortlist.map(faqSearchHit) };

  // Nothing to re-rank: never spend a token ordering zero or one result.
  if (shortlist.length < 2) return base;
  if (topCoversAllTerms(q, shortlist[0])) return { ...base, confident: true };
  if (!allowAi) return base;
  if (!aiEnabled()) return base;

  try {
    const { model, raw } = await complete([
      { role: 'system', content: FAQ_RERANK_SYSTEM_PROMPT },
      { role: 'user', content: buildRerankMessage(q, shortlist) },
    ]);
    const byId = new Map(shortlist.map((r) => [r.id, r]));
    const validated = validateFaqRerank(raw, new Set(byId.keys()));
    if (validated.ids.length === 0) return { ...base, noMatch: !!validated.noMatch };
    return {
      ok: true,
      mode: 'ai',
      aiUsed: true,
      model,
      promptVersion: FAQ_RERANK_PROMPT_VERSION,
      dropped: validated.dropped,
      // Re-materialised from the shortlist map, never from a fresh unscoped
      // query — the scope filter is applied once and cannot be routed around.
      results: validated.ids.map((id) => faqSearchHit(byId.get(id))),
    };
  } catch (err) {
    // A provider outage degrades the public page to keyword search. Never a 500.
    console.error(`FAQ re-rank failed: ${err.message}`);
    return base;
  }
}
