import OpenAI from 'openai';
import { getSetting } from '../db/connection.js';
import { config } from '../config.js';

// Shared OpenAI adapter (AGENTS.md: keep provider integrations behind
// adapters). All model calls route through here. One retry on transient
// provider errors (429/5xx) with a short fixed backoff; validation
// failures are never retried — they are recorded and surfaced instead.

export function aiConfigured() {
  return !!getSetting('openai_api_key');
}

export function aiEnabled() {
  return getSetting('ai_disabled', '0') !== '1' && aiConfigured();
}

export function currentModel() {
  return getSetting('ai_model', config.defaultAiModel);
}

function isTransient(err) {
  const s = err?.status ?? err?.response?.status;
  return s === 429 || (typeof s === 'number' && s >= 500 && s < 600);
}

async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isTransient(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return fn();
  }
}

function client() {
  return new OpenAI({ apiKey: getSetting('openai_api_key') });
}

// Chat completion with optional tool definitions (assistant loop).
export function completeChat(messages, tools = []) {
  return withRetry(() =>
    client().chat.completions.create({
      model: currentModel(),
      messages,
      ...(tools.length > 0 ? { tools, parallel_tool_calls: false } : {}),
    })
  );
}

// JSON-mode completion for structured tasks. Returns the parsed object and
// the model used; the CALLER must validate — model output is untrusted.
export async function completeJson(messages) {
  const model = currentModel();
  const completion = await withRetry(() =>
    client().chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages,
    })
  );
  return { model, raw: JSON.parse(completion.choices[0].message.content) };
}
