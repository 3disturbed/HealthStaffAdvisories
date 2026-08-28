// Magic-link thread view for someone with no account. The token arrives in
// the query string (same as /verify.html and /reset.html), is exchanged for
// the thread immediately, and is then wiped from the address bar so it does
// not linger in history, a screenshot or a shared link.
import { api, esc, fmtDate, renderNav, showNotice } from '/common.js';
import { enterView, setBusy } from '/ui.js';

const view = document.getElementById('view');
const token = new URLSearchParams(window.location.search).get('token') || '';

function bubble(m) {
  const mine = m.authorRole === 'sender';
  const who = mine ? 'You' : `${esc(m.authorName || 'Kelly Online')} (adviser)`;
  return `
    <div class="msg ${mine ? 'member' : 'advisor'}">
      <div class="who">${who} &middot; ${esc(fmtDate(m.createdAt))}</div>
      <div class="body">${esc(m.body)}</div>
    </div>`;
}

function expired(message) {
  view.innerHTML = `
    <h1>Message link</h1>
    <div class="notice error">${esc(message)}</div>
    <p>Links stay valid for 30 days. You can <a href="/contact.html">send us a new message</a> at any time.</p>`;
  enterView(view);
}

function render(data) {
  const closed = data.thread.status === 'closed';
  view.innerHTML = `
    <h1>${esc(data.thread.subject)}</h1>
    <p class="muted">${esc(data.thread.topicLabel)} &middot; started ${esc(fmtDate(data.thread.createdAt))}</p>
    <div id="thread">${data.messages.map(bubble).join('')}</div>
    <div id="msg"></div>
    ${closed
      ? '<div class="notice info">This conversation is closed. <a href="/contact.html">Send a new message</a> if you need anything else.</div>'
      : `<div class="card">
           <form id="reply-form">
             <label for="body">Reply</label>
             <textarea id="body" rows="6" maxlength="5000" required></textarea>
             <p><button class="btn" type="submit">Send reply</button></p>
           </form>
         </div>`}
    <p class="muted small">Keeping your messages in one place is easier with an account &mdash; <a href="/register.html">create one free</a>.</p>`;
  enterView(view);

  const form = document.getElementById('reply-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    setBusy(btn, true);
    try {
      const res = await api('/contact/thread/reply', { method: 'POST', body: { token, body: document.getElementById('body').value } });
      document.getElementById('thread').innerHTML = res.messages.map(bubble).join('');
      document.getElementById('body').value = '';
      setBusy(btn, false);
      showNotice(document.getElementById('msg'), 'ok', 'Reply sent.');
    } catch (err) {
      setBusy(btn, false);
      showNotice(document.getElementById('msg'), 'error', err.message);
    }
  });
}

await renderNav();
// Drop the token from the URL before anything else can capture it.
if (token) window.history.replaceState(null, '', '/thread.html');

if (!token) {
  expired('This link is missing its access code.');
} else {
  try {
    render(await api('/contact/thread', { method: 'POST', body: { token } }));
  } catch (err) {
    expired(err.message);
  }
}
