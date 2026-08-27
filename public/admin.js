import { api, esc, fmtDate, requireUser, can } from '/common.js';

const view = document.getElementById('view');
let user;

function canUseAssistant() {
  return ['users.manage', 'cases.review', 'knowledge.manage'].some((p) => can(user, p));
}

function tabsBar(active) {
  const tabs = [];
  if (can(user, 'users.manage')) tabs.push(['users', 'Users & permissions']);
  if (canUseAssistant()) tabs.push(['assistant', 'Assistant']);
  if (can(user, 'system.admin')) tabs.push(['settings', 'AI settings'], ['mailbox', 'Dev mailbox']);
  if (can(user, 'knowledge.manage')) tabs.push(['knowledge', 'Knowledge sources']);
  if (can(user, 'audit.view')) tabs.push(['audit', 'Audit log']);
  return `<div class="tabs">${tabs.map(([id, label]) => `<button data-tab="${id}" class="${id === active ? 'active' : ''}">${label}</button>`).join('')}</div>`;
}

function wireTabs() {
  view.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => route(b.dataset.tab)));
}

const oops = (err) => {
  const msg = document.getElementById('msg');
  if (msg) msg.innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  window.scrollTo(0, 0);
};

async function renderUsers() {
  const data = await api('/admin/users');
  const permKeys = Object.keys(data.permissionCatalog);
  view.innerHTML = `
    <h1>Admin</h1>${tabsBar('users')}
    <div id="msg"></div>
    <p class="muted small">Roles carry default permissions; per-account overrides grant or revoke individual permissions on top. The main administration account cannot be modified. Only the main administration account can grant or remove the <strong>admin</strong> role and administrative permissions.</p>
    <div class="stack">
    ${data.users.map((u) => `
      <div class="card" data-user="${u.id}">
        <h3 class="mt0">${esc(u.displayName)} <span class="muted small">${esc(u.email)}</span>
          ${u.isMainAdmin ? '<span class="tag critical">MAIN ADMIN</span>' : ''}
          <span class="tag ${u.status === 'active' ? 'role' : 'high'}">${esc(u.status)}</span>
          ${u.emailVerified ? '' : '<span class="tag">email unverified</span>'}
        </h3>
        <p class="small muted">Joined ${esc(fmtDate(u.createdAt))}${u.lastLoginAt ? ` · last sign-in ${esc(fmtDate(u.lastLoginAt))}` : ' · never signed in'}</p>
        <p><strong>Roles:</strong>
          ${data.roles.map((r) => {
            const has = u.roles.includes(r);
            const disabled = u.isMainAdmin ? 'disabled' : '';
            return `<span class="tag role">${r} <button class="btn small ${has ? 'danger' : 'quiet'}" data-role="${r}" data-action="${has ? 'remove' : 'add'}" data-uid="${u.id}" ${disabled}>${has ? '−' : '+'}</button></span>`;
          }).join(' ')}
        </p>
        <details>
          <summary><strong>Permissions</strong> <span class="muted small">(${u.effectivePermissions.length} effective)</span></summary>
          <div class="table-scroll"><table class="data">
            <tr><th>Permission</th><th>Effective</th><th>Override</th><th></th></tr>
            ${permKeys.map((p) => {
              const override = u.overrides.find((o) => o.permission === p);
              const effective = u.effectivePermissions.includes(p);
              const disabled = u.isMainAdmin ? 'disabled' : '';
              return `<tr>
                <td title="${esc(data.permissionCatalog[p])}">${esc(p)}<br><span class="muted small">${esc(data.permissionCatalog[p])}</span></td>
                <td>${effective ? '✅' : '—'}</td>
                <td>${override ? `<span class="tag ${override.mode === 'grant' ? 'role' : 'high'}">${override.mode}</span>` : '<span class="muted small">role default</span>'}</td>
                <td>
                  <button class="btn small quiet" data-perm="${p}" data-mode="grant" data-uid="${u.id}" ${disabled}>Grant</button>
                  <button class="btn small quiet" data-perm="${p}" data-mode="revoke" data-uid="${u.id}" ${disabled}>Revoke</button>
                  ${override ? `<button class="btn small quiet" data-perm="${p}" data-mode="clear" data-uid="${u.id}" ${disabled}>Clear</button>` : ''}
                </td>
              </tr>`;
            }).join('')}
          </table></div>
        </details>
        ${u.isMainAdmin || u.id === user.id ? '' : `<p class="right"><button class="btn small ${u.status === 'active' ? 'danger' : ''}" data-status="${u.status === 'active' ? 'disabled' : 'active'}" data-uid="${u.id}">${u.status === 'active' ? 'Disable account' : 'Enable account'}</button></p>`}
      </div>`).join('')}
    </div>`;
  wireTabs();
  view.querySelectorAll('[data-role]').forEach((b) =>
    b.addEventListener('click', () =>
      api(`/admin/users/${b.dataset.uid}/roles`, { method: 'POST', body: { role: b.dataset.role, action: b.dataset.action } })
        .then(renderUsers).catch(oops)));
  view.querySelectorAll('[data-perm]').forEach((b) =>
    b.addEventListener('click', () =>
      api(`/admin/users/${b.dataset.uid}/permissions`, { method: 'POST', body: { permission: b.dataset.perm, mode: b.dataset.mode } })
        .then(renderUsers).catch(oops)));
  view.querySelectorAll('[data-status]').forEach((b) =>
    b.addEventListener('click', () =>
      api(`/admin/users/${b.dataset.uid}/status`, { method: 'POST', body: { status: b.dataset.status } })
        .then(renderUsers).catch(oops)));
}

