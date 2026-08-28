// Public contact form. This is the replacement for the mailto: that used to
// sit on the home page and the privacy notice, so it must work with no
// session at all — renderNav(), never requireUser(), and no #tab-bar (see the
// note at the top of /faq.js).
import { api, currentUser, esc, escAttr, renderNav, showNotice } from '/common.js';
import { enterView, setBusy } from '/ui.js';

const card = document.getElementById('form-card');
const msg = document.getElementById('msg');

const TOPICS = [
  ['general', 'General question'],
  ['pilot', 'Pilot access'],
  ['data_rights', 'Data export or deletion'],
  ['billing', 'Membership and billing'],
  ['other', 'Something else'],
];

// The privacy notice links in with ?topic=data_rights so someone exercising
// their data rights lands on the right topic already selected.
function requestedTopic() {
  const want = new URLSearchParams(window.location.search).get('topic') || '';
  return TOPICS.some(([id]) => id === want) ? want : 'general';
}

function formHtml(user) {
  const topic = requestedTopic();
  const identity = user
    ? `<p class="hint">Sending as <strong>${esc(user.displayName)}</strong> (${esc(user.email)}). We will reply in your <a href="/inbox.html">Inbox</a>.</p>`
    : `<label for="name">Your name</label>
       <input id="name" name="name" type="text" autocomplete="name" maxlength="120" required>
       <label for="email">Your email address</label>
       <p class="hint">We reply by sending you a link to a private page &mdash; we never put the reply itself in an email.</p>
       <input id="email" name="email" type="email" autocomplete="email" maxlength="120" required>`;
  return `
    <form id="contact-form" novalidate>
      ${identity}
      <label for="topic">What is this about?</label>
      <select id="topic" name="topic">
        ${TOPICS.map(([id, label]) =>
          `<option value="${escAttr(id)}" ${id === topic ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      </select>
      <label for="subject">Subject</label>
      <input id="subject" name="subject" type="text" maxlength="200" required>
      <label for="message">Your message</label>
      <p class="hint">Please do not include patient-identifiable information.</p>
      <textarea id="message" name="message" rows="8" maxlength="5000" required></textarea>
      <div class="sr-only" aria-hidden="true">
        <label for="website">Leave this field empty</label>
        <input id="website" name="website" type="text" tabindex="-1" autocomplete="off">
      </div>
      <p><button class="btn" type="submit">Send message</button></p>
    </form>`;
}

// Deterministic keyword rules on the server decide this. A public form is
// reachable by someone in crisis who has no account, so when they trip we
// lead the confirmation with the routes that can actually help today.
function signpostHtml() {
  return `
    <div class="notice error">
      <strong>If you are in immediate danger, call 999.</strong>
      If you are struggling to cope, the Samaritans are available 24/7 on <strong>116 123</strong>.
      Some employment deadlines are also very short &mdash; Acas early conciliation is on
      <strong>0300 123 1100</strong>. See <a href="/emergency.html">urgent help</a>.
    </div>`;
}

function confirmation(data) {
  const next = data.signedIn
    ? '<p>We have put it in your <a href="/inbox.html">Inbox</a>, and that is where our reply will appear.</p>'
    : '<p>We will email you a link to a private page where you can read our reply and answer it. <a href="/register.html">Create an account</a> to keep your messages in one place.</p>';
  // The page already carries a quiet standing notice; when the message itself
  // trips the crisis rules the fuller version replaces it rather than
  // repeating alongside it.
  if (data.signpost) document.getElementById('standing-signpost')?.remove();
  card.innerHTML = `
    ${data.signpost ? signpostHtml() : ''}
    <h2 class="mt0">Message sent</h2>
    <p>Thank you &mdash; an adviser will pick this up.</p>
    ${next}
    <p><a class="btn secondary" href="/">Back to the home page</a></p>`;
  enterView(card);
}

function wire(user) {
  const form = document.getElementById('contact-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    setBusy(btn, true);
    msg.innerHTML = '';
    try {
      const data = await api('/contact', {
        method: 'POST',
        body: {
          name: user ? undefined : document.getElementById('name').value,
          email: user ? undefined : document.getElementById('email').value,
          topic: document.getElementById('topic').value,
          subject: document.getElementById('subject').value,
          message: document.getElementById('message').value,
          website: document.getElementById('website').value,
        },
      });
      confirmation(data);
    } catch (err) {
      setBusy(btn, false);
      showNotice(msg, 'error', err.message);
    }
  });
}

await renderNav('contact');
const user = await currentUser();
card.innerHTML = formHtml(user);
enterView(card);
wire(user);
