import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

// Build fingerprint: a content hash of everything the browser downloads.
// Computed once at boot; the client compares the version it started with
// against this one and purges its caches when they differ.
function hashDirectory(dir, hash) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) hashDirectory(full, hash);
    else hash.update(entry.name).update(fs.readFileSync(full));
  }
}

function compute() {
  const hash = crypto.createHash('sha256');
  try {
    hashDirectory(path.join(config.root, 'public'), hash);
  } catch {
    return 'dev';
  }
  return hash.digest('hex').slice(0, 12);
}

export const BUILD_VERSION = compute();
