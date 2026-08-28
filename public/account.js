import { api, esc, escAttr, el, fmtDate, fmtDay, requireUser, can, hasAdminSurface, showNotice } from '/common.js';
import { installPanel, wireInstallPanel } from '/install-ui.js';
import { enterView, setBusy, toast, skelForm } from '/ui.js';

const view = document.getElementById('view');
let user;
// Fetched once at boot: gates the Membership tab and supplies the pay-band list
// to the Profile tab, so switching tabs never refetches it.
let membership = null;

const THEME_OPTIONS = [
  ['auto', 'Auto'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

const pounds = (pence) => `£${(pence / 100).toFixed(2)}`;

// ── tabs ─────────────────────────────────────────────────────────────────
const TAB_DEFS = () => {
  const tabs = [['profile', 'Profile']];
  if (membership) tabs.push(['membership', 'Membership']);
  tabs.push(['security', 'Security'], ['device', 'Device']);
  if (can(user, 'cases.own')) tabs.push(['cases', 'Cases']);
  else if (can(user, 'cases.review') || can(user, 'users.manage')) tabs.push(['links', 'Quick links']);
  return tabs;
};

function activeTab() {
  const ids = TAB_DEFS().map(([id]) => id);
  const target = (window.location.hash.match(/^#\/([\w-]+)/) || [])[1];
  return ids.includes(target) ? target : ids[0];
}

function shell(active, body) {
  return `
    <h1>Your account</h1>
    <div id="msg"></div>
    <div class="tabs scroll" role="tablist" aria-label="Account sections">
      ${TAB_DEFS().map(([id, label]) => `<button type="button" role="tab" id="tab-${id}" data-tab="${id}"
        aria-controls="panel" aria-selected="${id === active}" tabindex="${id === active ? '0' : '-1'}"
        class="${id === active ? 'active' : ''}">${label}</button>`).join('')}
    </div>
    <div id="panel" role="tabpanel" aria-labelledby="tab-${active}">${body}</div>`;
}

// Roving focus, matching the level-picker pattern in banding-advisor.js.
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
      next.click(); // re-render restores focus to the newly selected tab
    });
  });
}

// Repaint the page around one panel. `animate` is for the real content only,
// so the skeleton pass does not double up the page-enter animation.
function paint(tab, body, animate = false) {
  const hadFocus = !!document.activeElement?.closest?.('[role="tablist"]');
  view.innerHTML = shell(tab, body);
  wireTabs();
  if (hadFocus) view.querySelector('[role="tab"][aria-selected="true"]')?.focus();
  if (animate) enterView(el('panel'));
}

const oops = (err) => {
  const msg = el('msg');
  if (msg) showNotice(msg, 'error', err.message);
  window.scrollTo(0, 0);
};

