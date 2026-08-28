// Public FAQ page. Anonymous-first: this page must render for someone with no
// account, so it calls renderNav() and NEVER requireUser() (which redirects to
// /login.html).
//
// renderNav is deliberately NOT awaited before the content renders. home.js
// awaits it because its content is static HTML; here the FAQ is the payload and
// must not wait on /api/auth/me. Anything user-dependent (the "Edit these
// answers" link) arrives with the second render as an enhancement.
//
// There is no #tab-bar element in faq.html, matching every other public page:
// currentTabId() falls through to the first href-bearing tab, so a signed-in
// member here would otherwise see Home highlighted on a page that is not Home.

import { esc, renderNav, currentUser } from '/common.js';
import { renderFaqSection, applyFaqHash } from '/faq-ui.js';

const view = document.getElementById('view');

async function route() {
  try {
    const user = await currentUser();
    await renderFaqSection(view, {
      user,
      hash: window.location.hash || '',
      linkBase: '',
      heading: 'Common questions',
      intro: "Answers written by Kelly's advisers. If yours is not here, start a case and ask.",
    });
  } catch (err) {
    view.innerHTML = `<div class="notice error">${esc(err.message)}</div>
      <p><a href="/">Back to home</a></p>`;
  }
}

renderNav('faq');
route();

// Entry toggles rewrite the hash with replaceState, which does not fire
// hashchange, so anything arriving here is a real navigation (a permalink
// pasted in, or Back). Apply it in place rather than re-fetching — that keeps
// already-opened entries open and costs no request.
window.addEventListener('hashchange', () => {
  applyFaqHash(view, window.location.hash || '', '');
});
