import OpenAI from 'openai';
import { db, getSetting } from '../db/connection.js';
import { permissionsForUser, userHas } from '../rbac/permissions.js';
import { ASSISTANT_SYSTEM_PROMPT, ASSISTANT_PROMPT_VERSION } from './prompts.js';
import { ASSISTANT_TOOLS, toolByName, toolDefinitions } from './assistantTools.js';
import { audit } from '../audit/log.js';
import { config } from '../config.js';

const MAX_LOOP = 6;
const HISTORY_ROWS = 40;
const RESULT_CAP = 8000;
const ACTION_TTL_MINUTES = 10;

function defaultComplete(messages, tools) {
  const client = new OpenAI({ apiKey: getSetting('openai_api_key') });
  return client.chat.completions.create({
    model: getSetting('ai_model', config.defaultAiModel),
    messages,
    ...(tools.length > 0 ? { tools, parallel_tool_calls: false } : {}),
  });
}

function insertRow(userId, role, content, toolCalls = null, toolCallId = null) {
  return db
    .prepare('INSERT INTO assistant_messages (user_id, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?)')
    .run(userId, role, content, toolCalls ? JSON.stringify(toolCalls) : null, toolCallId).lastInsertRowid;
}

// Every assistant tool_call must always have a matching tool row, or the
// next OpenAI call rejects the history. Resolution UPDATES the placeholder.
function resolveToolRow(userId, toolCallId, content) {
  db.prepare(
    `UPDATE assistant_messages SET content = ? WHERE user_id = ? AND role = 'tool' AND tool_call_id = ?`
  ).run(content.slice(0, RESULT_CAP), userId, toolCallId);
}

function freshUser(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

export function expireStalePending(userId) {
  const stale = db
    .prepare(`SELECT * FROM assistant_actions WHERE user_id = ? AND status = 'pending' AND expires_at <= datetime('now')`)
    .all(userId);
  for (const row of stale) {
    db.prepare(`UPDATE assistant_actions SET status = 'expired', resolved_at = datetime('now') WHERE id = ?`).run(row.id);
    resolveToolRow(userId, row.tool_call_id, 'Proposed action expired without approval.');
  }
}

function historyFor(userId) {
  const rows = db
    .prepare(`SELECT * FROM (SELECT * FROM assistant_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id`)
    .all(userId, HISTORY_ROWS);
  // Never start the window on tool rows whose assistant tool_call row was
  // trimmed away — drop leading tool rows.
  while (rows.length && rows[0].role === 'tool') rows.shift();
  return rows.map((r) => {
    if (r.role === 'assistant' && r.tool_calls) {
      return { role: 'assistant', content: r.content || null, tool_calls: JSON.parse(r.tool_calls) };
    }
    if (r.role === 'tool') return { role: 'tool', tool_call_id: r.tool_call_id, content: r.content };
    return { role: r.role, content: r.content };
  });
}

function pendingFor(userId) {
  return db
    .prepare(`SELECT id, tool_name, summary, args_json, created_at, expires_at FROM assistant_actions WHERE user_id = ? AND status = 'pending' AND expires_at > datetime('now') ORDER BY id`)
    .all(userId)
    .map((a) => ({ id: a.id, tool: a.tool_name, summary: a.summary, args: JSON.parse(a.args_json), createdAt: a.created_at, expiresAt: a.expires_at }));
}

export function assistantState(userId) {
  const rows = db
    .prepare(`SELECT id, role, content, tool_calls, created_at FROM assistant_messages WHERE user_id = ? ORDER BY id DESC LIMIT ${HISTORY_ROWS}`)
    .all(userId)
    .reverse();
  return {
    messages: rows
      .filter((r) => (r.role === 'user' || r.role === 'assistant') && r.content)
      .map((r) => ({ id: r.id, role: r.role, content: r.content, createdAt: r.created_at })),
    pending: pendingFor(userId),
  };
}

export async function runAssistantTurn(user, content, { complete = defaultComplete } = {}) {
  expireStalePending(user.id);
  insertRow(user.id, 'user', content);

  const actor = freshUser(user.id);
  const permissions = permissionsForUser(actor);
  const tools = toolDefinitions(permissions);
  const system = { role: 'system', content: ASSISTANT_SYSTEM_PROMPT };

  for (let i = 0; i < MAX_LOOP; i += 1) {
    const response = await complete([system, ...historyFor(user.id)], tools);
    const msg = response.choices[0].message;
    insertRow(user.id, 'assistant', msg.content || '', msg.tool_calls || null);
    if (!msg.tool_calls || msg.tool_calls.length === 0) break;

    let proposed = null;
    for (const call of msg.tool_calls) {
      // Placeholder first so every tool_call always has a reply row.
      insertRow(user.id, 'tool', 'Working…', null, call.id);
      const tool = toolByName.get(call.function.name);
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* treated as empty */ }

      if (!tool || !userHas(actor, tool.permission)) {
        // Model output is not authority — unknown/unpermitted tools error back.
        resolveToolRow(user.id, call.id, JSON.stringify({ error: 'Tool not available to you.' }));
      } else if (tool.kind === 'read') {
        let result;
        try { result = tool.run(actor, args); } catch (err) { result = { error: `Tool failed: ${err.message.slice(0, 200)}` }; }
        resolveToolRow(user.id, call.id, JSON.stringify(result));
      } else if (proposed) {
        resolveToolRow(user.id, call.id, JSON.stringify({ error: 'Only one action can be proposed at a time.' }));
      } else {
        const summary = tool.summarize ? tool.summarize(args) : tool.name;
        const actionId = db
          .prepare(
            `INSERT INTO assistant_actions (user_id, tool_name, args_json, summary, tool_call_id, expires_at)
             VALUES (?, ?, ?, ?, ?, datetime('now', '+${ACTION_TTL_MINUTES} minutes'))`
          )
          .run(user.id, tool.name, JSON.stringify(args), summary, call.id).lastInsertRowid;
        resolveToolRow(user.id, call.id, 'Proposed action is awaiting human approval.');
        audit(user.id, 'assistant.action_proposed', 'assistant_action', actionId, { tool: tool.name, promptVersion: ASSISTANT_PROMPT_VERSION });
        proposed = actionId;
      }
    }
    if (proposed) break; // stop looping — wait for the human
  }
  return assistantState(user.id);
}