async function renderAssistant() {
  const state = await api('/admin/assistant');
  view.innerHTML = `
    <h1>Admin</h1>${tabsBar('assistant')}
    <div id="msg"></div>
    ${!state.configured ? '<div class="notice warn">No OpenAI API key is configured. Add one in <strong>AI settings</strong> to use the assistant.</div>' : ''}
    ${state.configured && !state.enabled ? '<div class="notice warn">The AI kill switch is on — chat is paused. You can still approve or decline pending actions below; re-enable AI in <strong>AI settings</strong>.</div>' : ''}
    <div class="card">
      <h3>Assistant <span class="tag ai">AI</span></h3>
      <p class="small muted">Ask about accounts, the case queue or knowledge sources. Any change it suggests becomes a proposed action you approve first — nothing happens without your click.</p>
      <div id="chat-log">
        ${state.messages.map((m) => `
          <div class="msg ${m.role === 'user' ? 'member' : 'system'}">
            <div class="who">${m.role === 'user' ? 'You' : 'Assistant'} · ${esc(fmtDate(m.createdAt))}</div>
            <div class="body">${esc(m.content)}</div>
          </div>`).join('') || '<p class="muted">No conversation yet. Try “Who has the advisor role?” or “Show me the urgent queue.”</p>'}
      </div>
      ${state.pending.map((a) => `
        <div class="notice warn" data-action-card="${a.id}">
          <strong>Proposed action:</strong> ${esc(a.summary)}
          <details class="small"><summary>details</summary><div class="table-scroll"><pre class="small">${esc(JSON.stringify(a.args, null, 2))}</pre></div></details>
          <p>
            <button class="btn small" data-approve="${a.id}">Approve</button>
            <button class="btn small quiet" data-decline="${a.id}">Decline</button>
            <span class="muted small">expires ${esc(fmtDate(a.expiresAt))}</span>
          </p>
        </div>`).join('')}
      <form id="chat-form">
        <label for="chat-input">Message</label>
        <textarea id="chat-input" maxlength="4000" required ${state.enabled ? '' : 'disabled'}></textarea>
        <p>
          <button class="btn" type="submit" ${state.enabled ? '' : 'disabled'}>Send</button>
          <button class="btn quiet" type="button" id="chat-reset">Clear conversation</button>
        </p>
      </form>
    </div>`;
  wireTabs();

  const busy = (on) => view.querySelectorAll('#chat-form button, [data-approve], [data-decline]').forEach((b) => { b.disabled = on; });
  document.getElementById('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = document.getElementById('chat-input').value.trim();
    if (!content) return;
    busy(true);
    try {
      await api('/admin/assistant/message', { method: 'POST', body: { content } });
      renderAssistant();
    } catch (err) { busy(false); oops(err); }
  });
  view.querySelectorAll('[data-approve]').forEach((b) =>
    b.addEventListener('click', async () => {
      busy(true);
      try {
        await api(`/admin/assistant/actions/${b.dataset.approve}/confirm`, { method: 'POST' });
        renderAssistant();
      } catch (err) { busy(false); oops(err); }
    }));
  view.querySelectorAll('[data-decline]').forEach((b) =>
    b.addEventListener('click', async () => {
      busy(true);
      try {
        await api(`/admin/assistant/actions/${b.dataset.decline}/cancel`, { method: 'POST' });
        renderAssistant();
      } catch (err) { busy(false); oops(err); }
    }));
  document.getElementById('chat-reset').addEventListener('click', () =>
    api('/admin/assistant/reset', { method: 'POST' }).then(renderAssistant).catch(oops));
  const log = document.getElementById('chat-log');
  log.scrollTop = log.scrollHeight;
  window.scrollTo(0, document.body.scrollHeight);
}

