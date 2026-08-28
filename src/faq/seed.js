import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/connection.js';
import { audit } from '../audit/log.js';

// Starter FAQ so the public page is not empty on first boot. Mirrors
// seedJeRuleset() in src/je/reference.js: skipped entirely once any category
// exists, so it never fights an adviser's edits.
//
// Seed copy must stay PROCEDURAL, never advisory — no entitlements and no time
// limits. Static content is not reviewed per member, and deadline claims are
// governed by the deadline-safety rule in docs/SDD.md.
export function seedFaq() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM faq_categories').get().n;
  if (existing > 0) return null;

  const seedPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed', 'starter-faq.json');
  const bundle = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

  const insertCategory = db.prepare(
    `INSERT INTO faq_categories (slug, name, description, seq, status, visibility)
     VALUES (?, ?, ?, ?, 'published', ?)`
  );
  const insertQuestion = db.prepare(
    `INSERT INTO faq_questions (category_id, slug, question, answer, keywords, seq, status, visibility, published_at)
     VALUES (?, ?, ?, ?, ?, ?, 'published', ?, datetime('now'))`
  );

  let categoryCount = 0;
  let questionCount = 0;
  db.exec('BEGIN');
  try {
    for (const category of bundle.categories || []) {
      const info = insertCategory.run(
        category.slug,
        category.name,
        category.description || '',
        category.seq || 0,
        category.visibility || 'public'
      );
      categoryCount += 1;
      (category.questions || []).forEach((q, i) => {
        insertQuestion.run(
          info.lastInsertRowid,
          q.slug,
          q.question,
          q.answer,
          q.keywords || '',
          (i + 1) * 10,
          q.visibility || 'public'
        );
        questionCount += 1;
      });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  audit(null, 'faq.seeded', 'faq', '', { categoryCount, questionCount });
  return { ok: true, categoryCount, questionCount };
}