// Atomically claim a pending action; execute through the same guarded
// service the admin UI uses; the approving human is the actor.
export async function confirmAction(user, actionId, { complete = defaultComplete } = {}) {
  const row = db.prepare('SELECT * FROM assistant_actions WHERE id = ? AND user_id = ?').get(Number(actionId), user.id);
  if (!row) return { error: 'Action not found.', status: 404 };
  const claim = db
    .prepare(
      `UPDATE assistant_actions SET status = 'executed', resolved_at = datetime('now')
       WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at > datetime('now')`
    )
    .run(row.id, user.id);
  if (claim.changes !== 1) return { error: 'This action has expired or was already handled. Ask again in the chat.', status: 410 };

  const tool = toolByName.get(row.tool_name);
  const actor = freshUser(user.id);
  if (!tool || !userHas(actor, tool.permission)) {
    resolveToolRow(user.id, row.tool_call_id, JSON.stringify({ error: 'Approver no longer holds the required permission.' }));
    audit(user.id, 'assistant.action_executed', 'assistant_action', row.id, { tool: row.tool_name, ok: false });
    return { error: 'You no longer hold the permission required for this action.', status: 403 };
  }

  let result;
  try {
    result = tool.run(actor, JSON.parse(row.args_json), { via: 'assistant', actionId: row.id });
  } catch (err) {
    result = { error: `Action failed: ${err.message.slice(0, 200)}` };
  }
  resolveToolRow(user.id, row.tool_call_id, JSON.stringify(result));
  audit(user.id, 'assistant.action_executed', 'assistant_action', row.id, { tool: row.tool_name, ok: !result.error });

  // Best-effort follow-up so the chat reflects the outcome; no tools.
  if (getSetting('ai_disabled', '0') !== '1' && getSetting('openai_api_key')) {
    try {
      const response = await complete(
        [{ role: 'system', content: ASSISTANT_SYSTEM_PROMPT }, ...historyFor(user.id)],
        []
      );
      insertRow(user.id, 'assistant', response.choices[0].message.content || '');
    } catch { /* non-fatal */ }
  }
  return { ok: !result.error, result, state: assistantState(user.id) };
}

export function cancelAction(user, actionId) {
  const claim = db
    .prepare(
      `UPDATE assistant_actions SET status = 'declined', resolved_at = datetime('now')
       WHERE id = ? AND user_id = ? AND status = 'pending'`
    )
    .run(Number(actionId), user.id);
  if (claim.changes !== 1) return { error: 'Action not found or already handled.', status: 410 };
  const row = db.prepare('SELECT * FROM assistant_actions WHERE id = ?').get(Number(actionId));
  resolveToolRow(user.id, row.tool_call_id, 'Declined by the user.');
  audit(user.id, 'assistant.action_declined', 'assistant_action', row.id, { tool: row.tool_name });
  return { ok: true, state: assistantState(user.id) };
}

export function resetConversation(user) {
  db.prepare(`UPDATE assistant_actions SET status = 'expired', resolved_at = datetime('now') WHERE user_id = ? AND status = 'pending'`).run(user.id);
  db.prepare('DELETE FROM assistant_messages WHERE user_id = ?').run(user.id);
  audit(user.id, 'assistant.reset', 'user', user.id);
  return { ok: true };
}
