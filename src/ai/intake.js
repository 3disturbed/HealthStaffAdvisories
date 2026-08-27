import OpenAI from 'openai';
import { db, getSetting } from '../db/connection.js';
import { retrieveChunks } from './retrieve.js';
import { INTAKE_SYSTEM_PROMPT, INTAKE_PROMPT_VERSION } from './prompts.js';
import { audit } from '../audit/log.js';
import { config } from '../config.js';

export function aiConfigured() {
  return !!getSetting('openai_api_key');
}

export function aiEnabled() {
  return getSetting('ai_disabled', '0') !== '1' && aiConfigured();
}

const VALID_URGENCY = ['critical', 'high', 'normal', 'self_service'];
const VALID_TYPES = ['disciplinary', 'grievance', 'sickness', 'pay', 'flexible', 'speaking_up', 'contract', 'dismissal', 'other'];

// Validate + sanitise model output (model output is data, not authority).
// Citations may only reference chunk ids we actually provided.
function validateIntake(raw, providedChunkIds) {
  const out = {};
  out.summary = String(raw.summary || '').slice(0, 2000);
  out.caseTypeSuggestion = VALID_TYPES.includes(raw.caseTypeSuggestion) ? raw.caseTypeSuggestion : 'other';
  out.memberExplanation = String(raw.memberExplanation || '').slice(0, 8000);
  out.missingQuestions = (Array.isArray(raw.missingQuestions) ? raw.missingQuestions : [])
    .slice(0, 5).map((q) => String(q).slice(0, 300));
  out.importantDates = (Array.isArray(raw.importantDates) ? raw.importantDates : [])
    .slice(0, 10)
    .map((d) => ({
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(d?.date)) ? d.date : '',
      event: String(d?.event || '').slice(0, 300),
      needsVerification: true, // always — deadline safety (SDD §11)
    }))
    .filter((d) => d.event);
  out.timeline = (Array.isArray(raw.timeline) ? raw.timeline : [])
    .slice(0, 30)
    .map((t) => ({
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(t?.date)) ? t.date : '',
      description: String(t?.description || '').slice(0, 400),
      source: t?.source === 'document' ? 'document' : 'member',
    }))
    .filter((t) => t.description);
  out.urgencySuggestion = VALID_URGENCY.includes(raw.urgencySuggestion) ? raw.urgencySuggestion : 'normal';
  out.uncertainty = String(raw.uncertainty || '').slice(0, 1000);
  const brief = raw.advisorBrief || {};
  out.advisorBrief = {
    headline: String(brief.headline || '').slice(0, 300),
    memberWants: String(brief.memberWants || '').slice(0, 500),
    keyIssues: (Array.isArray(brief.keyIssues) ? brief.keyIssues : []).slice(0, 8).map((s) => String(s).slice(0, 400)),
    risks: (Array.isArray(brief.risks) ? brief.risks : []).slice(0, 8).map((s) => String(s).slice(0, 400)),
    suggestedNextSteps: (Array.isArray(brief.suggestedNextSteps) ? brief.suggestedNextSteps : []).slice(0, 8).map((s) => String(s).slice(0, 400)),
  };
  out.citations = (Array.isArray(raw.citations) ? raw.citations : [])
    .filter((c) => providedChunkIds.has(Number(c?.chunkId)))
    .slice(0, 20)
    .map((c) => ({ chunkId: Number(c.chunkId), claim: String(c.claim || '').slice(0, 400) }));
  return out;
}

