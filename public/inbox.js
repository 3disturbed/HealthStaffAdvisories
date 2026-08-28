// Inbox — the merged home for both feeds that used to be the Alerts sheet:
// Messages (two-way contact threads) and Updates (notification rows).
//
// One page serves every signed-in account. A plain member sees their own
// threads; an account holding contact.review sees the staff queue instead.
// The server decides which, so the UI only has to render what came back.
import { api, can, el, esc, fmtDate, requireUser, showNotice } from '/common.js';
import { enterView, stagger, setBusy, emptyState, skelCases, skelTable } from '/ui.js';

const view = document.getElementById('view');
let user;

const STAFF_VIEWS = [
  ['unanswered', 'Needs a reply'],
  ['urgent', 'Urgent'],
  ['open', 'Open'],
  ['closed', 'Closed'],
  ['all', 'All'],
];
const STATUS_LABELS = {
  new: 'New',
  open: 'Open',
  answered: 'Answered',
  closed: 'Closed',
};

const TAB_DEFS = () => [['messages', 'Messages'], ['updates', 'Updates']];

function activeTab() {
  const ids = TAB_DEFS().map(([id]) => id);
  const target = (window.location.hash.match(/^#\/([\w-]+)/) || [])[1];
  return ids.includes(target) ? target : ids[0];
}

function shell(active, body) {
  return `
    <h1>Inbox</h1>
    <div id="msg"></div>
    <div class="tabs scroll" role="tablist" aria-label="Inbox sections">
      ${TAB_DEFS().map(([id, label]) => `<button type="button" role="tab" id="tab-${id}" data-tab="${id}"
        aria-controls="panel" aria-selected="${id === active}" tabindex="${id === active ? '0' : '-1'}"
        class="${id === active ? 'active' : ''}">${label}</button>`).join('')}
    </div>
    <div id="panel" role="tabpanel" aria-labelledby="tab-${active}">${body}</div>`;
}

// Roving focus, copied from the account page.
function wireTabs() {
  const bar = view.querySelector('[role="tablist"]');
  if (!bar) return;
  const btns = [...bar.querySelectorAll('[data-tab]')];
  btns.forEach((b) => {
    b.addEventListener('click', () => { window.location.hash = `#/${b.dataset.tab}`; });
    b.addEventListener('keydown', (e) => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const i = btns.indexOf(b);
      const next = e.key === 'Home' ? btns[0]
        : e.key === 'End' ? btns[btns.length - 1]
        : btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length];
      next.click();
    });
  });
}

function paint(tab, body, animate = false) {
  const hadFocus = !!document.activeElement?.closest?.('[role="tablist"]');
  view.innerHTML = shell(tab, body);
  wireTabs();
  if (hadFocus) view.querySelector('[role="tab"][aria-selected="true"]')?.focus();
  if (animate) enterView(el('panel'));
}

const oops = (err) => {
  const box = el('msg');
  if (box) showNotice(box, 'error', err.message);
  else view.innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  window.scrollTo(0, 0);
};

// ── Messages ─────────────────────────────────────────────────────────────
function urgencyTag(t) {
  if (t.urgency === 'critical') return '<span class="tag critical">Urgent</span> ';
  if (t.urgency === 'high') return '<span class="tag high">Priority</span> ';
  return '';
}

function threadCardHtml(t, staff) {
  const who = staff ? `${esc(t.senderName)}${t.anonymous ? ' (no account)' : ''} &middot; ` : '';
  return `
    <a class="case-card ${t.unread ? 'unread' : ''}" href="#/thread/${t.id}">
      <h3>${urgencyTag(t)}${esc(t.subject)}</h3>
      <div class="meta">${who}${esc(t.topicLabel)} &middot;
        <span class="tag status">${esc(STATUS_LABELS[t.status] || t.status)}</span>
        &middot; ${esc(fmtDate(t.lastMessageAt))}</div>
    </a>`;
}

async function renderMessages(which) {
  paint('messages', skelCases(3));
  const data = await api(`/messages?view=${encodeURIComponent(which || 'unanswered')}`);
  const staff = data.scope === 'staff';
  const filters = staff
    ? `<div class="tabs">${STAFF_VIEWS.map(([id, label]) =>
        `<button type="button" data-view="${id}" class="${id === data.view ? 'active' : ''}">${label} (${data.counts[id] ?? 0})</button>`).join('')}</div>`
    : '';
  const list = data.threads.length
    ? `<div class="case-list" id="thread-list">${data.threads.map((t) => threadCardHtml(t, staff)).join('')}</div>`
    : emptyState({
        icon: 'inboxCheck',
        title: staff ? 'Nothing in this view' : 'No messages yet',
        body: staff ? '' : 'Messages you send us, and our replies, appear here.',
        actionHref: staff ? '' : '/contact.html',
        actionLabel: staff ? '' : 'Send us a message',
      });

  paint('messages', filters + list, true);
  const listEl = el('thread-list');
  if (listEl) stagger(listEl, '.case-card');
  view.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      window.history.replaceState(null, '', `#/messages/${b.dataset.view}`);
      renderMessages(b.dataset.view).catch(oops);
    }));
}

