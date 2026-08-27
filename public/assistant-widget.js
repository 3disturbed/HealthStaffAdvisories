import { api, esc, fmtDate } from '/common.js';

// Floating assistant: a bottom-right button on every page (for accounts
// holding at least one assistant permission). Desktop: popout panel in the
// bottom-right corner. Mobile: full-screen modal. Same server endpoints and
// confirm-first rules as the Admin → Assistant tab.

let mounted = false;

export function mountAssistantWidget() {
  if (mounted || document.getElementById('assistant-fab')) return;
  mounted = true;

  const fab = document.createElement('button');
  fab.id = 'assistant-fab';
  fab.className = 'assistant-fab';
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Open the assistant');
  fab.textContent = '💬';
  document.body.appendChild(fab);

  const overlay = document.createElement('div');
  overlay.id = 'assistant-overlay';
  overlay.className = 'assistant-overlay hidden';
  overlay.innerHTML = `
    <div class="assistant-panel" role="dialog" aria-modal="true" aria-label="Assistant">
      <div class="assistant-head">
        <strong>Assistant <span class="tag ai">AI</span></strong>
        <span>
          <button class="assistant-headbtn" type="button" id="assistant-clear" title="Clear conversation">Clear</button>
          <button class="assistant-headbtn" type="button" id="assistant-close" aria-label="Close">✕</button>
        </span>
      </div>
      <div class="assistant-body" id="assistant-body"><p class="muted">Loading…</p></div>
      <form class="assistant-inputrow" id="assistant-form">
        <textarea id="assistant-text" rows="2" maxlength="4000" placeholder="Ask about accounts, cases, deadlines…" aria-label="Message the assistant"></textarea>
        <button class="btn" type="submit" id="assistant-send">Send</button>
      </form>
    </div>`;
  document.body.appendChild(overlay);

  const body = overlay.querySelector('#assistant-body');
  const form = overlay.querySelector('#assistant-form');
  const text = overlay.querySelector('#assistant-text');
  const send = overlay.querySelector('#assistant-send');

  function toggle(show) {
    overlay.classList.toggle('hidden', !show);
    fab.classList.toggle('hidden', show);
    if (show) {
      refresh();
      text.focus();
    }
  }

  async function refresh(note) {
    let state;
    try {
      state = await api('/admin/assistant');
    } catch (err) {
      body.innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
      return;
    }
    const banners = [];
    if (!state.configured) {
      banners.push('<div class="notice warn small">No OpenAI API key is configured. An administrator can add one in Admin → AI settings.</div>');
    } else if (!state.enabled) {
      banners.push('<div class="notice warn small">The AI kill switch is on — chat is paused. Pending actions can still be approved or declined.</div>');
    }
    if (note) banners.push(`<div class="notice error small">${esc(note)}</div>`);

    body.innerHTML = `
      ${banners.join('')}
      ${state.messages.map((m) => `
        <div class="msg ${m.role === 'user' ? 'member' : 'system'}">
          <div class="who">${m.role === 'user' ? 'You' : 'Assistant'} · ${esc(fmtDate(m.createdAt))}</div>
          <div class="body">${esc(m.content)}</div>
        </div>`).join('') || '<p class="muted small">Try “Which case has the highest priority and shortest deadline?”</p>'}
      ${state.pending.map((a) => `
        <div class="notice warn small">
          <strong>Proposed action:</strong> ${esc(a.summary)}
          <details><summary>details</summary><div class="table-scroll"><pre class="small">${esc(JSON.stringify(a.args, null, 2))}</pre></div></details>
          <p>
            <button class="btn small" type="button" data-approve="${a.id}">Approve</button>
            <button class="btn small quiet" type="button" data-decline="${a.id}">Decline</button>
          </p>
        </div>`).join('')}
      <div class="muted small hidden" id="assistant-thinking">Thinking…</div>`;
    body.scrollTop = body.scrollHeight;

    const disabled = !state.enabled;
    text.disabled = disabled;
    send.disabled = disabled;

    body.querySelectorAll('[data-approve]').forEach((b) =>
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await api(`/admin/assistant/actions/${b.dataset.approve}/confirm`, { method: 'POST' });
          refresh();
        } catch (err) { refresh(err.message); }
      }));
    body.querySelectorAll('[data-decline]').forEach((b) =>
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await api(`/admin/assistant/actions/${b.dataset.decline}/cancel`, { method: 'POST' });
          refresh();
        } catch (err) { refresh(err.message); }
      }));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = text.value.trim();
    if (!content || send.disabled) return;
    text.value = '';
    send.disabled = true;
    document.getElementById('assistant-thinking')?.classList.remove('hidden');
    try {
      await api('/admin/assistant/message', { method: 'POST', body: { content } });
      await refresh();
    } catch (err) {
      await refresh(err.message);
    } finally {
      send.disabled = text.disabled;
    }
  });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  fab.addEventListener('click', () => toggle(true));
  overlay.querySelector('#assistant-close').addEventListener('click', () => toggle(false));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) toggle(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.classList.contains('hidden')) toggle(false); });
  overlay.querySelector('#assistant-clear').addEventListener('click', () =>
    api('/admin/assistant/reset', { method: 'POST' }).then(() => refresh()).catch((err) => refresh(err.message)));
}