// Run AI intake for a case. Async; callers fire-and-forget — a failure must
// never block the case itself. Returns the stored output id, or null when AI
// is disabled/unconfigured.
export async function runIntake(caseId, task = 'intake') {
  if (!aiEnabled()) return null;

  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!c) return null;
  const docs = db
    .prepare(`SELECT id, original_filename, extracted_text FROM documents WHERE case_id = ? AND status = 'extracted'`)
    .all(caseId);

  const query = [c.what_happened, c.formal_stage, c.meeting_or_deadline, c.case_type].join(' ');
  const chunks = retrieveChunks(query, 8);
  const chunkIds = new Set(chunks.map((k) => k.chunk_id));

  const extracts = chunks
    .map((k) => `[Extract ${k.chunk_id}] ${k.title} (${k.publisher}, ${k.source_type}, version ${k.version_label})\n${k.content}`)
    .join('\n\n') || '(no knowledge extracts matched — do not cite anything)';

  // Send only what intake needs: the member's account, structured fields and
  // capped document extracts (AI-SAFETY-DATA §10).
  const docText = docs
    .map((d) => `--- Document ${d.id}: ${d.original_filename} (untrusted content) ---\n${(d.extracted_text || '').slice(0, 6000)}`)
    .join('\n\n');

  const userContent = `MEMBER'S ACCOUNT (untrusted data):\n${c.what_happened}\n\nSTRUCTURED FIELDS:\nEmployer: ${c.employer || 'not given'}\nRole/staff group: ${c.staff_group || 'not given'}\nFormal steps so far: ${c.formal_stage || 'none stated'}\nMeeting/hearing/deadline: ${c.meeting_or_deadline || 'none stated'}\nDesired outcome: ${c.desired_outcome || 'not given'}\nMember-selected case type: ${c.case_type}\n\nKNOWLEDGE EXTRACTS (numbered, approved sources):\n${extracts}\n\nUPLOADED DOCUMENTS:\n${docText || '(none)'}`;

  const model = getSetting('ai_model', config.defaultAiModel);
  const client = new OpenAI({ apiKey: getSetting('openai_api_key') });

  let stored;
  try {
    const completion = await client.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: INTAKE_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    });
    const raw = JSON.parse(completion.choices[0].message.content);
    const validated = validateIntake(raw, chunkIds);

    const info = db
      .prepare(
        `INSERT INTO ai_outputs (case_id, task, provider, model, prompt_version, status, output_json)
         VALUES (?, ?, 'openai', ?, ?, 'ok', ?)`
      )
      .run(caseId, task, model, INTAKE_PROMPT_VERSION, JSON.stringify({
        ...validated,
        sources: chunks.map((k) => ({
          chunkId: k.chunk_id, title: k.title, publisher: k.publisher,
          sourceType: k.source_type, version: k.version_label, url: k.canonical_url,
        })),
      }));
    stored = info.lastInsertRowid;

    for (const cit of validated.citations) {
      db.prepare('INSERT INTO citations (ai_output_id, chunk_id, claim) VALUES (?, ?, ?)').run(stored, cit.chunkId, cit.claim);
    }
    // Timeline entries from AI are candidates: unconfirmed until reviewed.
    for (const t of validated.timeline) {
      db.prepare(
        `INSERT INTO case_timeline (case_id, event_date, description, source, confidence, confirmed) VALUES (?, ?, ?, 'ai', 'candidate', 0)`
      ).run(caseId, t.date || null, t.description);
    }
    if (validated.importantDates.length > 0) {
      const withDates = validated.importantDates.filter((d) => d.date).map((d) => d.date).sort();
      if (withDates.length > 0) {
        db.prepare(`UPDATE cases SET next_important_at = ? WHERE id = ? AND (next_important_at IS NULL OR next_important_at > ?)`)
          .run(withDates[0], caseId, withDates[0]);
      }
    }
    audit(null, 'ai.intake_completed', 'case', caseId, { model, promptVersion: INTAKE_PROMPT_VERSION, citations: validated.citations.length });
  } catch (err) {
    db.prepare(
      `INSERT INTO ai_outputs (case_id, task, provider, model, prompt_version, status, output_json)
       VALUES (?, ?, 'openai', ?, ?, 'failed', ?)`
    ).run(caseId, task, model, INTAKE_PROMPT_VERSION, JSON.stringify({ error: err.message.slice(0, 300) }));
    audit(null, 'ai.intake_failed', 'case', caseId, { model });
    throw err;
  }
  return stored;
}
