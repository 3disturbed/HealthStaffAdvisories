import { db } from '../db/connection.js';
import { permissionsForUser, userHas } from '../rbac/permissions.js';
import { ASSISTANT_SYSTEM_PROMPT, ASSISTANT_PROMPT_VERSION } from './prompts.js';
import { toolByName, toolDefinitions } from './assistantTools.js';
import { audit } from '../audit/log.js';
import { aiEnabled, completeChat } from './provider.js';

const MAX_LOOP = 6;
const HISTORY_ROWS = 40;
const RESULT_CAP = 8000;
const ACTION_TTL_MINUTES = 10;
const MAX_THREADS = 12;

function defaultComplete(messages, tools) {
  return completeChat(messages, tools);
}

// ── threads ──────────────────────────────────────────────────────────────

export function listThreads(userId) {
  return db
    .prepare('SELECT id, title, created_at, updated_at FROM assistant_threads WHERE user_id = ? ORDER BY updated_at DESC, id DESC')
    .all(userId)
    .map((t) => ({ id: t.id, title: t.title, createdAt: t.created_at, updatedAt: t.updated_at }));
}

export function createThread(user, title = 'New chat') {
  const count = db.prepare('SELECT COUNT(*) AS n FROM assistant_threads WHERE user_id = ?').get(user.id).n;
  if (count >= MAX_THREADS) return { error: `You can have at most ${MAX_THREADS} conversations — close one first.`, status: 400 };
  const id = db
    .prepare('INSERT INTO assistant_threads (user_id, title) VALUES (?, ?)')
    .run(user.id, String(title).trim().slice(0, 60) || 'New chat').lastInsertRowid;
  return { ok: true, thread: { id, title: String(title).trim().slice(0, 60) || 'New chat' } };
}

function ownedThread(userId, threadId) {
  return db.prepare('SELECT * FROM assistant_threads WHERE id = ? AND user_id = ?').get(Number(threadId), userId);
}

export function renameThread(user, threadId, title) {
  const clean = String(title || '').trim().slice(0, 60);
  if (!clean) return { error: 'Title cannot be empty.', status: 400 };
  const info = db.prepare('UPDATE assistant_threads SET title = ? WHERE id = ? AND user_id = ?').run(clean, Number(threadId), user.id);
  if (info.changes !== 1) return { error: 'Conversation not found.', status: 404 };
  return { ok: true, title: clean };
}

export function deleteThread(user, threadId) {
  const thread = ownedThread(user.id, threadId);
  if (!thread) return { error: 'Conversation not found.', status: 404 };
  db.prepare(`UPDATE assistant_actions SET status = 'expired', resolved_at = datetime('now') WHERE thread_id = ? AND user_id = ? AND status = 'pending'`).run(thread.id, user.id);
  db.prepare('DELETE FROM assistant_messages WHERE thread_id = ? AND user_id = ?').run(thread.id, user.id);
  db.prepare('DELETE FROM assistant_threads WHERE id = ?').run(thread.id);
  audit(user.id, 'assistant.thread_deleted', 'assistant_thread', thread.id);
  return { ok: true };
}

// ── persistence helpers ──────────────────────────────────────────────────

