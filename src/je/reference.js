import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/connection.js';
import { audit } from '../audit/log.js';

// Job-evaluation reference data: rulesets (factors, level points, band
// boundaries, profiles, match rules, limitation-rule parameters) are DATA —
// validated, checksummed, versioned and approved. Nothing in application
// code may carry a scheme constant; everything reads a ruleset bundle.

const MATCH_RULE_KEYS = new Set(['boundaryMarginPoints', 'shortlistLimit', 'matchToleranceFactors']);
const LIMITATION_KEYS = new Set(['code', 'label', 'baseEvent', 'unit', 'amount', 'minusOneDay', 'warnDays', 'note']);

const isSlug = (s) => typeof s === 'string' && /^[a-z][a-z0-9_]{1,40}$/.test(s);
const isPosInt = (n) => Number.isInteger(n) && n > 0;

// Deterministic, all-or-nothing bundle validation. Returns { ok, errors }.
export function validateRulesetBundle(bundle) {
  const errors = [];
  const e = (msg) => errors.push(msg);
  if (!bundle || typeof bundle !== 'object') return { ok: false, errors: ['Bundle is not an object.'] };

  if (!isSlug(bundle.scheme || '')) e('scheme must be a lowercase slug.');
  if (!String(bundle.label || '').trim()) e('label is required.');

  // Factors and levels.
  const factors = Array.isArray(bundle.factors) ? bundle.factors : [];
  if (factors.length < 1 || factors.length > 64) e('factors must contain between 1 and 64 entries.');
  const codes = new Set();
  for (const f of factors) {
    if (!isSlug(f?.code || '')) { e(`factor code "${f?.code}" is not a valid slug.`); continue; }
    if (codes.has(f.code)) e(`duplicate factor code "${f.code}".`);
    codes.add(f.code);
    if (!String(f.name || '').trim()) e(`factor ${f.code}: name is required.`);
    if (!isPosInt(f.seq)) e(`factor ${f.code}: seq must be a positive integer.`);
    const levels = Array.isArray(f.levels) ? f.levels : [];
    if (levels.length < 2) e(`factor ${f.code}: at least 2 levels are required.`);
    const labels = new Set();
    let prevPoints = 0;
    for (const l of levels) {
      const label = String(l?.label ?? '').trim();
      if (!label || label.length > 4) e(`factor ${f.code}: level label "${label}" is invalid.`);
      if (labels.has(label)) e(`factor ${f.code}: duplicate level label "${label}".`);
      labels.add(label);
      if (!isPosInt(l?.points)) e(`factor ${f.code} level ${label}: points must be a positive integer.`);
      else if (l.points <= prevPoints) e(`factor ${f.code} level ${label}: points must strictly increase with level order.`);
      prevPoints = isPosInt(l?.points) ? l.points : prevPoints;
      if (!String(l?.descriptor || '').trim()) e(`factor ${f.code} level ${label}: descriptor is required.`);
    }
  }

  // Band boundaries: unique labels, contiguous, ascending, starting at 0.
  const bands = Array.isArray(bundle.bands) ? bundle.bands : [];
  if (bands.length < 2) e('bands must contain at least 2 entries.');
  const bandLabels = new Set();
  let prevMax = -1;
  bands.forEach((b, i) => {
    const label = String(b?.label ?? '').trim();
    if (!label) e(`band #${i + 1}: label is required.`);
    if (bandLabels.has(label)) e(`duplicate band label "${label}".`);
    bandLabels.add(label);
    if (!Number.isInteger(b?.min) || !Number.isInteger(b?.max) || b.min < 0 || b.max < b.min) {
      e(`band ${label}: min/max must be integers with min <= max.`);
      return;
    }
    if (b.min !== prevMax + 1) e(`band ${label}: boundaries must be contiguous (expected min ${prevMax + 1}, got ${b.min}).`);
    prevMax = b.max;
  });

  // Profiles reference real factors and levels.
  const profiles = Array.isArray(bundle.profiles) ? bundle.profiles : [];
  const profileCodes = new Set();
  const levelSeqOf = (factorCode, label) => {
    const f = factors.find((x) => x?.code === factorCode);
    const idx = (f?.levels || []).findIndex((l) => String(l?.label) === String(label));
    return idx === -1 ? null : idx;
  };
  for (const p of profiles) {
    if (!isSlug(p?.code || '')) { e(`profile code "${p?.code}" is not a valid slug.`); continue; }
    if (profileCodes.has(p.code)) e(`duplicate profile code "${p.code}".`);
    profileCodes.add(p.code);
    if (!String(p.title || '').trim()) e(`profile ${p.code}: title is required.`);
    if (!bandLabels.has(String(p.band ?? ''))) e(`profile ${p.code}: band "${p.band}" is not a defined band.`);
    for (const [factorCode, range] of Object.entries(p.factorLevels || {})) {
      if (!codes.has(factorCode)) { e(`profile ${p.code}: unknown factor "${factorCode}".`); continue; }
      const [lo, hi] = Array.isArray(range) ? range : [range, range];
      const loSeq = levelSeqOf(factorCode, lo);
      const hiSeq = levelSeqOf(factorCode, hi);
      if (loSeq === null || hiSeq === null) e(`profile ${p.code}: level range for ${factorCode} references unknown levels.`);
      else if (loSeq > hiSeq) e(`profile ${p.code}: level range for ${factorCode} has min above max.`);
    }
  }

  // Match rules: known keys, positive integers.
  for (const [k, v] of Object.entries(bundle.matchRules || {})) {
    if (!MATCH_RULE_KEYS.has(k)) e(`matchRules: unknown key "${k}".`);
    else if (!isPosInt(v)) e(`matchRules.${k}: must be a positive integer.`);
  }

  // Limitation rules: known keys, sane shapes. Amounts may be null (local
  // procedure), but a rule must always carry a human note.
  for (const r of Array.isArray(bundle.limitationRules) ? bundle.limitationRules : []) {
    for (const k of Object.keys(r || {})) if (!LIMITATION_KEYS.has(k)) e(`limitationRules: unknown key "${k}".`);
    if (!isSlug(r?.code || '')) e(`limitationRules: code "${r?.code}" is not a valid slug.`);
    if (r?.amount !== null && r?.amount !== undefined && !isPosInt(r.amount)) e(`limitationRules ${r?.code}: amount must be a positive integer or null.`);
    if (r?.amount != null && !['days', 'months'].includes(r?.unit)) e(`limitationRules ${r?.code}: unit must be days or months.`);
    if (!String(r?.note || '').trim()) e(`limitationRules ${r?.code}: note is required.`);
  }

  return { ok: errors.length === 0, errors };
}

