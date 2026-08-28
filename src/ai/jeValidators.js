import { scanForbidden, scanNumericClaims } from '../je/guard.js';

// Validators for JE pipeline stages. Model output is untrusted DATA: each
// validator builds its result key by key (whitelist), slices strings, caps
// arrays, and drops anything referencing an id we did not provide. Levels
// with no surviving evidence are forced to 'insufficient'. There is no
// key in any output shape where a points total or band could live.

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// S1: duties/responsibilities extracted from documents. A quote must be a
// verbatim substring of that document's extracted text or the item is
// dropped — the single strongest anti-hallucination check in the pipeline.
export function validateJdExtract(raw, { docTextById }) {
  const out = { items: [], notInJd: [], uncertainty: '', dropped: 0 };
  const take = (arr, kind) => {
    for (const item of (Array.isArray(arr) ? arr : []).slice(0, 40)) {
      const documentId = Number(item?.documentId);
      const quote = String(item?.quote || '').slice(0, 400);
      const text = String(item?.text || '').slice(0, 300);
      const docText = docTextById.get(documentId);
      if (!docText || !quote || !norm(docText).includes(norm(quote))) {
        out.dropped += 1;
        continue;
      }
      out.items.push({ documentId, quote, text, kind });
    }
  };
  take(raw?.duties, 'duty');
  take(raw?.responsibilities, 'responsibility');
  out.notInJd = (Array.isArray(raw?.notInJd) ? raw.notInJd : []).slice(0, 20).map((s) => String(s).slice(0, 300));
  out.uncertainty = String(raw?.uncertainty || '').slice(0, 600);
  return out;
}

// S2: evidence items mapped to factor codes.
export function validateFactorEvidence(raw, { factorCodes, evidenceIds }) {
  const out = { factors: [], dropped: 0 };
  const seen = new Set();
  for (const f of (Array.isArray(raw?.factors) ? raw.factors : []).slice(0, 32)) {
    const code = String(f?.factorCode || '');
    if (!factorCodes.has(code) || seen.has(code)) { out.dropped += 1; continue; }
    seen.add(code);
    const ids = (Array.isArray(f?.evidenceIds) ? f.evidenceIds : [])
      .map(String)
      .filter((id) => evidenceIds.has(id))
      .slice(0, 8);
    out.dropped += (Array.isArray(f?.evidenceIds) ? f.evidenceIds.length : 0) - ids.length;
    out.factors.push({
      factorCode: code,
      evidenceIds: [...new Set(ids)],
      summary: String(f?.summary || '').slice(0, 400),
      missing: String(f?.missing || '').slice(0, 300),
    });
  }
  return out;
}

// S4: indicative levels. A level that does not exist for the factor in the
// pinned ruleset becomes null + insufficient (never a nearest guess); a
// level with zero surviving evidence ids is forced to insufficient.
export function validateFactorLevels(raw, { levelsByFactor, evidenceIds }) {
  const out = { factors: [], dropped: 0 };
  const seen = new Set();
  for (const f of (Array.isArray(raw?.factors) ? raw.factors : []).slice(0, 32)) {
    const code = String(f?.factorCode || '');
    const levels = levelsByFactor.get(code);
    if (!levels || seen.has(code)) { out.dropped += 1; continue; }
    seen.add(code);
    const labels = new Set(levels.map((l) => String(l.label)));
    let levelLabel = labels.has(String(f?.levelLabel)) ? String(f.levelLabel) : null;
    let confidence = ['high', 'medium', 'low', 'insufficient'].includes(f?.confidence) ? f.confidence : 'insufficient';
    const ids = (Array.isArray(f?.evidenceIds) ? f.evidenceIds : [])
      .map(String)
      .filter((id) => evidenceIds.has(id))
      .slice(0, 8);
    if (levelLabel === null) confidence = 'insufficient';
    if (ids.length === 0) { levelLabel = null; confidence = 'insufficient'; } // no evidence, no proposal
    const alternative = labels.has(String(f?.alternativeLevel)) ? String(f.alternativeLevel) : null;
    out.factors.push({
      factorCode: code,
      levelLabel,
      confidence,
      alternativeLevel: alternative,
      rationale: String(f?.rationale || '').slice(0, 500),
      evidenceIds: [...new Set(ids)],
      gap: String(f?.gap || '').slice(0, 300),
    });
  }
  return out;
}

// S3b: profile fit commentary. Profile ids outside the deterministic
// shortlist are dropped; fit verdicts come from matchProfile(), never here.
export function validateProfileRank(raw, { profileIds }) {
  const out = { candidates: [], dropped: 0 };
  const seen = new Set();
  for (const c of (Array.isArray(raw?.candidates) ? raw.candidates : []).slice(0, 12)) {
    const id = Number(c?.profileId);
    if (!profileIds.has(id) || seen.has(id)) { out.dropped += 1; continue; }
    seen.add(id);
    out.candidates.push({
      profileId: id,
      fitComment: String(c?.fitComment || '').slice(0, 300),
      mismatches: (Array.isArray(c?.mismatches) ? c.mismatches : []).slice(0, 5).map((m) => String(m).slice(0, 200)),
    });
  }
  return out;
}

// S7: report prose slots. Forbidden phrases or numeric claims outside the
// computed outcome mark the WHOLE output invalid (template fallback) — the
// row is still stored for the oversight dashboard to count.
export function validateJeReport(raw, { providedChunkIds, allowedBandTokens, allowedNumbers }) {
  const out = {
    openingPlainEnglish: String(raw?.openingPlainEnglish || '').slice(0, 700),
    whatTheJdShows: String(raw?.whatTheJdShows || '').slice(0, 700),
    whyThisBandRange: String(raw?.whyThisBandRange || '').slice(0, 700),
    actionables: (Array.isArray(raw?.actionables) ? raw.actionables : []).slice(0, 5).map((a) => ({
      title: String(a?.title || '').slice(0, 80),
      why: String(a?.why || '').slice(0, 200),
      evidenceNeeded: String(a?.evidenceNeeded || '').slice(0, 200),
      who: String(a?.who || '').slice(0, 60),
    })),
    questionsForEmployer: (Array.isArray(raw?.questionsForEmployer) ? raw.questionsForEmployer : []).slice(0, 5).map((q) => String(q).slice(0, 200)),
    uncertainty: String(raw?.uncertainty || '').slice(0, 400),
    citations: (Array.isArray(raw?.citations) ? raw.citations : [])
      .filter((c) => providedChunkIds.has(Number(c?.chunkId)))
      .slice(0, 10)
      .map((c) => ({ chunkId: Number(c.chunkId), claim: String(c?.claim || '').slice(0, 400) })),
  };
  const prose = [
    out.openingPlainEnglish, out.whatTheJdShows, out.whyThisBandRange, out.uncertainty,
    ...out.actionables.flatMap((a) => [a.title, a.why, a.evidenceNeeded]),
    ...out.questionsForEmployer,
  ].join('\n');
  const violations = [
    ...scanForbidden(prose),
    ...scanNumericClaims(prose, { allowedBandTokens, allowedNumbers }),
  ];
  return { valid: violations.length === 0, output: out, violations };
}
