// Shared FAQ renderers, used by BOTH the public page (public/faq.js) and the
// members section inside the portal. One component, one code path.
//
// Escaping contract: esc() for text content, escAttr() inside quoted
// attributes, renderMarkdown() for answer bodies (already escapes internally —
// never wrap its output in esc()).

import { api, esc, escAttr, can } from '/common.js';
import { emptyState, enterView, stagger } from '/ui.js';
import { renderMarkdown } from '/markdown.js';

// linkBase parameterises the permalink namespace: '' on the standalone page
// (#/slug, #q-12) and '#/faq' inside the portal, whose hash space is shared
// with the case router.
function entryHref(linkBase, id) {
  return linkBase ? `${linkBase}/q/${id}` : `#q-${id}`;
}

function categoryHref(linkBase, slug) {
  return linkBase ? `${linkBase}/${slug}` : `#/${slug}`;
}

function visibilityBadge(q) {
  // Public entries get no badge — absence means public, which avoids badge
  // noise on the page where almost everything is public.
  const badges = [];
  if (q.visibility === 'members') badges.push('<span class="tag status">Members only</span>');
  if (q.status === 'draft') badges.push('<span class="tag high">Draft</span>');
  return badges.join(' ');
}

export function faqEntry(q, { linkBase = '', open = false, showCategory = false } = {}) {
  return `
    <details class="card faq-entry" id="faq-q-${q.id}" data-entry="${q.id}"${open ? ' open' : ''}>
      <summary>${esc(q.question)} ${visibilityBadge(q)}</summary>
      <div class="faq-answer">
        ${renderMarkdown(q.answer)}
        ${showCategory && q.categoryName ? `<p class="small muted mt0">in ${esc(q.categoryName)}</p>` : ''}
        <p class="right"><a class="faq-anchor" href="${escAttr(entryHref(linkBase, q.id))}">Link to this answer</a></p>
      </div>
    </details>`;
}

export function faqSearchBox() {
  return `
    <form class="faq-search" id="faq-search-form" role="search">
      <label class="sr-only" for="faq-search">Search the questions</label>
      <input id="faq-search" type="search" autocomplete="off" enterkeyhint="search"
             placeholder="Search &mdash; e.g. what documents should I upload">
    </form>
    <p class="faq-search-state small muted" id="faq-search-state" role="status" aria-live="polite"></p>`;
}

function browseHtml(data, linkBase) {
  const byCategory = new Map(data.categories.map((c) => [c.id, []]));
  for (const q of data.questions) {
    if (byCategory.has(q.categoryId)) byCategory.get(q.categoryId).push(q);
  }
  const sections = data.categories
    .filter((c) => (byCategory.get(c.id) || []).length > 0)
    .map(
      (c) => `
      <section class="faq-category" id="faq-c-${escAttr(c.slug)}">
        <h2>${esc(c.name)} ${c.visibility === 'members' ? '<span class="tag status">Members only</span>' : ''}</h2>
        ${c.description ? `<p class="muted small">${esc(c.description)}</p>` : ''}
        <div class="stack">${(byCategory.get(c.id) || []).map((q) => faqEntry(q, { linkBase })).join('')}</div>
      </section>`
    )
    .join('');

  if (!sections) {
    return emptyState({
      icon: 'file',
      title: 'No questions published yet',
      body: 'Answers will appear here as soon as an adviser publishes them.',
    });
  }

  const toc = data.categories
    .filter((c) => (byCategory.get(c.id) || []).length > 0)
    .map((c) => `<a href="${escAttr(categoryHref(linkBase, c.slug))}">${esc(c.name)}</a>`)
    .join('');

  return `<nav class="faq-toc" aria-label="Categories">${toc}</nav>${sections}`;
}

// ── search ────────────────────────────────────────────────────────────────
// Three guards, all required: without the sequence counter a slow early
// response overwrites a fast later one, and without the abort we keep paying
// for requests nobody will read.
const DEBOUNCE_MS = 300;
const MIN_QUERY = 2;

function searchStateText(data, count) {
  const noun = count === 1 ? '1 answer' : `${count} answers`;
  if (data.aiUsed) {
    return `${noun} &middot; <span class="tag ai">AI</span> sorted by relevance &mdash; the answers themselves are written by Kelly's advisers.`;
  }
  return `${noun} &middot; keyword match`;
}

