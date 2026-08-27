import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader — values already present in the environment win.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || './data');

export const config = {
  root: ROOT,
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, 'kelly.db'),
  uploadDir: path.join(DATA_DIR, 'uploads'),
  adminEmail: (process.env.ADMIN_EMAIL || 'mapadocrew@gmail.com').toLowerCase(),
  adminInitialPassword: process.env.ADMIN_INITIAL_PASSWORD || '',
  defaultAiModel: 'gpt-5.1',
  mailMode: process.env.MAIL_MODE || 'mailbox',
  sessionTtlHours: 12,
  maxUploadBytes: 15 * 1024 * 1024,
};

fs.mkdirSync(config.uploadDir, { recursive: true });
