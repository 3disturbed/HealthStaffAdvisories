import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { config } from '../config.js';

// Shared upload validation, storage and text extraction, used by both the
// case documents API and the job-evaluation documents API. Validates the
// real file type by magic bytes, not just the extension (SDD §8).
export const DOCUMENT_TYPES = {
  pdf: { mime: 'application/pdf', magic: (b) => b.slice(0, 5).toString() === '%PDF-' },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    magic: (b) => b[0] === 0x50 && b[1] === 0x4b, // ZIP container
  },
  txt: { mime: 'text/plain', magic: () => true },
};

// Returns { kind } or { error }.
export function classifyUpload(file) {
  if (!file) return { error: 'No file received.' };
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  const kind = DOCUMENT_TYPES[ext] ? ext : null;
  if (!kind || !DOCUMENT_TYPES[kind].magic(file.buffer)) {
    return { error: 'Only PDF, DOCX and TXT files are supported at the moment.' };
  }
  return { kind };
}

// Content-addressed private storage. Returns { storageKey, sha256, safeName }.
export function storeUpload(file, kind) {
  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const storageKey = `${sha256}.${kind}`;
  fs.writeFileSync(path.join(config.uploadDir, storageKey), file.buffer);
  const safeName = path.basename(file.originalname).slice(0, 200);
  return { storageKey, sha256, safeName };
}

export async function extractText(kind, buffer) {
  if (kind === 'txt') return buffer.toString('utf8').slice(0, 200000);
  if (kind === 'pdf') return (await pdfParse(buffer)).text.slice(0, 200000);
  if (kind === 'docx') return (await mammoth.extractRawText({ buffer })).value.slice(0, 200000);
  return '';
}
