// Advisor FAQ CMS. Lazy-loaded by public/admin.js, following the contract
// banding-admin.js established: renderAdminTab(mount, user, { tabsBar, wireTabs }).
//
// Untrusted-text note: openSheet() and emptyState() interpolate their title/body
// arguments raw, so nothing author- or user-controlled is passed to them here —
// the preview sheet gets a literal title with the question in the escaped body.

import { api, esc, escAttr, fmtDate } from '/common.js';
import { skelTable, setBusy, toast, openSheet, confirmSheet, enterView } from '/ui.js';
import { renderMarkdown } from '/markdown.js';

let view;
let user;
let ctx;

const oops = (err) => {
  const msg = document.getElementById('msg');
  if (msg) msg.innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  window.scrollTo(0, 0);
};

const reload = () => renderAdminTab(view, user, ctx);

function categoryOptions(categories, selectedId) {
  return categories
    .map((c) => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${esc(c.name)}</option>`)
    .join('');
}

function statusBadges(q) {
  const badges = [`<span class="tag ${q.status === 'published' ? 'normal' : 'high'}">${esc(q.status)}</span>`];
  if (q.visibility === 'members') badges.push('<span class="tag status">Members only</span>');
  return badges.join(' ');
}

const MARKDOWN_HINT = `<p class="muted small">Plain text with a few marks: a blank line starts a new paragraph,
  <code>- </code> makes a bullet, <code>**bold**</code>, and <code>[text](https://example.com)</code> or
  <code>[text](/emergency.html)</code> for a link. HTML is not allowed and is shown as plain text.</p>`;

function answerEditor(idPrefix, value = '') {
  return `
    <label for="${idPrefix}-answer">Answer</label>
    ${MARKDOWN_HINT}
    <textarea id="${idPrefix}-answer" name="answer" rows="8" required maxlength="8000">${esc(value)}</textarea>
    <h4 class="small muted" id="${idPrefix}-preview-label">Preview</h4>
    <div class="md-preview" id="${idPrefix}-preview" aria-labelledby="${idPrefix}-preview-label"></div>`;
}

// No debounce (pure string work) and deliberately no aria-live — a live region
// here would announce on every keystroke.
function wirePreview(root, idPrefix) {
  const ta = root.querySelector(`#${idPrefix}-answer`);
  const out = root.querySelector(`#${idPrefix}-preview`);
  if (!ta || !out) return;
  const paint = () => { out.innerHTML = renderMarkdown(ta.value); };
  ta.addEventListener('input', paint);
  paint();
}

function categoryCardHtml(c, categories) {
  const others = categories.filter((o) => o.id !== c.id);
  return `
    <div class="card" data-cat="${c.id}">
      <h3 class="mt0">${esc(c.name)}
        <span class="tag ${c.status === 'published' ? 'normal' : 'high'}">${esc(c.status)}</span>
        ${c.visibility === 'members' ? '<span class="tag status">Members only</span>' : ''}
      </h3>
      <p class="small muted mt0">/${esc(c.slug)} &middot; ${c.questionCount} entr${c.questionCount === 1 ? 'y' : 'ies'}${c.draftCount ? ` &middot; ${c.draftCount} draft` : ''}</p>
      ${c.description ? `<p class="small mt0">${esc(c.description)}</p>` : ''}
      <p class="right mt0">
        <button class="btn small quiet" data-cat-up="${c.id}">&uarr;</button>
        <button class="btn small quiet" data-cat-down="${c.id}">&darr;</button>
        <button class="btn small quiet" data-cat-edit="${c.id}">Edit</button>
        <button class="btn small danger" data-cat-del="${c.id}"${c.questionCount && others.length === 0 ? ' disabled' : ''}>Delete</button>
      </p>
      ${c.questionCount && others.length === 0 ? '<p class="small muted mt0">Move or delete its entries first.</p>' : ''}
      <div class="cat-edit-slot hidden" data-cat-slot="${c.id}"></div>
    </div>`;
}

function questionCardHtml(q, categories) {
  return `
    <div class="card" data-q="${q.id}" data-blob="${escAttr(`${q.question} ${q.keywords}`.toLowerCase())}">
      <h3 class="mt0">${esc(q.question)} ${statusBadges(q)}</h3>
      <p class="small muted mt0">/${esc(q.slug)}${q.updatedBy ? ` &middot; updated by ${esc(q.updatedBy)}` : ''} &middot; ${esc(fmtDate(q.updatedAt))}
        &middot; ${q.viewCount} view${q.viewCount === 1 ? '' : 's'} &middot; ${q.helpfulCount} helpful${q.notHelpfulCount ? ` / ${q.notHelpfulCount} not` : ''}</p>
      <div class="faq-answer">${renderMarkdown(q.answer)}</div>
      <p class="right mt0">
        <button class="btn small quiet" data-q-up="${q.id}">&uarr;</button>
        <button class="btn small quiet" data-q-down="${q.id}">&darr;</button>
        <button class="btn small quiet" data-q-preview="${q.id}">Preview</button>
        <button class="btn small quiet" data-q-vis="${q.id}">${q.visibility === 'members' ? 'Make public' : 'Make members-only'}</button>
        <button class="btn small ${q.status === 'published' ? 'quiet' : 'primary'}" data-q-pub="${q.id}">${q.status === 'published' ? 'Unpublish' : 'Publish'}</button>
        <button class="btn small quiet" data-q-edit="${q.id}">Edit</button>
        <button class="btn small danger" data-q-del="${q.id}">Delete</button>
      </p>
      <div class="q-edit-slot hidden" data-q-slot="${q.id}"></div>
    </div>`;
}

export async function renderAdminTab(mount, currentUserObj, { tabsBar, wireTabs }) {
  view = mount;
  user = currentUserObj;
  ctx = { tabsBar, wireTabs };

  view.innerHTML = `<h1>Admin</h1>${tabsBar('faq')}${skelTable(4)}`;
  wireTabs();

  const data = await api('/faq/manage');
  const { categories, questions } = data;
  const byCategory = new Map(categories.map((c) => [c.id, []]));
  for (const q of questions) {
    if (byCategory.has(q.categoryId)) byCategory.get(q.categoryId).push(q);
  }

  view.innerHTML = `
    <h1>Admin</h1>${tabsBar('faq')}
    <div id="msg"></div>

    <h2>Questions</h2>
    <p class="muted small">These answers appear on the public <a href="/faq.html">questions page</a>.
      Entries marked <strong>Members only</strong> appear just inside the portal. Drafts appear nowhere.</p>

    <details class="card">
      <summary><strong>Add a question</strong></summary>
      <form id="add-q">
        <label for="fq-question">Question</label>
        <p class="muted small">Write it the way a member would ask it.</p>
        <input id="fq-question" name="question" type="text" required maxlength="300">

        <label for="fq-category">Category</label>
        <select id="fq-category" name="categoryId">${categoryOptions(categories)}</select>

        ${answerEditor('fq')}

        <label for="fq-keywords">Search keywords <span class="muted">(optional)</span></label>
        <p class="muted small">Other words a member might search for, comma separated &mdash; e.g. band, grading, AfC.</p>
        <input id="fq-keywords" name="keywords" type="text" maxlength="300">

        <label class="check-row"><input type="radio" name="fq-visibility" value="public" checked><span>Show on the public page</span></label>
        <label class="check-row"><input type="radio" name="fq-visibility" value="members"><span>Members only &mdash; signed-in members, not the public page</span></label>
        <label class="check-row"><input type="checkbox" id="fq-published"><span>Publish straight away</span></label>

        <p><button class="btn primary" type="submit">Add question</button></p>
      </form>
    </details>

    <p><input type="search" id="faq-filter" placeholder="Filter questions&hellip;" aria-label="Filter questions"></p>

    <div id="faq-q-list">
      ${categories.length === 0
        ? '<div class="card"><p class="mt0 muted">Add a category first, then you can write questions.</p></div>'
        : categories.map((c) => `
          <h3>${esc(c.name)}</h3>
          <div class="stack" data-qgroup="${c.id}">
            ${(byCategory.get(c.id) || []).map((q) => questionCardHtml(q, categories)).join('')
              || '<div class="card"><p class="mt0 muted small">Nothing in this category yet.</p></div>'}
          </div>`).join('')}
    </div>

    <h2>Categories</h2>
    <details class="card">
      <summary><strong>Add a category</strong></summary>
      <form id="add-cat">
        <label for="fc-name">Name</label>
        <input id="fc-name" name="name" type="text" required maxlength="80">
        <label for="fc-desc">Description <span class="muted">(optional)</span></label>
        <textarea id="fc-desc" name="description" rows="2" maxlength="300"></textarea>
        <label class="check-row"><input type="radio" name="fc-visibility" value="public" checked><span>Public</span></label>
        <label class="check-row"><input type="radio" name="fc-visibility" value="members"><span>Members only</span></label>
        <label class="check-row"><input type="checkbox" id="fc-published" checked><span>Published</span></label>
        <p><button class="btn primary" type="submit">Add category</button></p>
      </form>
    </details>

    <div class="stack" id="faq-cat-list">
      ${categories.map((c) => categoryCardHtml(c, categories)).join('')
        || '<div class="card"><p class="mt0 muted">No categories yet.</p></div>'}
    </div>

    <p class="right"><button class="btn small quiet" id="faq-reindex">Rebuild search index</button></p>`;

  enterView(view);
  wireTabs();
  wirePreview(view, 'fq');
  wireAll(categories, questions, byCategory);
}

// ── wiring ────────────────────────────────────────────────────────────────
// Every mutation: success -> toast + full re-render; failure -> re-enable the
// button and show the error in #msg. Never DOM-patch a mutated row.
function submitWith(btn, promise) {
  setBusy(btn, true);
  return promise
    .then((res) => { reload(); return res; })
    .catch((err) => { setBusy(btn, false); oops(err); });
}

function move(list, id, delta) {
  const ids = list.map((x) => x.id);
  const i = ids.indexOf(id);
  if (i < 0) return null;
  const j = i + delta;
  if (j < 0 || j >= ids.length) return null;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return ids;
}

function wireAll(categories, questions, byCategory) {
  // ── filter (client-side, the audit-table idiom: no network, no new CSS) ──
  view.querySelector('#faq-filter')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    view.querySelectorAll('[data-blob]').forEach((card) => {
      card.classList.toggle('hidden', q !== '' && !card.dataset.blob.includes(q));
    });
  });

  // ── create question ──
  view.querySelector('#add-q')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    submitWith(e.target.querySelector('button'), api('/faq/questions', {
      method: 'POST',
      body: {
        question: f.question.value,
        categoryId: Number(f.categoryId.value),
        answer: f.answer.value,
        keywords: f.keywords.value,
        visibility: view.querySelector('input[name="fq-visibility"]:checked')?.value || 'public',
        status: view.querySelector('#fq-published')?.checked ? 'published' : 'draft',
      },
    }).then(() => toast('ok', 'Question added.')));
  });

  // ── create category ──
  view.querySelector('#add-cat')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    submitWith(e.target.querySelector('button'), api('/faq/categories', {
      method: 'POST',
      body: {
        name: f.name.value,
        description: f.description.value,
        visibility: view.querySelector('input[name="fc-visibility"]:checked')?.value || 'public',
        status: view.querySelector('#fc-published')?.checked ? 'published' : 'draft',
        seq: (categories.length + 1) * 10,
      },
    }).then(() => toast('ok', 'Category added.')));
  });

  // ── question row actions ──
  view.querySelectorAll('[data-q-pub]').forEach((b) => b.addEventListener('click', () => {
    const q = questions.find((x) => x.id === Number(b.dataset.qPub));
    submitWith(b, api(`/faq/questions/${q.id}/status`, {
      method: 'POST',
      body: { status: q.status === 'published' ? 'draft' : 'published' },
    }).then(() => toast('ok', q.status === 'published' ? 'Unpublished.' : 'Published.')));
  }));

  view.querySelectorAll('[data-q-vis]').forEach((b) => b.addEventListener('click', () => {
    const q = questions.find((x) => x.id === Number(b.dataset.qVis));
    submitWith(b, api(`/faq/questions/${q.id}`, {
      method: 'PATCH',
      body: { visibility: q.visibility === 'members' ? 'public' : 'members' },
    }).then(() => toast('ok', 'Visibility updated.')));
  }));

  view.querySelectorAll('[data-q-preview]').forEach((b) => b.addEventListener('click', () => {
    const q = questions.find((x) => x.id === Number(b.dataset.qPreview));
    // Literal sheet title; the question goes in the body, escaped. openSheet
    // interpolates its title argument raw.
    openSheet('Preview', `<h3 class="mt0">${esc(q.question)}</h3>
      <div class="faq-answer">${renderMarkdown(q.answer)}</div>`);
  }));

  view.querySelectorAll('[data-q-del]').forEach((b) => b.addEventListener('click', async () => {
    const q = questions.find((x) => x.id === Number(b.dataset.qDel));
    const ok = await confirmSheet({
      title: 'Delete this question?',
      bodyHtml: `<p>${esc(q.question)}</p><p class="muted small">This cannot be undone. Any link to this answer will stop working.</p>`,
      confirmLabel: 'Delete question',
      danger: true,
    });
    if (!ok) return;
    submitWith(b, api(`/faq/questions/${q.id}/delete`, { method: 'POST' }).then(() => toast('ok', 'Question deleted.')));
  }));

  ['up', 'down'].forEach((dir) => {
    view.querySelectorAll(`[data-q-${dir}]`).forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset[dir === 'up' ? 'qUp' : 'qDown']);
      const q = questions.find((x) => x.id === id);
      const ids = move(byCategory.get(q.categoryId) || [], id, dir === 'up' ? -1 : 1);
      if (!ids) return;
      submitWith(b, api('/faq/questions/reorder', { method: 'POST', body: { categoryId: q.categoryId, ids } }));
    }));
  });

  // ── inline question edit (build once on first toggle) ──
  view.querySelectorAll('[data-q-edit]').forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.dataset.qEdit);
    const q = questions.find((x) => x.id === id);
    const slot = view.querySelector(`[data-q-slot="${id}"]`);
    slot.classList.toggle('hidden');
    if (slot.classList.contains('hidden') || slot.innerHTML) return;
    slot.innerHTML = `
      <form data-q-form="${id}">
        <label for="eq-${id}-question">Question</label>
        <input id="eq-${id}-question" name="question" type="text" required maxlength="300" value="${escAttr(q.question)}">
        <label for="eq-${id}-category">Category</label>
        <select id="eq-${id}-category" name="categoryId">${categoryOptions(categories, q.categoryId)}</select>
        ${answerEditor(`eq-${id}`, q.answer)}
        <label for="eq-${id}-keywords">Search keywords</label>
        <input id="eq-${id}-keywords" name="keywords" type="text" maxlength="300" value="${escAttr(q.keywords)}">
        <p><button class="btn small primary" type="submit">Save changes</button></p>
      </form>`;
    wirePreview(slot, `eq-${id}`);
    slot.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target.elements;
      submitWith(e.target.querySelector('button'), api(`/faq/questions/${id}`, {
        method: 'PATCH',
        body: {
          question: f.question.value,
          categoryId: Number(f.categoryId.value),
          answer: f.answer.value,
          keywords: f.keywords.value,
        },
      }).then(() => toast('ok', 'Question updated.')));
    });
  }));

  // ── category row actions ──
  ['up', 'down'].forEach((dir) => {
    view.querySelectorAll(`[data-cat-${dir}]`).forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset[dir === 'up' ? 'catUp' : 'catDown']);
      const ids = move(categories, id, dir === 'up' ? -1 : 1);
      if (!ids) return;
      submitWith(b, api('/faq/categories/reorder', { method: 'POST', body: { ids } }));
    }));
  });

  view.querySelectorAll('[data-cat-del]').forEach((b) => b.addEventListener('click', async () => {
    const id = Number(b.dataset.catDel);
    const c = categories.find((x) => x.id === id);
    const others = categories.filter((o) => o.id !== id);
    // The server refuses while entries remain; offer the move in the same step
    // rather than making the adviser re-file them one at a time.
    const picker = c.questionCount
      ? `<label for="reassign-${id}">Move its ${c.questionCount} entr${c.questionCount === 1 ? 'y' : 'ies'} to</label>
         <select id="reassign-${id}">${categoryOptions(others)}</select>`
      : '<p class="muted small">This category is empty.</p>';
    const ok = await confirmSheet({
      title: 'Delete this category?',
      bodyHtml: `<p>${esc(c.name)}</p>${picker}`,
      confirmLabel: 'Delete category',
      danger: true,
    });
    if (!ok) return;
    const reassignTo = c.questionCount
      ? Number(document.getElementById(`reassign-${id}`)?.value || others[0]?.id)
      : undefined;
    submitWith(b, api(`/faq/categories/${id}/delete`, { method: 'POST', body: { reassignTo } })
      .then(() => toast('ok', 'Category deleted.')));
  }));

  view.querySelectorAll('[data-cat-edit]').forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.dataset.catEdit);
    const c = categories.find((x) => x.id === id);
    const slot = view.querySelector(`[data-cat-slot="${id}"]`);
    slot.classList.toggle('hidden');
    if (slot.classList.contains('hidden') || slot.innerHTML) return;
    slot.innerHTML = `
      <form data-cat-form="${id}">
        <label for="ec-${id}-name">Name</label>
        <input id="ec-${id}-name" name="name" type="text" required maxlength="80" value="${escAttr(c.name)}">
        <label for="ec-${id}-desc">Description</label>
        <textarea id="ec-${id}-desc" name="description" rows="2" maxlength="300">${esc(c.description)}</textarea>
        <label class="check-row"><input type="radio" name="ec-${id}-vis" value="public"${c.visibility === 'public' ? ' checked' : ''}><span>Public</span></label>
        <label class="check-row"><input type="radio" name="ec-${id}-vis" value="members"${c.visibility === 'members' ? ' checked' : ''}><span>Members only</span></label>
        <label class="check-row"><input type="checkbox" name="pub"${c.status === 'published' ? ' checked' : ''}><span>Published</span></label>
        <p><button class="btn small primary" type="submit">Save changes</button></p>
      </form>`;
    slot.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target.elements;
      submitWith(e.target.querySelector('button'), api(`/faq/categories/${id}`, {
        method: 'PATCH',
        body: {
          name: f.name.value,
          description: f.description.value,
          visibility: slot.querySelector(`input[name="ec-${id}-vis"]:checked`)?.value || c.visibility,
          status: f.pub.checked ? 'published' : 'draft',
        },
      }).then(() => toast('ok', 'Category updated.')));
    });
  }));

  view.querySelector('#faq-reindex')?.addEventListener('click', (e) => {
    submitWith(e.target, api('/faq/reindex', { method: 'POST' }).then(() => toast('ok', 'Search index rebuilt.')));
  });
}
