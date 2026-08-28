import { api, esc, fmtDate, requireUser, can } from '/common.js';
import { enterView, stagger, toast, setBusy, countUp, skelTable, emptyState } from '/ui.js';

const view = document.getElementById('view');
let user;

function canUseAssistant() {
  return ['users.manage', 'cases.review', 'knowledge.manage'].some((p) => can(user, p));
}

const TAB_DEFS = () => {
  const tabs = [['overview', 'Overview']];
  if (can(user, 'users.manage')) tabs.push(['users', 'Users & permissions']);
  if (canUseAssistant()) tabs.push(['assistant', 'Assistant']);
  if (can(user, 'system.admin')) tabs.push(['settings', 'AI settings'], ['mailbox', 'Dev mailbox']);
  if (can(user, 'knowledge.manage')) tabs.push(['knowledge', 'Knowledge sources']);
  if (can(user, 'audit.view')) tabs.push(['audit', 'Audit log']);
  return tabs;
};

function tabsBar(active) {
  return `<div class="tabs">${TAB_DEFS().map(([id, label]) => `<button data-tab="${id}" class="${id === active ? 'active' : ''}">${label}</button>`).join('')}</div>`;
}

function wireTabs() {
  view.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => { window.location.hash = `#/${b.dataset.tab}`; }));
}

const oops = (err) => {
  const msg = document.getElementById('msg');
  if (msg) msg.innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  window.scrollTo(0, 0);
};

// ── Overview ─────────────────────────────────────────────────────────────
async function renderOverview() {
  view.innerHTML = `<h1>Admin</h1>${tabsBar('overview')}${skelTable(3)}`;
  wireTabs();

  const wants = [];
  if (can(user, 'users.manage')) wants.push(['users', api('/admin/users')]);
  if (can(user, 'cases.review')) wants.push(['queue', api('/advisor/queue?view=all')]);
  if (can(user, 'system.admin')) wants.push(['settings', api('/admin/settings')]);
  else if (canUseAssistant()) wants.push(['assistant', api('/admin/assistant')]);
  if (can(user, 'knowledge.manage')) wants.push(['knowledge', api('/knowledge/sources')]);
  if (can(user, 'audit.view')) wants.push(['audit', api('/admin/audit')]);

  const results = Object.fromEntries(
    (await Promise.allSettled(wants.map(([, p]) => p))).map((r, i) => [wants[i][0], r.status === 'fulfilled' ? r.value : null])
  );

  const tiles = [];
  if (results.users) {
    const u = results.users.users;
    tiles.push({ hash: '#/users', num: u.length, label: `member account${u.length === 1 ? '' : 's'} · ${u.filter((x) => !x.emailVerified).length} unverified` });
  }
  if (results.queue) {
    const counts = results.queue.counts;
    const openCount = (counts.all ?? 0) - (counts.closed ?? 0);
    tiles.push({ href: '/advisor.html', num: openCount, label: `open case${openCount === 1 ? '' : 's'} · ${counts.urgent ?? 0} urgent` });
  }
  if (results.settings) {
    tiles.push({ hash: '#/settings', num: results.settings.aiConfigured ? 'ON' : 'OFF', label: results.settings.aiDisabled ? '⚠ AI kill switch is ON' : `AI ${results.settings.aiConfigured ? `ready (${esc(results.settings.aiModel)})` : '— no API key'}`, alert: results.settings.aiDisabled || !results.settings.aiConfigured });
  } else if (results.assistant) {
    tiles.push({ hash: '#/assistant', num: results.assistant.enabled ? 'ON' : 'OFF', label: results.assistant.enabled ? 'assistant ready' : 'assistant unavailable', alert: !results.assistant.enabled });
  }
  if (results.knowledge) {
    const n = results.knowledge.sources.length;
    tiles.push({ hash: '#/knowledge', num: n, label: `knowledge source${n === 1 ? '' : 's'}` });
  }

  view.innerHTML = `
    <h1>Admin</h1>${tabsBar('overview')}
    <div id="msg"></div>
    <div class="stat-grid" id="stat-grid">
      ${tiles.map((t) => `
        <a class="stat-tile" href="${t.href || `${t.hash}`}">
          <div class="stat-num ${t.alert ? 'muted' : ''}">${t.num}</div>
          <div class="stat-label">${t.label}</div>
        </a>`).join('') || '<p class="muted">Nothing your permissions can summarise here.</p>'}
    </div>
    ${results.audit ? `
      <div class="card">
        <h3 class="mt0">Latest activity</h3>
        ${results.audit.events.slice(0, 5).map((e) => `
          <p class="small mt0"><span class="muted">${esc(fmtDate(e.created_at))}</span> · ${esc(e.actor_email || 'system')} · <strong>${esc(e.action)}</strong></p>`).join('')}
        <p class="small right"><a href="#/audit">Full audit log →</a></p>
      </div>` : ''}`;
  enterView(view);
  wireTabs();
  stagger(document.getElementById('stat-grid'), '.stat-tile');
  view.querySelectorAll('.stat-num').forEach((n) => { if (/^\d+$/.test(n.textContent)) countUp(n, n.textContent); });
}

