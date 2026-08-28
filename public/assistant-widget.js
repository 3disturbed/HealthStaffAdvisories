import { api, esc, escAttr, fmtDate } from '/common.js';

// Shared tabbed assistant chat. Used by the floating widget (every page)
// and embedded in the Admin → Assistant tab. Each tab is an independent
// conversation (thread) so parallel tasks keep separate context.

// Each chat instance needs its own field ids: the floating widget and the
// embedded Admin -> Assistant panel can both be live on the same page.
let chatSeq = 0;

export function createChatUI(container) {
  const uid = `assistant-${++chatSeq}`;
  container.innerHTML = `
    <div class="assistant-chatwrap">
      <div class="assistant-tabs" data-tabs></div>
      <div class="assistant-body" data-body>
        <div class="skel skel-line" data-w="60"></div>
        <div class="skel skel-line" data-w="85"></div>
        <div class="skel skel-line" data-w="40"></div>
      </div>
      <form class="assistant-inputrow" data-form>
        <label class="sr-only" for="${uid}-text">Message the assistant</label>
        <textarea id="${uid}-text" name="message" data-text rows="2" maxlength="4000" placeholder="Ask about accounts, cases, deadlines…"></textarea>
        <button class="btn" type="submit" data-send>Send</button>
      </form>
    </div>`;

  const tabsEl = container.querySelector('[data-tabs]');
  const body = container.querySelector('[data-body]');
  const form = container.querySelector('[data-form]');
  const text = container.querySelector('[data-text]');
  const send = container.querySelector('[data-send]');

  let root = { configured: false, enabled: false, threads: [] };
  let activeId = null;

  function renderTabs() {
    tabsEl.innerHTML = `
      ${root.threads.map((t) => `
        <button type="button" class="assistant-tab ${t.id === activeId ? 'active' : ''}" data-thread="${t.id}" title="${escAttr(t.title)} (double-click to rename)">
          ${esc(t.title.length > 18 ? `${t.title.slice(0, 17)}…` : t.title)}
          <span class="assistant-tab-x" data-close="${t.id}" title="Close conversation">✕</span>
        </button>`).join('')}
      <button type="button" class="assistant-tab assistant-tab-new" data-new title="New conversation">＋</button>`;

    tabsEl.querySelectorAll('[data-thread]').forEach((b) => {
      b.addEventListener('click', (e) => {
        if (e.target.dataset.close) return;
        activeId = Number(b.dataset.thread);
        renderTabs();
        renderThread();
      });
      b.addEventListener('dblclick', async () => {
        const current = root.threads.find((t) => t.id === Number(b.dataset.thread));
        const title = window.prompt('Rename conversation:', current?.title || '');
        if (!title) return;
        try {
          await api(`/admin/assistant/threads/${b.dataset.thread}/rename`, { method: 'POST', body: { title } });
          await loadRoot(false);
        } catch (err) { banner(err.message); }
      });
    });
    tabsEl.querySelectorAll('[data-close]').forEach((x) =>
      x.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!window.confirm('Close this conversation? Its history is deleted.')) return;
        try {
          await api(`/admin/assistant/threads/${x.dataset.close}/delete`, { method: 'POST' });
          if (activeId === Number(x.dataset.close)) activeId = null;
          await loadRoot(true);
        } catch (err) { banner(err.message); }
      }));
    tabsEl.querySelector('[data-new]').addEventListener('click', async () => {
      try {
        const r = await api('/admin/assistant/threads', { method: 'POST', body: {} });
        activeId = r.thread.id;
        await loadRoot(false);
        renderThread();
      } catch (err) { banner(err.message); }
    });
  }

  function banner(message) {
    body.insertAdjacentHTML('afterbegin', `<div class="notice error small">${esc(message)}</div>`);
  }

  function actionCard(a) {
    const editable = a.editableFields.includes('content');
    return `
      <div class="notice warn small" data-card="${a.id}">
        <strong>Proposed action:</strong> ${esc(a.summary)}
        ${editable
          ? `<p class="small">Review the draft — edit it if needed, then approve to send:</p>
             <label class="sr-only" for="${uid}-action-${a.id}">Draft message for action ${a.id}</label>
             <textarea id="${uid}-action-${a.id}" name="content" data-edit="${a.id}" rows="8">${esc(a.args.content || '')}</textarea>`
          : `<details><summary>details</summary><div class="table-scroll"><pre class="small">${esc(JSON.stringify(a.args, null, 2))}</pre></div></details>`}
        <p>
          <button class="btn small" type="button" data-approve="${a.id}">${editable ? 'Approve & send' : 'Approve'}</button>
          <button class="btn small quiet" type="button" data-decline="${a.id}">Decline</button>
        </p>
      </div>`;
  }

  function renderState(state, note) {
    const banners = [];
    if (!root.configured) banners.push('<div class="notice warn small">No OpenAI API key is configured. An administrator can add one in Admin → AI settings.</div>');
    else if (!root.enabled) banners.push('<div class="notice warn small">The AI kill switch is on — chat is paused. Pending actions can still be approved or declined.</div>');
    if (note) {
      banners.push(`<div class="notice error small">${esc(note)}<br><button class="btn small quiet" type="button" data-retry>Try again</button></div>`);
    }

    const msgs = state?.messages || [];
    body.innerHTML = `
      ${banners.join('')}
      ${msgs.map((m, i) => `
        <div class="msg ${m.role === 'user' ? 'member' : 'system'}${i === msgs.length - 1 ? ' anim-msg-in' : ''}">
          <div class="who">${m.role === 'user' ? 'You' : 'Assistant'} · ${esc(fmtDate(m.createdAt))}</div>
          <div class="body">${esc(m.content)}</div>
        </div>`).join('') || '<p class="muted small">Try “Which case has the highest priority and shortest deadline?” or “Draft an information request for case 1.”</p>'}
      ${(state?.pending || []).map(actionCard).join('')}`;
    body.scrollTop = body.scrollHeight;

    const disabled = !root.enabled;
    text.disabled = disabled;
    send.disabled = disabled;

    body.querySelector('[data-retry]')?.addEventListener('click', () =>
      loadRoot().then(() => renderThread()).catch((err) => renderState(null, err.message)));

    body.querySelectorAll('[data-approve]').forEach((b) =>
      b.addEventListener('click', async () => {
        b.disabled = true;
        const edit = body.querySelector(`[data-edit="${b.dataset.approve}"]`);
        try {
          await api(`/admin/assistant/actions/${b.dataset.approve}/confirm`, {
            method: 'POST',
            body: edit ? { content: edit.value } : {},
          });
          renderThread();
        } catch (err) { renderThread(err.message); }
      }));
    body.querySelectorAll('[data-decline]').forEach((b) =>
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await api(`/admin/assistant/actions/${b.dataset.decline}/cancel`, { method: 'POST' });
          renderThread();
        } catch (err) { renderThread(err.message); }
      }));
  }

  async function renderThread(note) {
    if (!activeId) return renderState(null, note);
    try {
      renderState(await api(`/admin/assistant/threads/${activeId}`), note);
    } catch (err) {
      renderState(null, err.message);
    }
  }

  async function loadRoot(pickFirst = true) {
    root = await api('/admin/assistant');
    if (!Array.isArray(root.threads)) {
      // Response shape mismatch — almost certainly a stale cached script.
      throw new Error('The app has been updated — please refresh the page.');
    }
    if (pickFirst && !activeId && root.threads.length > 0) activeId = root.threads[0].id;
    if (activeId && !root.threads.some((t) => t.id === activeId)) activeId = root.threads[0]?.id || null;
    renderTabs();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = text.value.trim();
    if (!content || send.disabled) return;
    send.disabled = true;
    try {
      if (!activeId) {
        const r = await api('/admin/assistant/threads', { method: 'POST', body: {} });
        activeId = r.thread.id;
      }
      text.value = '';
      body.insertAdjacentHTML('beforeend', `<div class="msg member"><div class="who">You</div><div class="body">${esc(content)}</div></div><div class="muted small">Thinking…</div>`);
      body.scrollTop = body.scrollHeight;
      await api(`/admin/assistant/threads/${activeId}/message`, { method: 'POST', body: { content } });
      await loadRoot(false); // thread titles/order may have changed
      await renderThread();
    } catch (err) {
      await renderThread(err.message);
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

  loadRoot().then(() => renderThread()).catch((err) => renderState(null, err.message));
}

// ── floating widget ──────────────────────────────────────────────────────

let mounted = false;
let toggleWidget = null;

export function mountAssistantWidget() {
  if (mounted) return;
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
  overlay.className = 'assistant-overlay';
  overlay.innerHTML = `
    <div class="assistant-panel" role="dialog" aria-modal="true" aria-label="Assistant">
      <div class="assistant-head">
        <strong>Assistant <span class="tag ai">AI</span></strong>
        <button class="assistant-headbtn" type="button" id="assistant-close" aria-label="Close">✕</button>
      </div>
      <div class="assistant-chatholder" id="assistant-chatholder"></div>
    </div>`;
  document.body.appendChild(overlay);

  const holder = overlay.querySelector('#assistant-chatholder');
  let loaded = false;
  function toggle(show) {
    overlay.classList.toggle('open', show);
    fab.classList.toggle('hidden', show);
    if (!show || loaded) return;
    loaded = true;
    // Opening hides the launcher, so a throw in here used to leave no way back
    // in: no floating button and a blank panel, with the failure surfacing far
    // away as a toast about the network. Keep it where the conversation would
    // have been, and let the next press try again.
    try {
      createChatUI(holder);
    } catch (err) {
      loaded = false;
      holder.innerHTML = `<div class="notice error small">The assistant could not start: ${esc(err.message)}</div>`;
    }
  }
  toggleWidget = toggle;

  // Compatibility shim: a browser holding a common.js from before the launcher
  // moved to openAssistantWidget() still calls this. Costs a line, and spares
  // whoever loads one of the two files from cache a dead button.
  window.__openAssistant = () => toggle(true);

  fab.addEventListener('click', () => toggle(true));
  overlay.querySelector('#assistant-close').addEventListener('click', () => toggle(false));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) toggle(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('open')) toggle(false); });
}

// The other launcher — the bottom tab bar's Assistant tab — is painted by
// /common.js before this module has finished loading, so it cannot hold a
// reference to toggle(). It calls openAssistant() there, which loads this
// module and then calls this. Mounting here as well means the first tap opens
// the panel even when it lands before mountAssistantWidget() has run.
export function openAssistantWidget() {
  mountAssistantWidget();
  // Silence here is what the caller cannot report: say the mount failed.
  if (!toggleWidget) throw new Error('the assistant panel failed to mount');
  toggleWidget(true);
}