async function renderSettings() {
  const s = await api('/admin/settings');
  view.innerHTML = `
    <h1>Admin</h1>${tabsBar('settings')}
    <div id="msg"></div>
    <div class="card">
      <h3>AI provider (OpenAI)</h3>
      <p>Status: ${s.aiConfigured ? '<span class="tag role">configured</span>' : '<span class="tag high">no API key</span>'}
         ${s.aiDisabled ? '<span class="tag critical">KILL SWITCH ON — AI generation disabled</span>' : ''}</p>
      ${s.openaiKeyMasked ? `<p class="small muted">Stored key: ${esc(s.openaiKeyMasked)}</p>` : ''}
      <form id="settings-form">
        <label for="apiKey">OpenAI API key</label>
        <p class="hint">Paste a key to set or replace it. The key is stored server-side and never shown again in full.</p>
        <input id="apiKey" type="password" autocomplete="off" placeholder="sk-…">
        <label for="aiModel">Model</label>
        <input id="aiModel" type="text" value="${esc(s.aiModel)}">
        <p><button class="btn" type="submit">Save settings</button>
        ${s.openaiKeyMasked ? '<button class="btn danger" type="button" id="clear-key">Remove key</button>' : ''}</p>
      </form>
    </div>
    <div class="card">
      <h3>Incident kill switch</h3>
      <p class="small muted">Disables all AI generation while keeping the case portal available.</p>
      <button class="btn ${s.aiDisabled ? '' : 'danger'}" id="kill-switch">${s.aiDisabled ? 'Re-enable AI generation' : 'Disable AI generation'}</button>
    </div>`;
  wireTabs();
  document.getElementById('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const body = { aiModel: document.getElementById('aiModel').value };
    const key = document.getElementById('apiKey').value.trim();
    if (key) body.openaiApiKey = key;
    api('/admin/settings', { method: 'POST', body }).then(renderSettings).catch(oops);
  });
  document.getElementById('clear-key')?.addEventListener('click', () =>
    api('/admin/settings', { method: 'POST', body: { clearOpenaiApiKey: true } }).then(renderSettings).catch(oops));
  document.getElementById('kill-switch').addEventListener('click', () =>
    api('/admin/settings', { method: 'POST', body: { aiDisabled: !s.aiDisabled } }).then(renderSettings).catch(oops));
}

async function renderMailbox() {
  const data = await api('/admin/mailbox');
  view.innerHTML = `
    <h1>Admin</h1>${tabsBar('mailbox')}
    <div id="msg"></div>
    <p class="muted small">Outbound email captured locally (mailbox mode). Use this to find verification and reset links during the pilot.</p>
    <div class="stack">
      ${data.emails.map((m) => `
        <div class="card">
          <strong>${esc(m.subject)}</strong> <span class="muted small">to ${esc(m.to_email)} · ${esc(fmtDate(m.created_at))}</span>
          <div class="msg system"><div class="body">${esc(m.body)}</div></div>
        </div>`).join('') || '<div class="card"><p class="muted">No mail yet.</p></div>'}
    </div>`;
  wireTabs();
}

