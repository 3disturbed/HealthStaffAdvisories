// Deterministic evidence-gap ranking: which unresolved factors could move
// the outcome most? Ranked by the points swing between the plausible low
// and high reading of each factor, so the report's actionables target what
// could actually change the band — not what a model found interesting.

export function rankGaps(bundle, levels, confidenceByFactor = {}, { limit = 5 } = {}) {
  const get = (m, code) => (m instanceof Map ? m.get(code) : m?.[code]);
  const gaps = [];
  for (const f of bundle.factors) {
    const lvls = f.levels;
    if (lvls.length === 0) continue;
    const label = get(levels, f.code) ?? null;
    const conf = get(confidenceByFactor, f.code) || 'high';
    const idx = label === null ? -1 : lvls.findIndex((l) => String(l.label) === String(label));
    let swing = 0;
    let reason = '';
    if (idx === -1) {
      swing = lvls[lvls.length - 1].points - lvls[0].points;
      reason = 'no_level';
    } else if (conf === 'low' || conf === 'insufficient') {
      const lo = lvls[Math.max(0, idx - 1)].points;
      const hi = lvls[Math.min(lvls.length - 1, idx + 1)].points;
      swing = hi - lo;
      reason = 'low_confidence';
    }
    if (swing > 0) gaps.push({ factorCode: f.code, factorName: f.name, swing, reason });
  }
  gaps.sort((a, b) => b.swing - a.swing || a.factorCode.localeCompare(b.factorCode));
  return gaps.slice(0, limit);
}
