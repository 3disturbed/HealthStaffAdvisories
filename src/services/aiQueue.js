import { db } from '../db/connection.js';
import { aiEnabled } from '../ai/provider.js';
import { runIntake } from '../ai/intake.js';
import { currentSubscription, parseDbDate, toDbTs } from './membership.js';

// AI usage allowance per tier per rolling 24 h. The rule is NEVER reject —
// an exhausted allowance queues the job and the worker runs it when
// allowance frees. Advisor-triggered runs call runIntake directly with
// billedUserId null: they bypass this module entirely and never count.

const MAX_ATTEMPTS = 2;

export function aiAllowanceState(userId, now = new Date()) {
  const { tier } = currentSubscription(userId, now);
  const allowance = tier?.aiDailyAllowance ?? 3;
  const windowStart = toDbTs(new Date(now - 86400000));
  const usedRows = db
    .prepare(`SELECT COUNT(*) AS n FROM ai_outputs WHERE billed_user_id = ? AND created_at > ?`)
    .get(userId, windowStart).n;
  // In-flight runs hold a reservation so concurrent requests cannot overspend.
  const running = db
    .prepare(`SELECT COUNT(*) AS n FROM ai_jobs WHERE user_id = ? AND status = 'running'`)
    .get(userId).n;
  const used = usedRows + running;
  const remaining = Math.max(0, allowance - used);

  let nextFreeAt = null;
  if (remaining === 0) {
    const overBy = Math.max(0, used - allowance);
    const row = db
      .prepare(`SELECT created_at FROM ai_outputs WHERE billed_user_id = ? AND created_at > ?
                ORDER BY created_at ASC LIMIT 1 OFFSET ?`)
      .get(userId, windowStart, overBy);
    nextFreeAt = row
      ? new Date(parseDbDate(row.created_at).getTime() + 86400000).toISOString()
      : new Date(now.getTime() + 10 * 60000).toISOString(); // all usage in-flight — recheck soon
  }
  return { ok: true, allowance, used, remaining, nextFreeAt };
}

function launch(jobId, caseId, userId, task) {
  runIntake(caseId, task, { billedUserId: userId })
    .then(() => {
      db.prepare(`UPDATE ai_jobs SET status = 'done', finished_at = datetime('now') WHERE id = ?`).run(jobId);
    })
    .catch((err) => {
      const job = db.prepare('SELECT attempts FROM ai_jobs WHERE id = ?').get(jobId);
      const attempts = (job?.attempts ?? 0) + 1;
      if (attempts < MAX_ATTEMPTS) {
        db.prepare(`UPDATE ai_jobs SET status = 'queued', attempts = ?, last_error = ?, not_before = datetime('now', '+5 minutes') WHERE id = ?`)
          .run(attempts, String(err.message).slice(0, 300), jobId);
      } else {
        db.prepare(`UPDATE ai_jobs SET status = 'failed', attempts = ?, last_error = ?, finished_at = datetime('now') WHERE id = ?`)
          .run(attempts, String(err.message).slice(0, 300), jobId);
      }
    });
}

// Synchronous check + reservation insert (node:sqlite is single-threaded),
// so two concurrent requests can never both pass an allowance of one.
export function enqueueOrRun({ caseId, userId, task = 'intake' }, now = new Date()) {
  if (!aiEnabled()) return { ok: true, skipped: 'ai_disabled' };
  const state = aiAllowanceState(userId, now);
  if (state.remaining > 0) {
    const info = db
      .prepare(`INSERT INTO ai_jobs (case_id, user_id, task, status, started_at) VALUES (?, ?, ?, 'running', datetime('now'))`)
      .run(caseId, userId, task);
    launch(info.lastInsertRowid, caseId, userId, task);
    return { ok: true, ran: true };
  }
  const info = db
    .prepare(`INSERT INTO ai_jobs (case_id, user_id, task, status, not_before) VALUES (?, ?, ?, 'queued', ?)`)
    .run(caseId, userId, task, toDbTs(new Date(state.nextFreeAt)));
  return { ok: true, queued: true, expectedAt: state.nextFreeAt, jobId: info.lastInsertRowid };
}

export function caseAiQueueState(caseId) {
  const row = db
    .prepare(`SELECT status, not_before FROM ai_jobs WHERE case_id = ? AND status IN ('queued','running')
              ORDER BY id DESC LIMIT 1`)
    .get(caseId);
  if (!row) return null;
  return {
    status: row.status,
    expectedAt: row.status === 'queued' && row.not_before ? parseDbDate(row.not_before).toISOString() : null,
  };
}

// Worker tick — server.js runs this on an interval; tests call it directly.
export async function processAiQueue(now = new Date()) {
  // Crash recovery: a run that never finished frees its reservation.
  db.prepare(`UPDATE ai_jobs SET status = 'queued', attempts = attempts + 1, not_before = NULL
              WHERE status = 'running' AND started_at < datetime('now', '-10 minutes')`).run();
  if (!aiEnabled()) return { promoted: 0 };

  const due = db
    .prepare(`SELECT * FROM ai_jobs WHERE status = 'queued' AND (not_before IS NULL OR not_before <= ?)
              ORDER BY requested_at ASC LIMIT 2`)
    .all(toDbTs(now));
  let promoted = 0;
  for (const job of due) {
    if (job.attempts >= MAX_ATTEMPTS) {
      db.prepare(`UPDATE ai_jobs SET status = 'failed', finished_at = datetime('now') WHERE id = ?`).run(job.id);
      continue;
    }
    const state = aiAllowanceState(job.user_id, now);
    if (state.remaining > 0) {
      db.prepare(`UPDATE ai_jobs SET status = 'running', started_at = datetime('now') WHERE id = ?`).run(job.id);
      launch(job.id, job.case_id, job.user_id, job.task);
      promoted += 1;
    } else {
      // Still exhausted — wait for the recomputed free slot. Never rejected.
      db.prepare(`UPDATE ai_jobs SET not_before = ? WHERE id = ?`).run(toDbTs(new Date(state.nextFreeAt)), job.id);
    }
  }
  return { promoted };
}
