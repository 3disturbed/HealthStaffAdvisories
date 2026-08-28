// Deterministic job-evaluation arithmetic. Pure functions over a ruleset
// bundle (see je/reference.js getRulesetBundle). No I/O, no LLM — points,
// totals, band lookup and profile fit are never model output.

function levelsFor(bundle, factorCode) {
  const f = bundle.factors.find((x) => x.code === factorCode);
  return f ? f.levels : [];
}

function levelEntry(bundle, factorCode, levelLabel) {
  if (levelLabel === null || levelLabel === undefined || levelLabel === '') return null;
  return levelsFor(bundle, factorCode).find((l) => String(l.label) === String(levelLabel)) || null;
}

// levels: plain object or Map of factorCode -> levelLabel|null.
// Returns { perFactor, totalPoints, missing, complete }.
export function scoreLevels(bundle, levels) {
  const get = (code) => (levels instanceof Map ? levels.get(code) : levels?.[code]);
  const perFactor = [];
  const missing = [];
  let totalPoints = 0;
  for (const f of bundle.factors) {
    const label = get(f.code) ?? null;
    const entry = levelEntry(bundle, f.code, label);
    if (!entry) {
      missing.push(f.code);
      perFactor.push({ factorCode: f.code, levelLabel: null, points: null });
    } else {
      totalPoints += entry.points;
      perFactor.push({ factorCode: f.code, levelLabel: entry.label, points: entry.points });
    }
  }
  return { perFactor, totalPoints, missing, complete: missing.length === 0 };
}

// Band containing a points total, or null when outside every boundary.
export function bandForPoints(bundle, points) {
  if (!Number.isInteger(points) || points < 0) return null;
  const band = bundle.bands.find((b) => points >= b.min && points <= b.max);
  return band ? band.label : null;
}

// Sensitivity range. Missing factors are UNKNOWN: they widen the range from
// the factor's minimum to its maximum points — absence of evidence must
// widen uncertainty, never score low. Low/insufficient confidence widens the
// proposed level by ±1 level.
export function bandRange(bundle, levels, confidenceByFactor = {}) {
  const get = (code) => (levels instanceof Map ? levels.get(code) : levels?.[code]);
  const conf = (code) => (confidenceByFactor instanceof Map ? confidenceByFactor.get(code) : confidenceByFactor?.[code]) || 'high';
  let low = 0;
  let high = 0;
  for (const f of bundle.factors) {
    const lvls = f.levels;
    if (lvls.length === 0) continue;
    const entry = levelEntry(bundle, f.code, get(f.code) ?? null);
    if (!entry) {
      low += lvls[0].points;
      high += lvls[lvls.length - 1].points;
      continue;
    }
    const idx = lvls.findIndex((l) => l.label === entry.label);
    if (conf(f.code) === 'low' || conf(f.code) === 'insufficient') {
      low += lvls[Math.max(0, idx - 1)].points;
      high += lvls[Math.min(lvls.length - 1, idx + 1)].points;
    } else {
      low += entry.points;
      high += entry.points;
    }
  }
  // Clamp band lookups into the boundary table: totals above the top band
  // report the top band at the low end only when actually inside it.
  return {
    pointsLow: low,
    pointsHigh: high,
    bandLow: bandForPoints(bundle, low) || '',
    bandHigh: bandForPoints(bundle, high) || (high > topBoundary(bundle) ? topBandLabel(bundle) : ''),
  };
}

function topBoundary(bundle) {
  return bundle.bands.length ? bundle.bands[bundle.bands.length - 1].max : 0;
}
function topBandLabel(bundle) {
  return bundle.bands.length ? bundle.bands[bundle.bands.length - 1].label : '';
}

// Assembled outcome. A single band is asserted ONLY when every factor has a
// level AND the sensitivity range collapses to one band; otherwise the
// outcome carries a range. Confidence is a coarse deterministic grade.
export function computeOutcome(bundle, levels, confidenceByFactor = {}) {
  const score = scoreLevels(bundle, levels);
  const range = bandRange(bundle, levels, confidenceByFactor);
  const confValues = bundle.factors.map((f) =>
    (confidenceByFactor instanceof Map ? confidenceByFactor.get(f.code) : confidenceByFactor?.[f.code]) || 'high'
  );
  const lowish = confValues.filter((c) => c === 'low' || c === 'insufficient').length;
  const confidence = !score.complete || lowish >= 3 ? 'low' : lowish > 0 || confValues.includes('medium') ? 'medium' : 'high';
  const assertBand = score.complete && range.bandLow && range.bandLow === range.bandHigh;
  return {
    totalPoints: score.totalPoints,
    bandLabel: assertBand ? range.bandLow : '',
    pointsLow: range.pointsLow,
    pointsHigh: range.pointsHigh,
    bandLow: range.bandLow,
    bandHigh: range.bandHigh,
    confidence,
    factorsMissing: score.missing.length,
    perFactor: score.perFactor,
    missing: score.missing,
    complete: score.complete,
  };
}

// Deterministic profile fit. profile.factorLevels: { factorCode: [lo, hi] }
// (labels). fit: 'match' when every assessed factor sits inside the profile
// range; 'partial' when at most matchToleranceFactors sit outside by one
// level; otherwise 'no_match'. Factors without an assessed level are
// reported, not judged.
export function matchProfile(bundle, profileLevels, levels, { matchToleranceFactors = 2 } = {}) {
  const get = (code) => (levels instanceof Map ? levels.get(code) : levels?.[code]);
  const factorsOutside = [];
  const unassessed = [];
  for (const [factorCode, range] of Object.entries(profileLevels || {})) {
    const lvls = levelsFor(bundle, factorCode);
    if (lvls.length === 0) continue;
    const [lo, hi] = Array.isArray(range) ? range : [range, range];
    const loIdx = lvls.findIndex((l) => String(l.label) === String(lo));
    const hiIdx = lvls.findIndex((l) => String(l.label) === String(hi));
    const entry = levelEntry(bundle, factorCode, get(factorCode) ?? null);
    if (!entry) { unassessed.push(factorCode); continue; }
    const idx = lvls.findIndex((l) => l.label === entry.label);
    if (loIdx === -1 || hiIdx === -1) continue;
    if (idx < loIdx || idx > hiIdx) {
      factorsOutside.push({
        factorCode,
        level: entry.label,
        min: lvls[loIdx].label,
        max: lvls[hiIdx].label,
        deviation: idx < loIdx ? idx - loIdx : idx - hiIdx,
      });
    }
  }
  const withinTolerance = factorsOutside.length <= matchToleranceFactors && factorsOutside.every((f) => Math.abs(f.deviation) <= 1);
  const fit = factorsOutside.length === 0 ? 'match' : withinTolerance ? 'partial' : 'no_match';
  return { fit, factorsOutside, unassessed };
}
