import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, markdownToPlainText, excerpt } from '../public/markdown.js';

// The renderer is the only thing standing between adviser-authored text and
// innerHTML on a public page, so these tests are deliberately blunt.

const ALLOWED_TAGS = /<\/?(p|br|ul|li|strong|a)\b[^>]*>/g;

test('plain text becomes a paragraph; empty input renders nothing', () => {
  assert.equal(renderMarkdown('Hello.'), '<p>Hello.</p>');
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
  assert.equal(renderMarkdown(undefined), '');
  assert.equal(renderMarkdown('   '), '');
});

test('blank lines separate paragraphs; a single newline is a line break', () => {
  assert.equal(renderMarkdown('one\n\ntwo'), '<p>one</p><p>two</p>');
  assert.equal(renderMarkdown('one\n\n\n\ntwo'), '<p>one</p><p>two</p>');
  assert.equal(renderMarkdown('one\ntwo'), '<p>one<br>two</p>');
});

test('a block of bullets becomes a list', () => {
  assert.equal(renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(renderMarkdown('intro\n\n- a\n- b'), '<p>intro</p><ul><li>a</li><li>b</li></ul>');
});

test('a mixed block stays a paragraph (all-or-nothing, documented behaviour)', () => {
  assert.equal(renderMarkdown('intro line\n- not a list'), '<p>intro line<br>- not a list</p>');
});

test('bold is bounded and does not span newlines', () => {
  assert.equal(renderMarkdown('a **b** c'), '<p>a <strong>b</strong> c</p>');
  assert.equal(renderMarkdown('a ** b'), '<p>a ** b</p>');
  assert.equal(renderMarkdown('**unclosed'), '<p>**unclosed</p>');
  assert.ok(!renderMarkdown('**a\nb**').includes('<strong>'));
});

test('absolute http(s) and root-relative links are allowed', () => {
  assert.equal(
    renderMarkdown('[t](https://x.org)'),
    '<p><a href="https://x.org" target="_blank" rel="noopener noreferrer">t</a></p>'
  );
  assert.ok(renderMarkdown('[t](/emergency.html)').includes('href="/emergency.html"'));
});

test('dangerous and protocol-relative URLs never produce an href', () => {
  for (const bad of [
    '[t](javascript:alert)',
    '[t](JavaScript:alert)',
    '[t](data:text/html;base64,PHNjcmlwdD4=)',
    '[t](//evil.com)',
    '[t](/\\evil.com)',
    '[t](vbscript:msgbox)',
  ]) {
    const out = renderMarkdown(bad);
    assert.ok(!out.includes('href'), `${bad} must not produce an href, got: ${out}`);
    assert.ok(out.includes('t'), `${bad} should keep its label as text`);
  }
});

test('a tab-smuggled scheme is not treated as a link', () => {
  const out = renderMarkdown('[t](java\tscript:alert)');
  assert.ok(!out.includes('href'));
});

test('XSS payloads render as visible text, never as markup', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg/onload=alert(1)>',
    '**<b>x</b>**',
    '[x]("onmouseover="alert(1))',
    '[<img src=x onerror=alert(1)>](https://x.org)',
    '- <script>alert(1)</script>',
    '<a href="https://evil.com">click</a>',
    '&lt;script&gt;',
    '<L0>',
    '<L999>',
  ];
  for (const payload of payloads) {
    const out = renderMarkdown(payload);
    // The structural check: once the allow-listed tags WE emit are removed,
    // no angle bracket may remain. An event handler surviving as escaped TEXT
    // (&lt;img ... onerror=...&gt;) is inert and expected — what must never
    // happen is it surviving as real markup.
    const stripped = out.replace(ALLOWED_TAGS, '');
    assert.ok(!stripped.includes('<'), `stray "<" from ${payload} -> ${out}`);
    assert.ok(!stripped.includes('>'), `stray ">" from ${payload} -> ${out}`);
    assert.ok(!/<script/i.test(out), `script tag survived: ${payload} -> ${out}`);
    assert.ok(!/<(img|svg|iframe|a)\s[^>]*\son\w+=/i.test(out), `live handler: ${payload} -> ${out}`);
  }
});

