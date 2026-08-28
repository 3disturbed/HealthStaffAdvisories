import { db, getSetting, setSetting } from '../db/connection.js';
import { audit } from '../audit/log.js';
import {
  validateRulesetBundle, insertRulesetBundle, activeRuleset, getRulesetBundle, referenceReady,
} from '../je/reference.js';

// Reference-data administration: list/import/approve/verify rulesets, plus
// the service offer. All results follow the { error, status } | { ok, ... }
// service contract; audit meta carries ids/counts only.

export function listRulesets(scheme = 'afc') {
  const rows = db
    .prepare(
      `SELECT r.*, u1.email AS created_by_email, u2.email AS verified_by_email,
         (SELECT COUNT(*) FROM je_factors f WHERE f.ruleset_id = r.id) AS factor_count,
         (SELECT COUNT(*) FROM je_factor_levels l WHERE l.ruleset_id = r.id) AS level_count,
         (SELECT COUNT(*) FROM je_band_boundaries b WHERE b.ruleset_id = r.id) AS band_count,
         (SELECT COUNT(*) FROM je_profiles p WHERE p.ruleset_id = r.id) AS profile_count,
         (SELECT COUNT(*) FROM je_reviews v WHERE v.ruleset_id = r.id) AS review_count
       FROM je_rulesets r
       LEFT JOIN users u1 ON u1.id = r.created_by
       LEFT JOIN users u2 ON u2.id = r.verified_by
       WHERE r.scheme = ? ORDER BY r.id DESC`
    )
    .all(scheme);
  const readiness = referenceReady(scheme);
  return { ok: true, rulesets: rows.map(rulesetSummary), readiness };
}

function rulesetSummary(r) {
  return {
    id: r.id, label: r.label, scheme: r.scheme, status: r.status, origin: r.origin,
    effectiveFrom: r.effective_from, checksum: r.checksum, sourceNote: r.source_note,
    createdAt: r.created_at, createdBy: r.created_by_email || null,
    approvedAt: r.approved_at, verifiedAt: r.verified_at, verifiedBy: r.verified_by_email || null,
    factorCount: r.factor_count, levelCount: r.level_count, bandCount: r.band_count,
    profileCount: r.profile_count, reviewCount: r.review_count,
  };
}

export function getRulesetDetail(rulesetId) {
  const bundle = getRulesetBundle(Number(rulesetId));
  if (!bundle) return { error: 'Ruleset not found.', status: 404 };
  return { ok: true, bundle };
}

export function importRuleset(actor, rawBundle) {
  const check = validateRulesetBundle(rawBundle);
  if (!check.ok) return { error: 'Ruleset failed validation.', status: 400, errors: check.errors };
  const result = insertRulesetBundle(rawBundle, { origin: 'import', createdBy: actor.id, approve: false });
  if (result.error) return result;
  audit(actor.id, 'je.reference_imported', 'je_ruleset', result.rulesetId, {
    checksum: result.checksum,
    factorCount: rawBundle.factors.length,
    bandCount: rawBundle.bands.length,
    profileCount: (rawBundle.profiles || []).length,
  });
  return result;
}

