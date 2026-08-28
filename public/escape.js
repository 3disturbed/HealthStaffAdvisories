// DOM-free escaping helpers. This module deliberately has no imports and no
// window/document use, so unit tests can import it directly under node --test.

// esc() in common.js round-trips through div.textContent/innerHTML. That
// escapes & < > for text nodes but NOT quotes — the HTML serializer never
// needs to, because a text node cannot terminate an attribute. Inside a
// quoted attribute an unescaped " (or ') lets user input close the value and
// inject fresh attributes (e.g. `" onfocus="…`). escAttr() escapes all five
// significant characters so the same string is safe in both contexts.
export function escAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;') // & first, or the entities below get double-escaped
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Allow only absolute http(s) URLs in href attributes; return null otherwise.
// new URL() strips tabs/newlines and leading control chars before matching
// the scheme, so smuggling like `java\tscript:` still parses to javascript:
// and is rejected. Relative or unparseable input also returns null: callers
// hold admin-entered canonical URLs expected to be absolute, and "render as
// plain text" is the safe default for anything else.
export function safeUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? String(value) : null;
}