test('an href we emit is only ever one we built', () => {
  // The only href in the output must be the validated URL, never one carried
  // in from the payload text.
  const out = renderMarkdown('<a href="https://evil.com">click</a> [ok](https://good.org)');
  const hrefs = [...out.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ['https://good.org']);
});

test('a forged placeholder cannot inject a link', () => {
  // Escaping runs before tokenising, so "<" in input is already &lt; and can
  // never fabricate a <L0>. Index 0 exists here, which is the dangerous case.
  const out = renderMarkdown('<L0> [real](https://x.org)');
  assert.ok(out.includes('&lt;L0&gt;'), `forged placeholder should be inert text, got: ${out}`);
  assert.equal(out.match(/<a /g).length, 1);
});

test('OUTPUT ALLOW-LIST: nothing outside p/br/ul/li/strong/a is ever emitted', () => {
  const corpus = [
    'Hello **world**.\n\n- a\n- b\n\n[t](https://x.org) and [r](/x.html)',
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg/onload=alert(1)>',
    '[x]("onmouseover="alert(1))',
    '&lt;script&gt;',
    '<table><tr><td>x</td></tr></table>',
    '# heading\n> quote\n`code`\n![img](https://x.org/a.png)',
    '<L0><L1><L2>',
  ];
  for (const input of corpus) {
    const stripped = renderMarkdown(input).replace(ALLOWED_TAGS, '');
    assert.ok(!stripped.includes('<'), `stray "<" from: ${input} -> ${stripped}`);
    assert.ok(!stripped.includes('>'), `stray ">" from: ${input} -> ${stripped}`);
  }
});

test('an ampersand in a URL is escaped exactly once', () => {
  const href = renderMarkdown('[t](https://x.org/?a=1&b=2)').match(/href="([^"]*)"/)[1];
  assert.equal(href, 'https://x.org/?a=1&amp;b=2');
  assert.ok(!href.includes('&amp;amp;'));
});

test('rendering is deliberately NOT idempotent — never feed output back in', () => {
  assert.equal(renderMarkdown('a & b'), '<p>a &amp; b</p>');
  assert.equal(renderMarkdown('a &amp; b'), '<p>a &amp;amp; b</p>');
});

test('bold is not spliced into a link href', () => {
  const out = renderMarkdown('[a](https://x.org/b**c**d)');
  assert.ok(out.includes('href="https://x.org/b**c**d"'));
  assert.ok(!out.includes('<strong>'));
});

test('markdownToPlainText strips markup syntax', () => {
  assert.equal(markdownToPlainText('Hello **world**'), 'Hello world');
  assert.equal(markdownToPlainText('- a\n- b'), 'a b');
  assert.equal(markdownToPlainText('see [help](/x.html)'), 'see help');
  assert.equal(markdownToPlainText(null), '');
  assert.equal(markdownToPlainText('a\n\n\nb'), 'a b');
});

test('markdownToPlainText does NOT escape — callers must, and this pins that contract', () => {
  // Documented hazard: the output is bare text for textContent / escAttr(),
  // never for innerHTML. Asserted so nobody "fixes" it into a second escaper
  // and leaves callers double-escaping.
  assert.equal(markdownToPlainText('<script>alert(1)</script>'), '<script>alert(1)</script>');
});

test('excerpt truncates on a word boundary', () => {
  assert.equal(excerpt('short answer'), 'short answer');
  const long = excerpt('word '.repeat(100), 40);
  assert.ok(long.length <= 43, `too long: ${long.length}`); // max 40 + '...'
  assert.ok(long.endsWith('...'));
  assert.ok(!long.includes('  '));
});

test('adversarial input returns promptly and never throws', () => {
  const big = 'a'.repeat(100000);
  for (const input of [big, `${big}**${big}`, '**'.repeat(20000), '[a](b'.repeat(10000), '- '.repeat(50000)]) {
    const started = Date.now();
    assert.doesNotThrow(() => renderMarkdown(input));
    assert.ok(Date.now() - started < 2000, 'renderMarkdown took too long');
  }
});