// Approving a draft supersedes the current approved ruleset and flags every
// open review pinned to the superseded one (informational — outcomes on the
// old ruleset are never touched).
export function approveRuleset(actor, rulesetId) {
  const row = db.prepare('SELECT * FROM je_rulesets WHERE id = ?').get(Number(rulesetId));
  if (!row) return { error: 'Ruleset not found.', status: 404 };
  if (row.status !== 'draft') return { error: 'Only a draft ruleset can be approved.', status: 400 };

  const current = activeRuleset(row.scheme);
  db.exec('BEGIN');
  try {
    if (current) db.prepare(`UPDATE je_rulesets SET status = 'superseded' WHERE id = ?`).run(current.id);
    db.prepare(`UPDATE je_rulesets SET status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ?`)
      .run(actor.id, row.id);
    let flagged = 0;
    if (current) {
      const open = db
        .prepare(`SELECT id FROM je_reviews WHERE ruleset_id = ? AND stage NOT IN ('closed')`)
        .all(current.id);
      const stmt = db.prepare(
        `INSERT INTO je_flags (review_id, rule_id, severity, reason, detected_by)
         VALUES (?, 'superseded_ruleset', 'notice', 'The reference ruleset this review is pinned to has been superseded. A recompute on the new ruleset is available.', 'rules')`
      );
      for (const r of open) { stmt.run(r.id); flagged += 1; }
    }
    db.exec('COMMIT');
    audit(actor.id, 'je.reference_approved', 'je_ruleset', row.id, { superseded: current?.id || null, flaggedReviews: flagged });
    return { ok: true, rulesetId: row.id, superseded: current?.id || null, flaggedReviews: flagged };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Human verification: someone checked the loaded numbers against the
// published handbook. Distinct from approval; surfaced on every report.
export function verifyRuleset(actor, rulesetId) {
  const row = db.prepare('SELECT * FROM je_rulesets WHERE id = ?').get(Number(rulesetId));
  if (!row) return { error: 'Ruleset not found.', status: 404 };
  if (row.verified_at) return { error: 'Already verified.', status: 400 };
  db.prepare(`UPDATE je_rulesets SET verified_by = ?, verified_at = datetime('now') WHERE id = ?`).run(actor.id, row.id);
  audit(actor.id, 'je.reference_verified', 'je_ruleset', row.id, { checksum: row.checksum });
  return { ok: true };
}

// ── Service offer (pricing) ───────────────────────────────────────────────

export const DEFAULT_JE_OFFER = {
  enabled: true,
  priceGbp: 395,
  vatApplies: true,
  unit: 'per role',
  headline: 'Standard band review service',
  inclusions: [
    'Review of the job description and person specification',
    'Indicative assessment against the 16 AfC factors',
    'Likely profile/band observations',
    'Identification of missing or weak evidence',
    'One-hour consultation',
    'Concise written recommendations',
  ],
  note: 'Payment is arranged directly with Kelly — nothing is taken through this site.',
};

export function getOffer() {
  try {
    const stored = getSetting('je_offer');
    return stored ? { ...DEFAULT_JE_OFFER, ...JSON.parse(stored) } : { ...DEFAULT_JE_OFFER };
  } catch {
    return { ...DEFAULT_JE_OFFER };
  }
}

export function setOffer(actor, fields) {
  const current = getOffer();
  const next = { ...current };
  const changed = [];
  if (typeof fields.enabled === 'boolean') { next.enabled = fields.enabled; changed.push('enabled'); }
  if (fields.priceGbp !== undefined) {
    const p = Number(fields.priceGbp);
    if (!Number.isFinite(p) || p < 0 || p > 100000) return { error: 'Price must be a number between 0 and 100000.', status: 400 };
    next.priceGbp = Math.round(p * 100) / 100;
    changed.push('priceGbp');
  }
  if (typeof fields.vatApplies === 'boolean') { next.vatApplies = fields.vatApplies; changed.push('vatApplies'); }
  if (typeof fields.unit === 'string') { next.unit = fields.unit.trim().slice(0, 40) || 'per role'; changed.push('unit'); }
  if (typeof fields.headline === 'string') { next.headline = fields.headline.trim().slice(0, 120); changed.push('headline'); }
  if (Array.isArray(fields.inclusions)) {
    next.inclusions = fields.inclusions.slice(0, 12).map((i) => String(i).trim().slice(0, 200)).filter(Boolean);
    changed.push('inclusions');
  }
  if (typeof fields.note === 'string') { next.note = fields.note.trim().slice(0, 300); changed.push('note'); }
  if (changed.length === 0) return { error: 'Nothing to change.', status: 400 };
  setSetting('je_offer', JSON.stringify(next));
  audit(actor.id, 'je.offer_updated', 'settings', 'je_offer', { changed }); // names only, never values
  return { ok: true, offer: next, changed };
}