// Stable canonical checksum over the parts that affect computation.
export function canonicalChecksum(bundle) {
  const canon = JSON.stringify({
    scheme: bundle.scheme,
    factors: (bundle.factors || []).map((f) => [f.code, f.seq, f.name, (f.levels || []).map((l) => [String(l.label), l.points])]),
    bands: (bundle.bands || []).map((b) => [String(b.label), b.min, b.max]),
    profiles: (bundle.profiles || []).map((p) => [p.code, String(p.band), p.factorLevels || {}]),
    matchRules: bundle.matchRules || {},
    limitationRules: bundle.limitationRules || [],
  });
  return crypto.createHash('sha256').update(canon).digest('hex');
}

// Insert a validated bundle. status: 'draft' unless approve is set.
// Approving supersedes the currently approved ruleset for the scheme.
export function insertRulesetBundle(bundle, { origin = 'import', createdBy = null, approve = false, approvedBy = null } = {}) {
  const check = validateRulesetBundle(bundle);
  if (!check.ok) return { error: 'Ruleset failed validation.', status: 400, errors: check.errors };
  const checksum = canonicalChecksum(bundle);
  const existing = db.prepare('SELECT id FROM je_rulesets WHERE checksum = ?').get(checksum);
  if (existing) return { error: 'An identical ruleset already exists.', status: 409, rulesetId: existing.id };

  const current = approve
    ? db.prepare(`SELECT id FROM je_rulesets WHERE scheme = ? AND status = 'approved'`).get(bundle.scheme)
    : null;

  db.exec('BEGIN');
  try {
    if (current) db.prepare(`UPDATE je_rulesets SET status = 'superseded' WHERE id = ?`).run(current.id);
    const info = db
      .prepare(
        `INSERT INTO je_rulesets (label, scheme, status, origin, effective_from, checksum, match_rules_json, limitation_rules_json, source_note, supersedes_id, created_by, approved_by, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(bundle.label).trim().slice(0, 200),
        bundle.scheme,
        approve ? 'approved' : 'draft',
        origin,
        bundle.effectiveFrom || null,
        checksum,
        JSON.stringify(bundle.matchRules || {}),
        JSON.stringify(bundle.limitationRules || []),
        String(bundle.sourceNote || '').slice(0, 2000),
        current?.id || null,
        createdBy,
        approve ? approvedBy ?? createdBy : null,
        approve ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null
      );
    const rulesetId = info.lastInsertRowid;

    const factorStmt = db.prepare('INSERT INTO je_factors (ruleset_id, code, seq, name, description, guidance) VALUES (?, ?, ?, ?, ?, ?)');
    const levelStmt = db.prepare('INSERT INTO je_factor_levels (ruleset_id, factor_code, level_seq, level_label, points, descriptor) VALUES (?, ?, ?, ?, ?, ?)');
    for (const f of bundle.factors) {
      factorStmt.run(rulesetId, f.code, f.seq, f.name, String(f.description || ''), String(f.guidance || ''));
      f.levels.forEach((l, i) => levelStmt.run(rulesetId, f.code, i + 1, String(l.label), l.points, String(l.descriptor || '')));
    }
    const bandStmt = db.prepare('INSERT INTO je_band_boundaries (ruleset_id, band_label, seq, min_points, max_points) VALUES (?, ?, ?, ?, ?)');
    bundle.bands.forEach((b, i) => bandStmt.run(rulesetId, String(b.label), i + 1, b.min, b.max));

    const profStmt = db.prepare('INSERT INTO je_profiles (ruleset_id, profile_code, title, job_family, band_label, notes) VALUES (?, ?, ?, ?, ?, ?)');
    const profLevelStmt = db.prepare('INSERT INTO je_profile_levels (profile_id, factor_code, level_min, level_max, notes) VALUES (?, ?, ?, ?, ?)');
    for (const p of bundle.profiles || []) {
      const pInfo = profStmt.run(rulesetId, p.code, String(p.title).trim().slice(0, 200), String(p.jobFamily || '').slice(0, 120), String(p.band), String(p.notes || '').slice(0, 1000));
      for (const [factorCode, range] of Object.entries(p.factorLevels || {})) {
        const [lo, hi] = Array.isArray(range) ? range : [range, range];
        profLevelStmt.run(pInfo.lastInsertRowid, factorCode, String(lo), String(hi), '');
      }
    }
    db.exec('COMMIT');
    bundleCache.delete(rulesetId);
    return { ok: true, rulesetId, checksum, superseded: current?.id || null };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function activeRuleset(scheme = 'afc') {
  return db.prepare(`SELECT * FROM je_rulesets WHERE scheme = ? AND status = 'approved'`).get(scheme) || null;
}

// Assembled read model for scoring. Approved rulesets are immutable, so the
// cache is safe; draft bundles are never cached.
const bundleCache = new Map();
export function getRulesetBundle(rulesetId) {
  if (bundleCache.has(rulesetId)) return bundleCache.get(rulesetId);
  const ruleset = db.prepare('SELECT * FROM je_rulesets WHERE id = ?').get(Number(rulesetId));
  if (!ruleset) return null;
  const factors = db.prepare('SELECT * FROM je_factors WHERE ruleset_id = ? ORDER BY seq').all(ruleset.id);
  const levels = db.prepare('SELECT * FROM je_factor_levels WHERE ruleset_id = ? ORDER BY factor_code, level_seq').all(ruleset.id);
  const bands = db.prepare('SELECT * FROM je_band_boundaries WHERE ruleset_id = ? ORDER BY seq').all(ruleset.id);
  const levelsByFactor = new Map();
  for (const l of levels) {
    if (!levelsByFactor.has(l.factor_code)) levelsByFactor.set(l.factor_code, []);
    levelsByFactor.get(l.factor_code).push({ label: l.level_label, points: l.points, seq: l.level_seq, descriptor: l.descriptor });
  }
  const bundle = {
    ruleset,
    factors: factors.map((f) => ({
      code: f.code, seq: f.seq, name: f.name, description: f.description, guidance: f.guidance,
      levels: levelsByFactor.get(f.code) || [],
    })),
    bands: bands.map((b) => ({ label: b.band_label, min: b.min_points, max: b.max_points, seq: b.seq })),
    matchRules: safeJson(ruleset.match_rules_json, {}),
    limitationRules: safeJson(ruleset.limitation_rules_json, []),
  };
  if (ruleset.status !== 'draft') bundleCache.set(ruleset.id, bundle);
  return bundle;
}

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

// Readiness gate: scoring requires an approved ruleset with factors,
// levels and contiguous bands. Returns { ready, reasons }.
export function referenceReady(scheme = 'afc') {
  const reasons = [];
  const ruleset = activeRuleset(scheme);
  if (!ruleset) return { ready: false, reasons: ['No approved ruleset for this scheme.'] };
  const bundle = getRulesetBundle(ruleset.id);
  if (bundle.factors.length === 0) reasons.push('Ruleset has no factors.');
  if (bundle.factors.some((f) => f.levels.length < 2)) reasons.push('A factor has fewer than 2 levels.');
  if (bundle.bands.length < 2) reasons.push('Ruleset has no band boundaries.');
  return { ready: reasons.length === 0, reasons, rulesetId: ruleset.id };
}

// Seed the bundled AfC ruleset on first run (user decision: works out of the
// box; admin verifies or replaces it). Origin 'seed' + unverified status is
// surfaced in the admin UI and on every report footer until verified.
export function seedJeRuleset() {
  const any = db.prepare(`SELECT COUNT(*) AS n FROM je_rulesets WHERE scheme = 'afc'`).get().n;
  if (any > 0) return null;
  const seedPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed', 'afc-ruleset.json');
  const bundle = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const result = insertRulesetBundle(bundle, { origin: 'seed', approve: true });
  if (result.ok) {
    audit(null, 'je.reference_seeded', 'je_ruleset', result.rulesetId, {
      checksum: result.checksum,
      factorCount: bundle.factors.length,
      bandCount: bundle.bands.length,
      profileCount: (bundle.profiles || []).length,
    });
  }
  return result;
}