// ── Profile ──────────────────────────────────────────────────────────────
async function renderProfile() {
  paint('profile', skelForm());
  const profile = await api('/account');
  const bands = membership?.payBands || {};

  paint('profile', `
    <div class="card">
      <h3>Profile</h3>
      <p class="small muted">${esc(profile.email)}</p>
      <form id="profile-form">
        <label for="displayName">Display name</label>
        <input id="displayName" type="text" value="${escAttr(profile.displayName)}" maxlength="80" required>
        ${Object.keys(bands).length ? `
        <label for="payBand">NHS pay band</label>
        ${profile.payBand ? '' : '<p class="hint">Please add your band — it keeps membership pricing fair across bands.</p>'}
        <select id="payBand">
          ${profile.payBand ? '' : '<option value="" selected disabled>Choose your band…</option>'}
          ${Object.entries(bands).map(([v, l]) =>
            `<option value="${escAttr(v)}" ${profile.payBand === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select>` : ''}
        <p><button class="btn small" type="submit">Save profile</button></p>
      </form>
    </div>

    <div class="card">
      <h3>Email notifications</h3>
      <p class="small muted">Case-update emails (never containing case details). In-app notifications stay on. Account emails such as password resets are always sent.</p>
      <p><label class="small"><input id="emailPref" type="checkbox" ${profile.emailNotifications ? 'checked' : ''}> Send me notification emails</label></p>
    </div>`, true);

  el('profile-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    setBusy(btn, true);
    const body = { displayName: el('displayName').value };
    if (el('payBand')?.value) body.payBand = el('payBand').value;
    api('/account/profile', { method: 'POST', body })
      .then(() => { toast('ok', 'Profile updated.'); setBusy(btn, false); })
      .catch((err) => { setBusy(btn, false); oops(err); });
  });

  el('emailPref').addEventListener('change', () => {
    api('/account/email-notifications', { method: 'POST', body: { enabled: el('emailPref').checked } })
      .then((r) => toast('ok', r.emailNotifications ? 'Notification emails on.' : 'Notification emails off.'))
      .catch(oops);
  });
}

// ── Membership ───────────────────────────────────────────────────────────
async function renderMembership() {
  paint('membership', skelForm());
  membership = await api('/membership');

  // Upgrade quotes for every active tier above the current one.
  const upgradable = membership.tiers.filter((t) =>
    t.active && t.id !== membership.tier?.id
    && t.rank > (membership.implicitPilot ? -1 : membership.tier.rank) && t.pricePence > 0);
  const quotes = {};
  for (const t of upgradable) {
    quotes[t.id] = await api(`/membership/quote/${t.id}`).catch(() => null);
  }

  // A balance under the Stripe minimum is applied outright; anything else
  // needs keys, so the button must not offer a checkout that will 503.
  const payable = (q) => q.autoApply || membership.stripeEnabled;

  paint('membership', `
    <div class="card">
      <h3>Membership</h3>
      <p>
        <span class="tag role">${esc(membership.tier?.name || 'Pilot')}</span>
        ${membership.subscription
          ? `<span class="small">renews ${esc(fmtDay(membership.subscription.periodEnd))}</span>`
          : '<span class="muted small">free during the pilot</span>'}
      </p>
      <p class="small muted">AI analyses: <strong>${membership.allowance.remaining} of ${membership.allowance.allowance}</strong> available in the next 24 hours${membership.allowance.nextFreeAt ? ` — next frees around ${esc(new Date(membership.allowance.nextFreeAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}` : ''}. Requests are never refused — if you run out, they queue and run automatically.</p>
      ${membership.costToValue && membership.costToValue.paidPence > 0
        ? `<p class="small muted">You've paid in ${pounds(membership.costToValue.paidPence)} over ${membership.costToValue.tenureDays} days — your loyalty counts towards upgrade discounts.</p>` : ''}
      ${upgradable.map((t) => {
        const q = quotes[t.id];
        if (!q || q.error) return '';
        const b = q.breakdown;
        return `
          <div class="perm-item">
            <div class="perm-head">
              <span><strong>${esc(t.name)}</strong> — ${pounds(q.amountPence)}${q.kind === 'upgrade' ? ' for the rest of your period' : ' for your first month'}</span>
              <button class="btn small" data-upgrade="${escAttr(t.id)}" ${payable(q) ? '' : 'disabled'}>${q.autoApply ? 'Upgrade free' : 'Upgrade'}</button>
            </div>
            <div class="muted small">
              ${q.kind === 'upgrade'
                ? `${pounds(b.targetProRataPence)} pro-rata − ${pounds(b.currentCreditPence)} unused ${esc(membership.tier.name)} credit`
                : `${pounds(t.pricePence)} per month`}
              ${b.discountPct > 0 ? ` − ${b.discountPct}% loyalty discount` : ''}
              ${q.kind === 'upgrade' ? ' · renewal date unchanged' : ''}
            </div>
          </div>`;
      }).join('')}
      ${upgradable.length && !membership.stripeEnabled ? '<p class="small muted">Payments are not switched on yet — upgrades will be available once the administrator connects Stripe.</p>' : ''}
    </div>`, true);

  view.querySelectorAll('[data-upgrade]').forEach((b) =>
    b.addEventListener('click', async () => {
      setBusy(b, true);
      try {
        const r = await api('/membership/checkout', { method: 'POST', body: { tier: b.dataset.upgrade } });
        if (r.applied) {
          toast('ok', 'Upgrade applied — enjoy your new membership.');
          renderMembership();
        } else if (r.url) {
          window.location.href = r.url; // Stripe-hosted Checkout
        }
      } catch (err) { setBusy(b, false); oops(err); }
    }));
}

// ── Security ─────────────────────────────────────────────────────────────
async function renderSecurity() {
  paint('security', skelForm());
  const { sessions } = await api('/account/sessions');

  paint('security', `
    <div class="card">
      <h3>Change password</h3>
      <form id="password-form">
        <label for="currentPassword">Current password</label>
        <input id="currentPassword" type="password" autocomplete="current-password" required>
        <label for="newPassword">New password</label>
        <p class="hint">At least 10 characters. Other devices are signed out when you change it.</p>
        <input id="newPassword" type="password" autocomplete="new-password" minlength="10" required>
        <p><button class="btn small" type="submit">Change password</button></p>
      </form>
    </div>

    <div class="card">
      <h3>Active sessions</h3>
      <div class="table-scroll"><table class="data">
        <tr><th>Signed in</th><th>Device</th><th>IP</th><th></th></tr>
        ${sessions.map((s) => `
          <tr>
            <td class="small">${esc(fmtDate(s.createdAt))}</td>
            <td class="small">${esc((s.userAgent || 'unknown').slice(0, 60))}</td>
            <td class="small">${esc(s.ip || '')}</td>
            <td>${s.current ? '<span class="tag role">this device</span>' : ''}</td>
          </tr>`).join('')}
      </table></div>
      ${sessions.length > 1 ? '<p><button class="btn small danger" id="revoke-others">Sign out everywhere else</button></p>' : ''}
    </div>`, true);

  el('password-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    setBusy(btn, true);
    api('/account/password', {
      method: 'POST',
      body: { currentPassword: el('currentPassword').value, newPassword: el('newPassword').value },
    })
      .then((r) => { toast('ok', r.message); renderSecurity(); })
      .catch((err) => { setBusy(btn, false); oops(err); });
  });

  el('revoke-others')?.addEventListener('click', (e) => {
    setBusy(e.target, true);
    api('/account/sessions/revoke-others', { method: 'POST' })
      .then((r) => { toast('ok', r.message); renderSecurity(); })
      .catch((err) => { setBusy(e.target, false); oops(err); });
  });
}

// ── Device ───────────────────────────────────────────────────────────────
async function renderDevice() {
  const themePref = window.__kellyThemePref ? window.__kellyThemePref() : 'auto';

  paint('device', `
    <div class="card">
      <h3>Appearance</h3>
      <p class="small muted">Applies to this device.</p>
      <span class="seg" id="theme-seg">
        ${THEME_OPTIONS.map(([v, l]) => `<button type="button" data-theme-pref="${v}" class="${themePref === v ? 'on' : ''}">${l}</button>`).join('')}
      </span>
    </div>

    ${installPanel({ variant: 'section' })}`, true);

  wireInstallPanel(() => renderDevice());

  el('theme-seg').querySelectorAll('[data-theme-pref]').forEach((b) =>
    b.addEventListener('click', () => {
      window.__kellySetTheme?.(b.dataset.themePref);
      el('theme-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      toast('ok', b.dataset.themePref === 'auto' ? 'Following your device theme.' : `${b.textContent} theme on.`);
    }));
}

// ── Cases / Quick links ──────────────────────────────────────────────────
async function renderCases() {
  paint('cases', skelForm());
  const openCases = (await api('/cases')).cases.filter((c) => c.status !== 'closed');

  paint('cases', `
    <div class="card">
      <h3>Your cases</h3>
      ${openCases.length ? `
      <p class="small muted">Add evidence straight to a case:</p>
      ${openCases.map((c) => `<p class="mt0"><a class="btn small quiet" href="/portal.html#/case/${c.id}/evidence">📎 #${c.id} · ${esc(c.title.slice(0, 48))}</a></p>`).join('')}
      ` : '<p class="muted">You have no open cases. <a href="/portal.html#/new">Start a case</a>.</p>'}
    </div>`, true);
}

async function renderLinks() {
  paint('links', `
    <div class="card">
      <h3>Quick links</h3>
      ${can(user, 'cases.review') ? '<p class="mt0"><a href="/advisor.html">Advisor dashboard</a></p>' : ''}
      ${hasAdminSurface(user) ? '<p class="mt0"><a href="/admin.html">Admin area</a></p>' : ''}
    </div>`, true);
}

// ── routing ──────────────────────────────────────────────────────────────
const RENDERERS = {
  profile: renderProfile,
  membership: renderMembership,
  security: renderSecurity,
  device: renderDevice,
  cases: renderCases,
  links: renderLinks,
};

async function route() {
  try {
    await RENDERERS[activeTab()]();
  } catch (err) {
    view.innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  }
}

user = await requireUser('account');
if (user) {
  membership = await api('/membership').catch(() => null);

  window.addEventListener('hashchange', route);
  // Only repaint for install events when the panel showing them is on screen,
  // so an install prompt cannot yank the user out of a form on another tab.
  const onInstallChange = () => { if (activeTab() === 'device') renderDevice().catch(() => {}); };
  window.addEventListener('kelly-installable', onInstallChange);
  window.addEventListener('kelly-installed', onInstallChange);

  // Returning from Stripe Checkout: land on the Membership tab and drop the
  // query string, keeping the hash so a reload stays put.
  const checkout = new URLSearchParams(window.location.search).get('checkout');
  if (checkout) {
    history.replaceState(null, '', `/account.html#/${checkout === 'success' && membership ? 'membership' : 'profile'}`);
  }

  await route();

  // Fulfilment arrives via webhook, so poll the membership state a few times
  // rather than trusting the redirect. This runs whichever tab is on screen.
  if (checkout === 'success') {
    toast('ok', 'Payment received — your membership updates within a minute.');
    let polls = 0;
    const timer = setInterval(async () => {
      polls += 1;
      if (polls >= 5) clearInterval(timer);
      if (activeTab() === 'membership') await renderMembership().catch(() => {});
      else membership = await api('/membership').catch(() => membership);
    }, 2500);
  } else if (checkout === 'cancelled') {
    toast('error', 'Checkout cancelled — no payment was taken.');
  }
}