export function wireFaqSearch(root, { linkBase = '', onBrowse }) {
  const form = root.querySelector('#faq-search-form');
  const input = root.querySelector('#faq-search');
  const state = root.querySelector('#faq-search-state');
  const results = root.querySelector('#faq-results');
  const browse = root.querySelector('#faq-browse');
  if (!form || !input || !results || !browse) return;

  let seq = 0;
  let timer = null;
  let controller = null;

  function showBrowse() {
    results.classList.add('hidden');
    results.innerHTML = '';
    browse.classList.remove('hidden');
    state.innerHTML = '';
    if (onBrowse) onBrowse();
  }

  async function run(query) {
    const mine = (seq += 1);
    if (controller) controller.abort();
    controller = new AbortController();
    input.setAttribute('aria-busy', 'true');
    form.classList.add('searching');
    results.classList.add('stale');
    state.textContent = 'Searching...';
    try {
      const data = await api('/faq/search', {
        method: 'POST',
        body: { q: query },
        signal: controller.signal,
      });
      if (mine !== seq) return; // a newer search has already started
      browse.classList.add('hidden');
      results.classList.remove('hidden');
      if (!data.results.length) {
        // Rendered here rather than via emptyState() so the user's own query
        // goes through esc() at the point of use.
        results.innerHTML = `
          <div class="empty-state">
            <h3>No answers matched &ldquo;${esc(query)}&rdquo;</h3>
            <p class="muted small">Try fewer words, or a word that would appear in the answer.</p>
            <p><button class="btn quiet small" type="button" data-faq-clear>Show all questions</button></p>
          </div>`;
        state.innerHTML = '';
      } else {
        results.innerHTML = data.results
          .map((q, i) => faqEntry(q, { linkBase, open: i === 0, showCategory: true }))
          .join('');
        state.innerHTML = searchStateText(data, data.results.length);
      }
      results.querySelector('[data-faq-clear]')?.addEventListener('click', () => {
        input.value = '';
        showBrowse();
      });
    } catch (err) {
      if (err.name === 'AbortError' || mine !== seq) return;
      results.classList.remove('hidden');
      browse.classList.add('hidden');
      results.innerHTML = `<div class="notice error">${esc(err.message)}</div>
        <p><button class="btn quiet small" type="button" data-faq-clear>Show all questions</button></p>`;
      results.querySelector('[data-faq-clear]')?.addEventListener('click', () => {
        input.value = '';
        showBrowse();
      });
      state.innerHTML = '';
    } finally {
      if (mine === seq) {
        input.removeAttribute('aria-busy');
        form.classList.remove('searching');
        results.classList.remove('stale');
      }
    }
  }

  function schedule() {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < MIN_QUERY) {
      seq += 1; // invalidate any in-flight response
      showBrowse();
      return;
    }
    timer = setTimeout(() => run(query), DEBOUNCE_MS);
  }

  input.addEventListener('input', schedule);
  // A real form gives iOS keyboards a Search key; submitting skips the debounce.
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length >= MIN_QUERY) run(query);
  });
}

// ── deep links ────────────────────────────────────────────────────────────
// #q-12 / '#/faq/q/12' opens one entry; '#/slug' scrolls to a category.
export function applyFaqHash(root, hash, linkBase = '') {
  const scroll = (el) => {
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  };
  const rest = linkBase && hash.startsWith(linkBase) ? hash.slice(linkBase.length) : hash;
  const entryMatch = rest.match(/^(?:\/q\/|#?q-)(\d+)$/);
  if (entryMatch) {
    const el = root.querySelector(`#faq-q-${entryMatch[1]}`);
    if (el) {
      el.open = true;
      el.classList.add('targeted');
      setTimeout(() => el.classList.remove('targeted'), 2000);
      scroll(el);
    }
    return;
  }
  const catMatch = rest.match(/^\/?#?\/?([a-z0-9-]+)$/);
  if (catMatch) scroll(root.querySelector(`#faq-c-${CSS.escape(catMatch[1])}`));
}

// ── section entry point ───────────────────────────────────────────────────
export async function renderFaqSection(mount, { user = null, hash = '', linkBase = '', heading = 'Common questions', intro = '' } = {}) {
  mount.innerHTML = '<p class="muted">Loading&hellip;</p>';
  const data = await api('/faq');

  const canEdit = user && can(user, 'faq.manage');
  mount.innerHTML = `
    <h1>${esc(heading)}</h1>
    ${intro ? `<p class="muted">${esc(intro)}</p>` : ''}
    ${data.level === 'members' || data.level === 'manage'
      ? '<div class="notice info small">Answers marked <strong>Members only</strong> are not on the public page.</div>'
      : ''}
    ${canEdit ? '<p><a class="btn quiet small" href="/admin.html#/faq">Edit these answers</a></p>' : ''}
    ${faqSearchBox()}
    <div id="faq-results" class="faq-results hidden"></div>
    <div id="faq-browse">${browseHtml(data, linkBase)}</div>`;

  enterView(mount);
  stagger(mount, '.faq-entry');
  wireFaqSearch(mount, { linkBase });

  // Record a view the first time an entry is expanded, and keep the hash in
  // step. history.replaceState, never location.hash — the latter fires
  // hashchange and re-enters the host router.
  const viewed = new Set();
  mount.querySelectorAll('.faq-entry').forEach((el) => {
    el.addEventListener('toggle', () => {
      if (!el.open) return;
      const id = Number(el.dataset.entry);
      if (viewed.has(id)) return;
      viewed.add(id);
      history.replaceState(null, '', entryHref(linkBase, id));
      api(`/faq/questions/${id}/viewed`, { method: 'POST' }).catch(() => {});
    });
  });

  if (hash) applyFaqHash(mount, hash, linkBase);
  return data;
}
