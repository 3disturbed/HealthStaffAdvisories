import { renderNav } from '/common.js';
import { ICONS, REDUCED } from '/ui.js';

const user = await renderNav('home');

// Sticky CTA bar for signed-out visitors (mobile).
const ctaBar = document.getElementById('cta-bar');
if (ctaBar && !user) {
  ctaBar.hidden = false;
  document.body.classList.add('has-ctabar');
}

// Trust-signals band above the footer.
const trustBand = document.getElementById('trust-band');
if (trustBand) {
  trustBand.innerHTML = [
    [ICONS.account, 'Every important case is reviewed by a human advisor'],
    [ICONS.cases, 'Your case data stays in your case — never training data'],
    [ICONS.chat, 'AI assistance is always labelled and source-backed'],
    [ICONS.bell, 'Urgent situations are escalated by fixed safety rules'],
  ].map(([icon, text]) => `<div class="trust-item reveal">${icon}<span>${text}</span></div>`).join('');
}

// Scroll reveal (progressive enhancement; content visible without JS).
const revealables = [...document.querySelectorAll('.reveal')];
if (revealables.length) {
  if (REDUCED.matches || !('IntersectionObserver' in window)) {
    revealables.forEach((el) => el.classList.add('revealed'));
  } else {
    let siblingIndex = 0;
    let lastParent = null;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        if (el.parentElement !== lastParent) { siblingIndex = 0; lastParent = el.parentElement; }
        el.style.setProperty('--stagger-i', siblingIndex++);
        el.classList.add('revealed');
        observer.unobserve(el);
      }
    }, { threshold: 0.15 });
    revealables.forEach((el) => observer.observe(el));
  }
}