async function renderKnowledge() {
  const data = await api('/knowledge/sources');
  view.innerHTML = `
    <h1>Admin</h1>${tabsBar('knowledge')}
    <div id="msg"></div>
    <div class="card">
      <h3>Add a knowledge source</h3>
      <p class="hint">Paste the text of an approved source (e.g. an Acas guide section, NHS TCS section, Trust policy). It is chunked and becomes retrievable with citations.</p>
      <form id="add-source">
        <label for="ks-title">Title</label><input id="ks-title" type="text" required>
        <label for="ks-publisher">Publisher</label><input id="ks-publisher" type="text" placeholder="e.g. Acas, NHS Employers">
        <label for="ks-type">Source type</label>
        <select id="ks-type">${data.sourceTypes.map((t) => `<option value="${t}">${t.replace('_', ' ')}</option>`).join('')}</select>
        <label for="ks-url">Canonical URL</label><input id="ks-url" type="text">
        <label for="ks-version">Version label</label><input id="ks-version" type="text" value="v1">
        <label for="ks-effective">Effective from</label><input id="ks-effective" type="date">
        <label for="ks-content">Source text</label><textarea id="ks-content" required></textarea>
        <p><button class="btn" type="submit">Add source</button></p>
      </form>
    </div>
    <div class="table-scroll"><table class="data">
      <tr><th>Title</th><th>Publisher</th><th>Type</th><th>Current version</th><th>Chunks</th><th>New version</th></tr>
      ${data.sources.map((s) => `
        <tr>
          <td>${esc(s.title)}${s.canonical_url ? `<br><a class="small" href="${esc(s.canonical_url)}" target="_blank" rel="noopener">source link</a>` : ''}</td>
          <td>${esc(s.publisher)}</td><td>${esc(s.source_type)}</td>
          <td>${esc(s.current_version || '—')} <span class="muted small">(${s.version_count})</span></td>
          <td>${s.chunk_count}</td>
          <td><button class="btn small quiet" data-newver="${s.id}">Supersede…</button></td>
        </tr>`).join('')}
    </table></div>
    <div id="newver-area"></div>`;
  wireTabs();
  document.getElementById('add-source').addEventListener('submit', (e) => {
    e.preventDefault();
    api('/knowledge/sources', {
      method: 'POST',
      body: {
        title: document.getElementById('ks-title').value,
        publisher: document.getElementById('ks-publisher').value,
        sourceType: document.getElementById('ks-type').value,
        url: document.getElementById('ks-url').value,
        versionLabel: document.getElementById('ks-version').value,
        effectiveFrom: document.getElementById('ks-effective').value,
        content: document.getElementById('ks-content').value,
      },
    }).then(renderKnowledge).catch(oops);
  });
  view.querySelectorAll('[data-newver]').forEach((b) =>
    b.addEventListener('click', () => {
      document.getElementById('newver-area').innerHTML = `
        <div class="card">
          <h3>New version for source #${b.dataset.newver}</h3>
          <p class="hint">The current version is retained and marked superseded (still auditable, excluded from new answers).</p>
          <form id="newver-form">
            <label for="nv-label">Version label</label><input id="nv-label" type="text" required>
            <label for="nv-effective">Effective from</label><input id="nv-effective" type="date">
            <label for="nv-content">Source text</label><textarea id="nv-content" required></textarea>
            <p><button class="btn" type="submit">Add version</button></p>
          </form>
        </div>`;
      document.getElementById('newver-form').addEventListener('submit', (e) => {
        e.preventDefault();
        api(`/knowledge/sources/${b.dataset.newver}/versions`, {
          method: 'POST',
          body: {
            versionLabel: document.getElementById('nv-label').value,
            effectiveFrom: document.getElementById('nv-effective').value,
            content: document.getElementById('nv-content').value,
          },
        }).then(renderKnowledge).catch(oops);
      });
      window.scrollTo(0, document.body.scrollHeight);
    }));
}

async function renderAudit() {
  const data = await api('/admin/audit');
  view.innerHTML = `
    <h1>Admin</h1>${tabsBar('audit')}
    <div id="msg"></div>
    <div class="table-scroll"><table class="data">
      <tr><th>When</th><th>Actor</th><th>Action</th><th>Object</th><th>Detail</th></tr>
      ${data.events.map((e) => `
        <tr>
          <td class="small">${esc(fmtDate(e.created_at))}</td>
          <td class="small">${esc(e.actor_email || 'system')}</td>
          <td>${esc(e.action)}</td>
          <td class="small">${esc(e.object_type)} ${esc(e.object_id)}</td>
          <td class="small muted">${esc(e.meta === '{}' ? '' : e.meta)}</td>
        </tr>`).join('')}
    </table></div>`;
  wireTabs();
}

async function route(tab) {
  const first = can(user, 'users.manage') ? 'users'
    : canUseAssistant() ? 'assistant'
    : can(user, 'system.admin') ? 'settings'
    : can(user, 'knowledge.manage') ? 'knowledge' : 'audit';
  const target = tab || first;
  try {
    if (target === 'users') await renderUsers();
    else if (target === 'assistant') await renderAssistant();
    else if (target === 'settings') await renderSettings();
    else if (target === 'mailbox') await renderMailbox();
    else if (target === 'knowledge') await renderKnowledge();
    else await renderAudit();
  } catch (err) {
    view.innerHTML = `<h1>Admin</h1>${tabsBar('')}<div class="notice error">${esc(err.message)}</div>`;
    wireTabs();
  }
}

user = await requireUser('admin');
if (user) {
  if (!can(user, 'users.manage') && !can(user, 'system.admin') && !can(user, 'knowledge.manage') && !can(user, 'audit.view') && !canUseAssistant()) {
    view.innerHTML = '<div class="notice error">Your account does not have access to this area.</div>';
  } else {
    route();
  }
}
