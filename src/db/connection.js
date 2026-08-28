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
  // v2 — assistant conversations become threads; existing history moves
  // into one "Conversation 1" thread per user.
  `ALTER TABLE assistant_messages ADD COLUMN thread_id INTEGER;
   ALTER TABLE assistant_actions ADD COLUMN thread_id INTEGER;
   INSERT INTO assistant_threads (user_id, title)
     SELECT DISTINCT user_id, 'Conversation 1' FROM assistant_messages;
   UPDATE assistant_messages SET thread_id =
     (SELECT t.id FROM assistant_threads t WHERE t.user_id = assistant_messages.user_id LIMIT 1)
     WHERE thread_id IS NULL;
   UPDATE assistant_actions SET thread_id =
     (SELECT t.id FROM assistant_threads t WHERE t.user_id = assistant_actions.user_id LIMIT 1)
     WHERE thread_id IS NULL;`,
  // v3 — job evaluation: ai_outputs may belong to a JE review instead of a
  // case (rebuild: case_id becomes nullable; je_review_id/je_stage added);
  // notifications learn to deep-link to a review. Runs with foreign_keys
  // OFF (see the migration loop) so the rebuild cannot cascade-delete
  // citations rows.
  `CREATE TABLE ai_outputs_v3 (
     id INTEGER PRIMARY KEY,
     case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
     je_review_id INTEGER REFERENCES je_reviews(id) ON DELETE CASCADE,
     je_stage TEXT,
     task TEXT NOT NULL,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     prompt_version TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'ok',
     output_json TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   INSERT INTO ai_outputs_v3 (id, case_id, task, provider, model, prompt_version, status, output_json, created_at)
     SELECT id, case_id, task, provider, model, prompt_version, status, output_json, created_at FROM ai_outputs;
   DROP TABLE ai_outputs;
   ALTER TABLE ai_outputs_v3 RENAME TO ai_outputs;
   CREATE INDEX IF NOT EXISTS idx_ai_case ON ai_outputs(case_id);
   CREATE INDEX IF NOT EXISTS idx_ai_je ON ai_outputs(je_review_id, je_stage);
   ALTER TABLE notifications ADD COLUMN je_review_id INTEGER REFERENCES je_reviews(id) ON DELETE CASCADE;`,
  // v4 — membership: structured NHS pay band on accounts; AI runs attributed
  // to the member whose allowance they consume. Index lives here (not
  // schema.sql) because on a fresh DB schema runs before this column exists.
  `ALTER TABLE users ADD COLUMN pay_band TEXT NOT NULL DEFAULT '';
   ALTER TABLE ai_outputs ADD COLUMN billed_user_id INTEGER;
   CREATE INDEX IF NOT EXISTS idx_ai_outputs_billed ON ai_outputs(billed_user_id, created_at);`,
  // v5 — contact messages: notifications learn to deep-link to a message
  // thread, alongside the existing case and band-review links.
  `ALTER TABLE notifications ADD COLUMN thread_id INTEGER REFERENCES message_threads(id) ON DELETE CASCADE;`,
];
{
  let version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < MIGRATIONS.length) {
    // FK enforcement off for the duration so table rebuilds (drop + rename)
    // cannot cascade-delete dependent rows; re-enabled straight after.
    db.exec('PRAGMA foreign_keys = OFF');
    while (version < MIGRATIONS.length) {
      db.exec('BEGIN');
      db.exec(MIGRATIONS[version]);
      version += 1;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    }
    db.exec('PRAGMA foreign_keys = ON');
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

// Seed the three membership tiers. INSERT OR IGNORE: admin edits survive.
export function seedMembershipTiers() {
  db.exec(`INSERT OR IGNORE INTO membership_tiers (id, name, price_pence, ai_daily_allowance, rank) VALUES
    ('pilot', 'Pilot', 0, 3, 0),
    ('standard', 'Standard', 799, 6, 1),
    ('plus', 'Plus', 1499, 15, 2)`);
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