function insertRow(userId, threadId, role, content, toolCalls = null, toolCallId = null) {
  return db
    .prepare('INSERT INTO assistant_messages (user_id, thread_id, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, threadId, role, content, toolCalls ? JSON.stringify(toolCalls) : null, toolCallId).lastInsertRowid;
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

function historyFor(userId, threadId) {
  const rows = db
    .prepare(`SELECT * FROM (SELECT * FROM assistant_messages WHERE user_id = ? AND thread_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id`)
    .all(userId, threadId, HISTORY_ROWS);
  while (rows.length && rows[0].role === 'tool') rows.shift();
  return rows.map((r) => {
    if (r.role === 'assistant' && r.tool_calls) {
      return { role: 'assistant', content: r.content || null, tool_calls: JSON.parse(r.tool_calls) };
    }
    if (r.role === 'tool') return { role: 'tool', tool_call_id: r.tool_call_id, content: r.content };
    return { role: r.role, content: r.content };
  });
}

function pendingFor(userId, threadId) {
  return db
    .prepare(`SELECT id, tool_name, summary, args_json, created_at, expires_at FROM assistant_actions
       WHERE user_id = ? AND thread_id = ? AND status = 'pending' AND expires_at > datetime('now') ORDER BY id`)
    .all(userId, threadId)
    .map((a) => ({
      id: a.id,
      tool: a.tool_name,
      summary: a.summary,
      args: JSON.parse(a.args_json),
      editableFields: toolByName.get(a.tool_name)?.editable || [],
      createdAt: a.created_at,
      expiresAt: a.expires_at,
    }));
}

export function assistantState(userId, threadId) {
  const rows = db
    .prepare(`SELECT id, role, content, tool_calls, created_at FROM assistant_messages WHERE user_id = ? AND thread_id = ? ORDER BY id DESC LIMIT ${HISTORY_ROWS}`)
    .all(userId, threadId)
    .reverse();
  return {
    threadId,
    messages: rows
      .filter((r) => (r.role === 'user' || r.role === 'assistant') && r.content)
      .map((r) => ({ id: r.id, role: r.role, content: r.content, createdAt: r.created_at })),
    pending: pendingFor(userId, threadId),
  };
}

// ── chat loop ────────────────────────────────────────────────────────────

export async function runAssistantTurn(user, threadId, content, { complete = defaultComplete } = {}) {
  const thread = ownedThread(user.id, threadId);
  if (!thread) return { error: 'Conversation not found.', status: 404 };
  expireStalePending(user.id);
  insertRow(user.id, thread.id, 'user', content);
  if (thread.title === 'New chat') {
    db.prepare('UPDATE assistant_threads SET title = ? WHERE id = ?').run(content.slice(0, 40), thread.id);
  }
  db.prepare(`UPDATE assistant_threads SET updated_at = datetime('now') WHERE id = ?`).run(thread.id);

  const actor = freshUser(user.id);
  const permissions = permissionsForUser(actor);
  const tools = toolDefinitions(permissions);
  const system = { role: 'system', content: ASSISTANT_SYSTEM_PROMPT };

  for (let i = 0; i < MAX_LOOP; i += 1) {
    const response = await complete([system, ...historyFor(user.id, thread.id)], tools);
    const msg = response.choices[0].message;
    insertRow(user.id, thread.id, 'assistant', msg.content || '', msg.tool_calls || null);
    if (!msg.tool_calls || msg.tool_calls.length === 0) break;

    let proposed = null;
    for (const call of msg.tool_calls) {
      // Placeholder first so every tool_call always has a reply row.
      insertRow(user.id, thread.id, 'tool', 'Working…', null, call.id);
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
            `INSERT INTO assistant_actions (user_id, thread_id, tool_name, args_json, summary, tool_call_id, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+${ACTION_TTL_MINUTES} minutes'))`
          )
          .run(user.id, thread.id, tool.name, JSON.stringify(args), summary, call.id).lastInsertRowid;
        resolveToolRow(user.id, call.id, 'Proposed action is awaiting human approval.');
        audit(user.id, 'assistant.action_proposed', 'assistant_action', actionId, { tool: tool.name, promptVersion: ASSISTANT_PROMPT_VERSION });
        proposed = actionId;
      }
    }
    if (proposed) break; // stop looping — wait for the human
  }
  return assistantState(user.id, thread.id);
}

// Atomically claim a pending action; execute through the same guarded
// service the UI uses; the approving human is the actor. `edits` lets the
// approver correct the draft, but only fields the tool declares editable.
export async function confirmAction(user, actionId, { complete = defaultComplete, edits = {} } = {}) {
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

  const args = JSON.parse(row.args_json);
  let edited = false;
  for (const field of tool.editable || []) {
    if (typeof edits[field] === 'string' && edits[field].trim()) {
      args[field] = edits[field].trim().slice(0, RESULT_CAP);
      edited = true;
    }
  }
  if (edited) {
    db.prepare('UPDATE assistant_actions SET args_json = ? WHERE id = ?').run(JSON.stringify(args), row.id);
  }

  let result;
  try {
    result = tool.run(actor, args, { via: 'assistant', actionId: row.id });
  } catch (err) {
    result = { error: `Action failed: ${err.message.slice(0, 200)}` };
  }
  resolveToolRow(user.id, row.tool_call_id, JSON.stringify({ ...result, ...(edited ? { editedByApprover: true } : {}) }));
  audit(user.id, 'assistant.action_executed', 'assistant_action', row.id, { tool: row.tool_name, ok: !result.error, edited });

  // Best-effort follow-up so the chat reflects the outcome; no tools.
  if (aiEnabled()) {
    try {
      const response = await complete(
        [{ role: 'system', content: ASSISTANT_SYSTEM_PROMPT }, ...historyFor(user.id, row.thread_id)],
        []
      );
      insertRow(user.id, row.thread_id, 'assistant', response.choices[0].message.content || '');
    } catch { /* non-fatal */ }
  }
  return { ok: !result.error, result, state: assistantState(user.id, row.thread_id) };
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
  return { ok: true, state: assistantState(user.id, row.thread_id) };
}
