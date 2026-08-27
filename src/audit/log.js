import { db } from '../db/connection.js';

// Audit events record actor + action + object identifiers only.
// Never place case narrative, document contents or secrets in `meta`.
export function audit(actorUserId, action, objectType = '', objectId = '', meta = {}) {
  db.prepare(
    'INSERT INTO audit_events (actor_user_id, action, object_type, object_id, meta) VALUES (?, ?, ?, ?, ?)'
  ).run(actorUserId ?? null, action, objectType, String(objectId), JSON.stringify(meta));
}
