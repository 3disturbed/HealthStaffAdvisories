import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { hashPassword } from '../auth/passwords.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

const schema = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'),
  'utf8'
);
db.exec(schema);

// Versioned migrations for columns added to existing tables after first
// release. New TABLES go in schema.sql (IF NOT EXISTS); new COLUMNS on
// existing tables go ONLY here, gated by PRAGMA user_version.
const MIGRATIONS = [
  // v1 — account preferences + evidence message metadata
  `ALTER TABLE users ADD COLUMN email_notifications INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE case_messages ADD COLUMN meta TEXT;`,
];
{
  let version = db.prepare('PRAGMA user_version').get().user_version;
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[version]);
    version += 1;
    db.exec(`PRAGMA user_version = ${version}`);
    db.exec('COMMIT');
  }
}

export function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// Seed the main administration account on first run.
export function seedAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(config.adminEmail);
  if (existing) return null;

  const password = config.adminInitialPassword || crypto.randomBytes(9).toString('base64url');
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, display_name, status, email_verified_at, is_main_admin)
       VALUES (?, ?, ?, 'active', datetime('now'), 1)`
    )
    .run(config.adminEmail, hashPassword(password), 'Administrator');
  const userId = info.lastInsertRowid;
  for (const role of ['admin', 'advisor']) {
    db.prepare('INSERT INTO user_roles (user_id, role, granted_by) VALUES (?, ?, ?)').run(userId, role, userId);
  }
  db.prepare(
    `INSERT INTO audit_events (actor_user_id, action, object_type, object_id) VALUES (?, 'admin.seeded', 'user', ?)`
  ).run(userId, String(userId));

  return config.adminInitialPassword ? { userId, password: null } : { userId, password };
}