function bubble(m, staff) {
  // "Mine" flips with the reader: to an adviser the advisor bubbles are theirs.
  const mine = staff ? m.authorRole === 'advisor' : m.authorRole === 'sender';
  const who = m.authorRole === 'advisor'
    ? `${esc(m.authorName || 'Health Staff Advisory')} (adviser)`
    : esc(m.authorName || 'Sender');
  return `
    <div class="msg ${mine ? 'member' : 'advisor'}">
      <div class="who">${who} &middot; ${esc(fmtDate(m.createdAt))}</div>
      <div class="body">${esc(m.body)}</div>
    </div>`;
}

async function renderThread(id) {
  paint('messages', skelCases(1));
  const data = await api(`/messages/${id}`);
  const staff = data.canReview;
  const t = data.thread;
  const closed = t.status === 'closed';
  const triage = staff
    ? `<div class="card">
         <h3 class="mt0">Triage</h3>
         <label for="status">Status</label>
         <select id="status">${Object.entries(STATUS_LABELS).map(([id2, label]) =>
           `<option value="${id2}" ${id2 === t.status ? 'selected' : ''}>${label}</option>`).join('')}</select>
         <label for="urgency">Urgency</label>
         <select id="urgency">${['critical', 'high', 'normal'].map((u) =>
           `<option value="${u}" ${u === t.urgency ? 'selected' : ''}>${u}</option>`).join('')}</select>
         <p><button class="btn small quiet" type="button" id="save-triage">Save</button></p>
       </div>`
    : '';

  paint('messages', `
    <p><a href="#/messages">&larr; Back to messages</a></p>
    <h2 class="mt0">${urgencyTag(t)}${esc(t.subject)}</h2>
    <p class="muted">${esc(t.topicLabel)} &middot;
      ${staff ? `${esc(t.senderName)} &lt;${esc(t.senderEmail || '')}&gt; &middot; ` : ''}
      started ${esc(fmtDate(t.createdAt))}</p>
    ${t.urgencyReason ? `<div class="notice warn">${esc(t.urgencyReason)}</div>` : ''}
    ${triage}
    <div id="thread">${data.messages.map((m) => bubble(m, staff)).join('')}</div>
    ${closed
      ? '<div class="notice info">This conversation is closed.</div>'
      : `<div class="card">
           <form id="reply-form">
             <label for="body">${staff ? 'Reply to the sender' : 'Reply'}</label>
             <textarea id="body" rows="6" maxlength="5000" required></textarea>
             <p><button class="btn" type="submit">Send reply</button></p>
           </form>
         </div>`}`, true);

  const form = el('reply-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      setBusy(btn, true);
      try {
        const res = await api(`/messages/${id}/reply`, { method: 'POST', body: { body: el('body').value } });
        el('thread').innerHTML = res.messages.map((m) => bubble(m, staff)).join('');
        el('body').value = '';
        setBusy(btn, false);
        showNotice(el('msg'), 'ok', 'Reply sent.');
      } catch (err) {
        setBusy(btn, false);
        oops(err);
      }
    });
  }

  const save = el('save-triage');
  if (save) {
    save.addEventListener('click', async () => {
      setBusy(save, true);
      try {
        await api(`/messages/${id}/status`, {
          method: 'POST',
          body: { status: el('status').value, urgency: el('urgency').value },
        });
        renderThread(id).catch(oops);
      } catch (err) {
        setBusy(save, false);
        oops(err);
      }
    });
  }
}

// ── Updates ──────────────────────────────────────────────────────────────
// The list that used to live in the Alerts bottom sheet, now with a third
// deep-link target: message threads.
async function renderUpdates() {
  paint('updates', skelTable(4));
  const { notifications } = await api('/notifications');
  const caseBase = can(user, 'cases.review') ? '/advisor.html#/case/' : '/portal.html#/case/';
  const jeBase = can(user, 'je.review') ? '/advisor.html#/banding/' : '/portal.html#/banding/';
  const href = (n) => n.thread_id ? `/inbox.html#/thread/${n.thread_id}`
    : n.je_review_id ? `${jeBase}${n.je_review_id}`
    : n.case_id ? `${caseBase}${n.case_id}` : '#';

  paint('updates', notifications.length
    ? `<div class="stagger-list" id="updates-list">${notifications.map((n) => `
        <a class="notif-item ${n.read_at ? '' : 'unread'}" href="${href(n)}">
          ${esc(n.title)}${n.body ? `<span class="muted small"> &mdash; ${esc(n.body)}</span>` : ''}
          <div class="muted small">${esc(fmtDate(n.created_at))}</div>
        </a>`).join('')}</div>`
    : emptyState({ icon: 'inboxCheck', title: 'Nothing yet', body: 'Updates about your cases appear here.' }), true);

  const list = el('updates-list');
  if (list) stagger(list, '.notif-item');
  // Opening the tab marks the update feed read, exactly as the sheet did.
  api('/notifications/read', { method: 'POST' }).catch(() => {});
}

// ── Router ───────────────────────────────────────────────────────────────
async function route() {
  const hash = window.location.hash || '#/';
  try {
    const threadMatch = hash.match(/^#\/thread\/(\d+)$/);
    const listMatch = hash.match(/^#\/messages(?:\/(\w+))?$/);
    if (threadMatch) await renderThread(Number(threadMatch[1]));
    else if (activeTab() === 'updates') await renderUpdates();
    else await renderMessages(listMatch?.[1]);
  } catch (err) {
    oops(err);
  }
  window.scrollTo(0, 0);
}

user = await requireUser('inbox');
if (user) {
  window.addEventListener('hashchange', route);
  route();
}
