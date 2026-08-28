// A deliberately tiny markdown subset for FAQ answers.
//
// IMPORT PATH: './escape.js' is RELATIVE on purpose. The rest of the app writes
// '/escape.js', but node cannot resolve a browser-absolute path, and this module
// must be unit-testable under `node --test` (see tests/markdown.test.js).
// Relative resolves correctly in both. Do not "fix" it to '/escape.js', and do
// not inline copies of escAttr/safeUrl to stay import-free — never fork a
// security primitive.
//
// THE SECURITY INVARIANT, in order:
//   1. normalise   strip carriage returns
//   2. escape      escAttr() the WHOLE string, before any transform
//   3. tokenise    pull [label](url) out into <L0>-style placeholders
//   4. inline      **bold**
//   5. block       blank-line split -> <p> / <ul>; single newline -> <br>
//   6. re-inject   swap placeholders for built <a> (or plain-text fallback)
//
// Step 2 before everything means raw HTML is structurally impossible: by the
// time any transform runs there is no unescaped <, >, " or ' left in the input.
// That is also what makes the placeholder unforgeable — escaped text cannot
// contain a literal "<", so no input can fabricate a <L0>.
//
// Steps 3/6 are why links are tokenised rather than emitted inline: if <a>
// markup existed during step 4, a later regex would operate on angle brackets
// and quotes THAT WE ADDED, and e.g. [x](https://a**b**c) would splice <strong>
// inside an href. Tokenising makes that structurally impossible.
//
// OUTPUT ALLOW-LIST: <p> <br> <ul> <li> <strong> <a href target rel>. Nothing
// else, ever. tests/markdown.test.js asserts this over the whole corpus.
//
// SUPPORTED: paragraphs, "- " bullet lists (all-or-nothing per block),
// **bold**, [text](url) for absolute http(s) and root-relative URLs.
// NOT SUPPORTED, on purpose: headings, italic, inline/fenced code,
// blockquotes, images, tables, ordered lists, nested lists, horizontal rules,
// bare-URL autolinking, reference links, footnotes, strikethrough, two-space
// hard breaks, and raw HTML.
//
// If you add a rule, keep the order above and extend the allow-list test.

import { escAttr, safeUrl } from './escape.js';

const MAX_LABEL = 200;
const MAX_URL = 2000;
const MAX_BOLD = 500;

// Bounded character classes throughout — never .* under a nested quantifier —
// so adversarial input cannot backtrack catastrophically.
const LINK_RE = new RegExp(`\\[([^\\]\\n]{1,${MAX_LABEL}})\\]\\(([^()\\s]{1,${MAX_URL}})\\)`, 'g');
const BOLD_RE = new RegExp(`\\*\\*(?!\\s)([^*\\n]{1,${MAX_BOLD}})\\*\\*`, 'g');
const BULLET = /^ {0,3}-\s+/;
const PLACEHOLDER_RE = /<L(\d+)>/g;

// Absolute http(s) via safeUrl, or a same-origin root-relative path so advisers
// can link to /emergency.html. Rejects protocol-relative "//evil.com" and the
// "/\evil.com" variant some browsers treat the same way.
function linkHref(escapedUrl) {
  if (/^\/(?![/\\])\S*$/.test(escapedUrl)) return escapedUrl;
  return safeUrl(escapedUrl);
}

// Runs on ALREADY-ESCAPED text. Returns { text, links }, where text carries a
// <Ln> placeholder in place of each link.
function tokeniseLinks(escaped) {
  const links = [];
  const text = escaped.replace(LINK_RE, (_match, label, url) => {
    const href = linkHref(url);
    // The URL is ALREADY escaped, so it goes into the href as-is. Escaping it
    // again would turn &amp; into &amp;amp; and break the link.
    links.push(
      href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : `${label} (${url})`
    );
    return `<L${links.length - 1}>`;
  });
  return { text, links };
}

function renderBlock(block) {
  const lines = block.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return '';
  // All-or-nothing: a block where every line is a bullet becomes a list; a
  // mixed block stays a paragraph. Trivially testable, and documented.
  if (lines.every((l) => BULLET.test(l))) {
    return `<ul>${lines.map((l) => `<li>${l.replace(BULLET, '')}</li>`).join('')}</ul>`;
  }
  return `<p>${lines.join('<br>')}</p>`;
}

export function renderMarkdown(value) {
  const normalised = String(value ?? '').replace(/\r/g, '');
  if (!normalised.trim()) return '';
  const { text, links } = tokeniseLinks(escAttr(normalised));
  const html = text
    .split(/\n{2,}/)
    .map((block) => renderBlock(block.replace(BOLD_RE, '<strong>$1</strong>')))
    .join('');
  return html.replace(PLACEHOLDER_RE, (_m, i) => links[Number(i)] ?? '');
}

// Strips the markup and returns BARE TEXT — deliberately NOT escaped, because
// callers put it in textContent, or into an attribute via escAttr(). If you
// ever pass this to innerHTML you have routed around the renderer's escaping
// entirely. Don't.
export function markdownToPlainText(value) {
  return String(value ?? '')
    .replace(/\r/g, '')
    .replace(LINK_RE, '$1')
    .replace(BOLD_RE, '$1')
    .replace(/^ {0,3}-\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function excerpt(value, max = 180) {
  const plain = markdownToPlainText(value);
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}
