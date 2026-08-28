// Admin → Job evaluation tab: reference rulesets (view / import / approve /
// verify), the service offer (pricing), and quality metrics. Lazy-loaded.

import { api, esc, escAttr, fmtDate } from '/common.js';
import { enterView, setBusy, toast, skelTable, confirmSheet } from '/ui.js';

let view;

export async function renderAdminTab(mount, user, { tabsBar, wireTabs }) {
  view = mount;
  view.innerHTML = `<h1>Admin</h1>${tabsBar('banding')}${skelTable(4)}`;
  wireTabs();

  const [ref, offer, metrics] = await Promise.all([
    api('/je/reference').catch((e) => ({ error: e.message })),
    api('/je/offer').catch(() => null),
    api('/je/metrics').catch(() => null),
  ]);

  view.innerHTML = `
    <h1>Admin</h1>${tabsBar('banding')}
    <div id="msg"></div>
    ${ref.error ? `<div class="notice error">${esc(ref.error)}</div>` : `
    <div class="card">
      <h3 class="mt0">Reference rulesets</h3>
      <p class="small ${ref.readiness?.ready ? 'muted' : 'notice warn'}">${ref.readiness?.ready
        ? 'Scoring is available: an approved ruleset is loaded.'
        : `Scoring is unavailable: ${(ref.readiness?.reasons || []).map(esc).join('; ')}`}</p>
      ${ref.rulesets.map((r) => `
        <div class="perm-item">
          <div class="perm-head">
            <strong>${esc(r.label)}
              <span class="tag ${r.status === 'approved' ? 'ok-tag' : 'status'}">${esc(r.status)}</span>
              ${r.origin === 'seed' ? '<span class="tag">seed</span>' : ''}
              ${r.verifiedAt ? '<span class="tag ok-tag">verified</span>' : '<span class="tag high">not verified</span>'}</strong>
            <span>
              ${r.status === 'draft' ? `<button class="btn small" type="button" data-approve-rs="${r.id}">Approve</button>` : ''}
              ${!r.verifiedAt ? `<button class="btn small secondary" type="button" data-verify-rs="${r.id}">Mark verified</button>` : ''}
            </span>
          </div>
          <div class="small muted">${r.factorCount} factors · ${r.levelCount} levels · ${r.bandCount} bands · ${r.profileCount} profiles · ${r.reviewCount} review(s) pinned · checksum ${esc(r.checksum.slice(0, 12))}</div>
          ${r.sourceNote ? `<div class="small muted">${esc(r.sourceNote)}</div>` : ''}
        </div>`).join('')}
      ${ref.rulesets.some((r) => r.origin === 'seed' && !r.verifiedAt) ? `
        <div class="notice warn small"><strong>Bundled seed data.</strong> Verify every factor, level point, band boundary and time-limit parameter against the current published NHS Job Evaluation Handbook, then mark it verified — or import a replacement bundle. Until then, every report footer says the reference data is unverified.</div>` : ''}
      <details>
        <summary><strong>Import a ruleset bundle (JSON)</strong></summary>
        <p class="hint">Structure: scheme, label, sourceNote, factors[{code, seq, name, description, levels[{label, points, descriptor}]}], bands[{label, min, max}], profiles[{code, title, jobFamily, band, factorLevels:{factorCode:[lo,hi]}}], matchRules, limitationRules. National profiles from the published NHS profile library are imported here. Validation is all-or-nothing; importing never activates — approving does.</p>
        <textarea id="rs-json" maxlength="500000" placeholder='{"scheme":"afc", ...}'></textarea>
        <p><button class="btn secondary" type="button" id="rs-import">Validate &amp; import as draft</button></p>
        <div id="rs-import-msg"></div>
      </details>
    </div>`}
    ${offer ? `
    <div class="card">
      <h3 class="mt0">Pricing &amp; offer</h3>
      <form id="offer-form">
        <label class="check-row"><input type="checkbox" id="of-enabled" ${offer.offer.enabled ? 'checked' : ''}><span>Offer shown to members</span></label>
        <div class="duty-row-meta">
          <span><label for="of-price">Price (GBP)</label><input id="of-price" type="number" min="0" step="1" value="${escAttr(String(offer.offer.priceGbp))}"></span>
          <span><label for="of-unit">Unit</label><input id="of-unit" type="text" maxlength="40" value="${escAttr(offer.offer.unit)}"></span>
        </div>
        <label class="check-row"><input type="checkbox" id="of-vat" ${offer.offer.vatApplies ? 'checked' : ''}><span>+ VAT</span></label>
        <label for="of-headline">Headline</label>
        <input id="of-headline" type="text" maxlength="120" value="${escAttr(offer.offer.headline)}">
        <label for="of-inclusions">Inclusions (one per line)</label>
        <textarea id="of-inclusions" maxlength="2500">${esc((offer.offer.inclusions || []).join('\n'))}</textarea>
        <label for="of-note">Note</label>
        <input id="of-note" type="text" maxlength="300" value="${escAttr(offer.offer.note || '')}">
        <p><button class="btn secondary" type="submit">Save offer</button></p>
      </form>
    </div>` : ''}
    ${metrics ? `
    <div class="card">
      <h3 class="mt0">Quality at a glance</h3>
      <p class="small muted">Aggregate only. Full dashboard: Advisor → Band reviews → Oversight.</p>
      <div class="table-scroll"><table>
        <thead><tr><th>Area</th><th>Decided</th><th>Agreement</th><th>Blind</th></tr></thead>
        <tbody>${(metrics.perFactor || []).map((f) => `
          <tr><td>${esc(f.factorCode.replace(/_/g, ' '))}</td><td>${f.decided}</td>
          <td>${f.agreementRate === null ? '—' : `${f.agreementRate}%`}</td>
          <td>${f.blindAgreementRate === null ? '—' : `${f.blindAgreementRate}%`}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No decided factors yet.</td></tr>'}</tbody>
      </table></div>
    </div>` : ''}`;
  enterView(view);
  wireTabs();

  const msg = document.getElementById('msg');

  view.querySelectorAll('[data-approve-rs]').forEach((b) => b.addEventListener('click', async () => {
    const sure = await confirmSheet({
      title: 'Approve this ruleset?',
      bodyHtml: '<p>Approving supersedes the currently approved ruleset. Existing reviews stay pinned to the version they were assessed under (their outcomes never change silently); open reviews are flagged and can be explicitly recomputed.</p>',
      confirmLabel: 'Approve',
    });
    if (!sure) return;
    try {
      await api(`/je/reference/rulesets/${b.dataset.approveRs}/approve`, { method: 'POST' });
      toast('ok', 'Approved.');
      renderAdminTab(view, user, { tabsBar, wireTabs });
    } catch (err) { msg.innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
  }));

  view.querySelectorAll('[data-verify-rs]').forEach((b) => b.addEventListener('click', async () => {
    const sure = await confirmSheet({
      title: 'Mark as verified?',
      bodyHtml: '<p>This records that a person has checked the loaded factors, level points, band boundaries and time-limit parameters against the published NHS Job Evaluation Handbook. It is shown on every report footer.</p>',
      confirmLabel: 'I have checked it — mark verified',
    });
    if (!sure) return;
    try {
      await api(`/je/reference/rulesets/${b.dataset.verifyRs}/verify`, { method: 'POST' });
      toast('ok', 'Marked verified.');
      renderAdminTab(view, user, { tabsBar, wireTabs });
    } catch (err) { msg.innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
  }));

  document.getElementById('rs-import')?.addEventListener('click', async (e) => {
    const out = document.getElementById('rs-import-msg');
    let bundle;
    try { bundle = JSON.parse(document.getElementById('rs-json').value); }
    catch { out.innerHTML = '<div class="notice error">That is not valid JSON.</div>'; return; }
    setBusy(e.target, true);
    try {
      const r = await api('/je/reference/rulesets', { method: 'POST', body: bundle });
      toast('ok', 'Imported as draft — review and approve it.');
      renderAdminTab(view, user, { tabsBar, wireTabs });
    } catch (err) {
      out.innerHTML = `<div class="notice error">${esc(err.message)}${err.errors ? `<ul>${err.errors.slice(0, 20).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
    }
    setBusy(e.target, false);
  });

  document.getElementById('offer-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    setBusy(btn, true);
    try {
      await api('/je/offer', {
        method: 'POST',
        body: {
          enabled: document.getElementById('of-enabled').checked,
          priceGbp: Number(document.getElementById('of-price').value),
          vatApplies: document.getElementById('of-vat').checked,
          unit: document.getElementById('of-unit').value,
          headline: document.getElementById('of-headline').value,
          inclusions: document.getElementById('of-inclusions').value.split('\n').map((x) => x.trim()).filter(Boolean),
          note: document.getElementById('of-note').value,
        },
      });
      toast('ok', 'Offer saved.');
    } catch (err) { msg.innerHTML = `<div class="notice error">${esc(err.message)}</div>`; }
    setBusy(btn, false);
  });
}
