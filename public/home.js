import { renderNav } from '/common.js';
import { ICONS, REDUCED } from '/ui.js';

// Reveal wiring runs FIRST and synchronously — page text must never wait on
// the network (nav/auth). styles.css also carries a failsafe animation that
// reveals everything ~1.8s in if this script never executes at all.
let observe = (els) => els.forEach((el) => el.classList.add('revealed'));
if (!REDUCED.matches && 'IntersectionObserver' in window) {
  let siblingIndex = 0;
  let lastParent = null;
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      if (el.parentElement !== lastParent) { siblingIndex = 0; lastParent = el.parentElement; }
      el.style.setProperty('--stagger-i', siblingIndex++);
      el.classList.add('revealed');
      io.unobserve(el);
    }
  }, { threshold: 0.15 });
  observe = (els) => els.forEach((el) => io.observe(el));
}
observe([...document.querySelectorAll('.reveal')]);

const user = await renderNav('home');

// Sticky CTA bar for signed-out visitors (mobile).
const ctaBar = document.getElementById('cta-bar');
if (ctaBar && !user) {
  ctaBar.hidden = false;
  document.body.classList.add('has-ctabar');
}

// Live pricing tiers (admin repricing shows here instantly). The static
// pilot paragraph stays as the no-JS/error fallback.
const tierGrid = document.getElementById('pricing-tiers');
if (tierGrid) {
  try {
    const { tiers } = await (await fetch('/api/membership/tiers')).json();
    if (tiers?.length) {
      tierGrid.innerHTML = tiers.map((t) => `
        <div class="card reveal">
          <h3 class="mt0">${t.name.replace(/[<>&]/g, '')}</h3>
          <p class="stat-num">${t.pricePence === 0 ? 'Free' : `£${(t.pricePence / 100).toFixed(2)}`}<span class="small muted">${t.pricePence === 0 ? '' : ' / month'}</span></p>
          <p class="small muted">${t.aiDailyAllowance} AI case ${t.aiDailyAllowance === 1 ? 'analysis' : 'analyses'} per day — never cut off, extra requests simply queue. Human review by Kelly on every tier.</p>
        </div>`).join('');
      document.getElementById('pricing-fallback')?.classList.add('hidden');
    }
  } catch { /* fallback paragraph stays */ }
}

// Trust-signals band above the footer (injected, so observed afterwards).
const trustBand = document.getElementById('trust-band');
if (trustBand) {
  trustBand.innerHTML = [
    [ICONS.account, 'Every important case is reviewed by a human advisor'],
    [ICONS.cases, 'Your case data stays in your case — never training data'],
    [ICONS.chat, 'AI assistance is always labelled and source-backed'],
    [ICONS.bell, 'Urgent situations are escalated by fixed safety rules'],
  ].map(([icon, text]) => `<div class="trust-item reveal">${icon}<span>${text}</span></div>`).join('');
  observe([...trustBand.querySelectorAll('.reveal')]);
}
