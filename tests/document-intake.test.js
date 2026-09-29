import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-intake-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tmp;

const { extractText } = await import('../src/services/documentIntake.js');

// A minimal one-page PDF built by hand. Buffer.from(string) lands small
// results in Node's shared 8 KB pool, so the bytes usually sit at a
// non-zero byteOffset — the case that used to break pdf-parse.
function makePdf(text) {
  const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  // The binary-marker comment on line 2 is what real PDF writers emit; the
  // pdf.js bundled in pdf-parse rejects this hand-built file without it.
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f\r\n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n\r\n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('small PDFs parse even from a shared buffer pool slice', async () => {
  for (let i = 0; i < 3; i++) {
    Buffer.from('x'.repeat(1000)); // push the pool offset past zero
    const pdf = makePdf(`Pool offset check ${i}`);
    assert.ok(pdf.byteOffset > 0, 'fixture should sit inside the shared pool');
    assert.match(await extractText('pdf', pdf), new RegExp(`Pool offset check ${i}`));
  }
});

test('an unpooled PDF buffer still parses after pooled ones', async () => {
  const pooled = makePdf('Unpooled check');
  const pdf = Buffer.alloc(pooled.length);
  pooled.copy(pdf);
  assert.equal(pdf.byteOffset, 0);
  assert.match(await extractText('pdf', pdf), /Unpooled check/);
});