// ── Users & permissions ──────────────────────────────────────────────────
async function renderUsers() {
  view.innerHTML = `<h1>Admin</h1>${tabsBar('users')}${skelTable(4)}`;
  wireTabs();
  const data = await api('/admin/users');
  const permKeys = Object.keys(data.permissionCatalog);
  view.innerHTML = `
    <h1>Admin</h1>${tabsBar('users')}
    <div id="msg"></div>
    <p class="muted small">Roles carry default permissions; per-account overrides grant or revoke individual permissions on top. The main administration account cannot be modified. Only the main administration account can grant or remove the <strong>admin</strong> role and administrative permissions.</p>
    <div class="stack" id="user-list">
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
          ${permKeys.map((p) => {
            const override = u.overrides.find((o) => o.permission === p);
            const effective = u.effectivePermissions.includes(p);
            const disabled = u.isMainAdmin ? 'disabled' : '';
            return `<div class="perm-item">
              <div class="perm-head">
                <span>${effective ? '✅' : '<span class="muted">—</span>'} <strong>${esc(p)}</strong>
                  ${override ? `<span class="tag ${override.mode === 'grant' ? 'role' : 'high'}">${override.mode}</span>` : ''}</span>
                <span class="seg">
                  <button type="button" class="${override?.mode === 'grant' ? 'on' : ''}" data-perm="${p}" data-mode="grant" data-uid="${u.id}" ${disabled}>Grant</button>
                  <button type="button" class="${override?.mode === 'revoke' ? 'on' : ''}" data-perm="${p}" data-mode="revoke" data-uid="${u.id}" ${disabled}>Revoke</button>
                  <button type="button" class="${!override ? 'on' : ''}" data-perm="${p}" data-mode="clear" data-uid="${u.id}" ${disabled}>Default</button>
                </span>
              </div>
              <div class="muted small">${esc(data.permissionCatalog[p])}</div>
            </div>`;
          }).join('')}
        </details>
        ${u.isMainAdmin || u.id === user.id ? '' : `<p class="right"><button class="btn small ${u.status === 'active' ? 'danger' : ''}" data-status="${u.status === 'active' ? 'disabled' : 'active'}" data-uid="${u.id}">${u.status === 'active' ? 'Disable account' : 'Enable account'}</button></p>`}
      </div>`).join('')}
    </div>`;
  enterView(view);
  wireTabs();
  stagger(document.getElementById('user-list'), '.card');

  view.querySelectorAll('[data-role]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.action === 'remove' && !window.confirm(`Remove the "${b.dataset.role}" role?`)) return;
      api(`/admin/users/${b.dataset.uid}/roles`, { method: 'POST', body: { role: b.dataset.role, action: b.dataset.action } })
        .then(() => { toast('ok', `Role ${b.dataset.action === 'add' ? 'granted' : 'removed'}.`); renderUsers(); })
        .catch(oops);
    }));
  view.querySelectorAll('[data-perm]').forEach((b) =>
    b.addEventListener('click', () =>
      api(`/admin/users/${b.dataset.uid}/permissions`, { method: 'POST', body: { permission: b.dataset.perm, mode: b.dataset.mode } })
        .then(() => { toast('ok', 'Permissions updated.'); renderUsers(); })
        .catch(oops)));
  view.querySelectorAll('[data-status]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.status === 'disabled' && !window.confirm('Disable this account? They will be signed out everywhere.')) return;
      api(`/admin/users/${b.dataset.uid}/status`, { method: 'POST', body: { status: b.dataset.status } })
        .then(() => { toast('ok', `Account ${b.dataset.status}.`); renderUsers(); })
        .catch(oops);
    }));
}

// ── Assistant ────────────────────────────────────────────────────────────
async function renderAssistant() {
  view.innerHTML = `
    <h1>Admin</h1>${tabsBar('assistant')}
    <div id="msg"></div>
    <p class="small muted">Ask about accounts, the case queue, deadlines or knowledge sources. Any change it suggests — including drafted member messages — becomes a proposed action you review, correct if needed, and approve. Tabs are separate conversations for multitasking.</p>
    <div class="assistant-embed" id="assistant-embed"></div>`;
  enterView(view);
  wireTabs();
  const { createChatUI } = await import('/assistant-widget.js');
  createChatUI(document.getElementById('assistant-embed'));
}

// ── Settings / mailbox ───────────────────────────────────────────────────
async function renderSettings() {
  view.innerHTML = `<h1>Admin</h1>${tabsBar('settings')}${skelTable(3)}`;
  wireTabs();
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
  enterView(view);
  wireTabs();
  document.getElementById('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    setBusy(btn, true);
    const body = { aiModel: document.getElementById('aiModel').value };
    const key = document.getElementById('apiKey').value.trim();
    if (key) body.openaiApiKey = key;
    api('/admin/settings', { method: 'POST', body })
      .then(() => { toast('ok', 'Settings saved.'); renderSettings(); })
      .catch((err) => { setBusy(btn, false); oops(err); });
  });
  document.getElementById('clear-key')?.addEventListener('click', () => {
    if (!window.confirm('Remove the stored OpenAI API key? AI features will stop until a new key is added.')) return;
    api('/admin/settings', { method: 'POST', body: { clearOpenaiApiKey: true } })
      .then(() => { toast('ok', 'API key removed.'); renderSettings(); }).catch(oops);
  });
  document.getElementById('kill-switch').addEventListener('click', () =>
    api('/admin/settings', { method: 'POST', body: { aiDisabled: !s.aiDisabled } })
      .then(() => { toast('ok', s.aiDisabled ? 'AI re-enabled.' : 'AI generation disabled.'); renderSettings(); }).catch(oops));
}

async function renderMailbox() {
  view.innerHTML = `<h1>Admin</h1>${tabsBar('mailbox')}${skelTable(3)}`;
  wireTabs();
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
  enterView(view);
  wireTabs();
}

// ── Knowledge ────────────────────────────────────────────────────────────
async function renderKnowledge() {
  view.innerHTML = `<h1>Admin</h1>${tabsBar('knowledge')}${skelTable(3)}`;
  wireTabs();
  const data = await api('/knowledge/sources');
  view.innerHTML = `
    <h1>Admin</h1>${tabsBar('knowledge')}
    <div id="msg"></div>
    <details class="card">
      <summary><strong>Add a knowledge source</strong></summary>
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
    </details>
    <div class="stack" id="source-list">
      ${data.sources.map((s) => `
        <div class="card" data-source="${s.id}">
          <h3 class="mt0">${esc(s.title)} <span class="muted small">${esc(s.publisher)}</span></h3>
          <p class="small mt0"><span class="tag">${esc(s.source_type.replace('_', ' '))}</span>
            <span class="tag status">${esc(s.current_version || '—')}</span>
            <span class="muted small">${s.chunk_count} chunks · ${s.version_count} version${s.version_count === 1 ? '' : 's'}</span>
            ${s.canonical_url ? ` · <a class="small" href="${esc(s.canonical_url)}" target="_blank" rel="noopener">source link</a>` : ''}</p>
          <p class="mt0"><button class="btn small quiet" data-newver="${s.id}">Supersede…</button></p>
          <div class="newver-slot hidden" data-slot="${s.id}"></div>
        </div>`).join('') || emptyState({ icon: 'file', title: 'No knowledge sources yet', body: 'Add approved guidance so AI answers can cite real sources.' })}
    </div>`;
  enterView(view);
  wireTabs();
  document.getElementById('add-source').addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    setBusy(btn, true);
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
    }).then(() => { toast('ok', 'Source added.'); renderKnowledge(); })
      .catch((err) => { setBusy(btn, false); oops(err); });
  });
  view.querySelectorAll('[data-newver]').forEach((b) =>
    b.addEventListener('click', () => {
      const slot = view.querySelector(`[data-slot="${b.dataset.newver}"]`);
      slot.classList.toggle('hidden');
      if (!slot.classList.contains('hidden') && !slot.innerHTML) {
        slot.innerHTML = `
          <p class="hint">The current version is retained and marked superseded (still auditable, excluded from new answers).</p>
          <form data-newver-form="${b.dataset.newver}">
            <label>Version label</label><input name="label" type="text" required>
            <label>Effective from</label><input name="effective" type="date">
            <label>Source text</label><textarea name="content" required></textarea>
            <p><button class="btn small" type="submit">Add version</button></p>
          </form>`;
        slot.querySelector('form').addEventListener('submit', (e) => {
          e.preventDefault();
          const btn2 = e.target.querySelector('button');
          setBusy(btn2, true);
          api(`/knowledge/sources/${b.dataset.newver}/versions`, {
            method: 'POST',
            body: {
              versionLabel: e.target.elements.label.value,
              effectiveFrom: e.target.elements.effective.value,
              content: e.target.elements.content.value,
            },
          }).then(() => { toast('ok', 'Version added — previous version superseded.'); renderKnowledge(); })
            .catch((err) => { setBusy(btn2, false); oops(err); });
        });
      }
    }));
}

// ── Audit ────────────────────────────────────────────────────────────────
async function renderAudit() {
  view.innerHTML = `<h1>Admin</h1>${tabsBar('audit')}${skelTable(6)}`;
  wireTabs();
  const data = await api('/admin/audit');
  view.innerHTML = `
    <h1>Admin</h1>${tabsBar('audit')}
    <div id="msg"></div>
    <p><input type="search" id="audit-filter" placeholder="Filter by actor or action…" aria-label="Filter audit log"></p>
    <div class="table-scroll audit-table"><table class="data">
      <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Object</th><th>Detail</th></tr></thead>
      <tbody>
      ${data.events.map((e) => `
        <tr data-blob="${esc(`${e.actor_email || 'system'} ${e.action}`.toLowerCase())}">
          <td class="small">${esc(fmtDate(e.created_at))}</td>
          <td class="small">${esc(e.actor_email || 'system')}</td>
          <td><strong>${esc(e.action)}</strong></td>
          <td class="small">${esc(e.object_type)} ${esc(e.object_id)}</td>
          <td class="small muted">${esc(e.meta === '{}' ? '' : e.meta)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
  enterView(view);
  wireTabs();
  document.getElementById('audit-filter').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    view.querySelectorAll('tbody tr').forEach((row) => {
      row.classList.toggle('hidden', q !== '' && !row.dataset.blob.includes(q));
    });
  });
}

// ── Router ───────────────────────────────────────────────────────────────
async function route() {
  const available = TAB_DEFS().map(([id]) => id);
  const target = (window.location.hash.match(/^#\/(\w+)/) || [])[1];
  const tab = available.includes(target) ? target : 'overview';
  try {
    if (tab === 'overview') await renderOverview();
    else if (tab === 'users') await renderUsers();
    else if (tab === 'assistant') await renderAssistant();
    else if (tab === 'settings') await renderSettings();
    else if (tab === 'mailbox') await renderMailbox();
    else if (tab === 'knowledge') await renderKnowledge();
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
    window.addEventListener('hashchange', route);
    route();
  }
}
