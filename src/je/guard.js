// The share gate and language guards. One module, one place to test.
// Nothing from an assessment may reach a member unless every gate passes,
// and no member-facing text may assert a band, an entitlement, an outcome
// or an expired deadline.

export const CHECKLIST_VERSION = 'je-checklist-v1';

// Kelly's fairness checklist — every item must be true before sign-off.
export const CHECKLIST_ITEMS = [
  { code: 'all_factors_resolved', label: 'Every factor is confirmed, amended, marked “not enough information”, or not applicable.' },
  { code: 'no_irrelevant_influence', label: 'No level was influenced by the member’s hours, contract type, gender, or how well they write.' },
  { code: 'adjustments_job_not_person', label: 'Disability/adjustment content was assessed as a job requirement, not personal capability.' },
  { code: 'caring_weighed_equally', label: 'Caring, emotional and coordination work was weighed on the same footing as budget and technical responsibility.' },
  { code: 'outliers_reviewed', label: 'Every consistency/outlier flag was reviewed, with a reason recorded where the level was kept.' },
  { code: 'levels_cite_reference', label: 'Every confirmed level corresponds to a descriptor in the pinned reference ruleset.' },
  { code: 'no_anchoring', label: 'The member’s own hoped-for band did not anchor the assessment.' },
  { code: 'panel_decides_stated', label: 'The report states that only the employer’s panel determines a band.' },
  { code: 'risk_conversation_done', label: 'The risk conversation happened: a review can confirm the current band or, in principle, result in a lower outcome.' },
  { code: 'specialist_flags_raised', label: 'Any equal-pay, discrimination or time-limit issue has been flagged for specialist advice.' },
];

export const AMEND_REASON_CODES = [
  'evidence_misread', 'wrong_descriptor', 'over_scored', 'under_scored',
  'job_vs_person', 'profile_mismatch', 'outdated_reference', 'other',
];

// Member-facing text may never contain these. Model output that trips one
// is stored as invalid and replaced by the deterministic template.
export const FORBIDDEN_PHRASES = [
  /\byou(?:r job| role| post)? (?:is|are|would be|should be|will be)\s+(?:a\s+)?band\b/i,
  /\b(?:entitled|eligible)\s+to\s+band\b/i,
  /\byou\s+(?:will|should)\s+be\s+(?:re)?banded\b/i,
  /\bthis (?:job|post|role) is band\b/i,
  /\bguarantee[ds]?\b/i,
  /\b(?:certainly|definitely)\s+(?:be|get|win|succeed)\b/i,
  /\byour (?:claim|case|request) will (?:succeed|be upheld)\b/i,
  /\bthe panel will\b/i,
  /\bdeadline (?:has|is) (?:passed|expired)\b/i,
  /\btime limit has (?:passed|expired)\b/i,
  /\bback ?pay of\s*£/i,
];

export function scanForbidden(text) {
  const hits = [];
  for (const re of FORBIDDEN_PHRASES) {
    if (re.test(String(text || ''))) hits.push(re.source);
  }
  return hits;
}

// Numeric-claim guard for model prose: any band token or large number not in
// the allowed sets marks the output invalid. The headline numbers are always
// rendered server-side from je_outcomes — prose can never contradict them.
export function scanNumericClaims(text, { allowedBandTokens = new Set(), allowedNumbers = new Set() } = {}) {
  const hits = [];
  const t = String(text || '');
  for (const m of t.matchAll(/\bband\s*([0-9]{1,2}[a-d]?)\b/gi)) {
    if (!allowedBandTokens.has(m[1].toLowerCase())) hits.push(`band ${m[1]}`);
  }
  for (const m of t.matchAll(/\b(\d{3,4})\b/g)) {
    const n = Number(m[1]);
    if (n >= 100 && n <= 2000 && !allowedNumbers.has(n) && !/^(19|20)\d\d$/.test(m[1])) hits.push(String(n));
  }
  return hits;
}

// Share-gate: reasons an assessment may not reach the member yet.
// state: { review, factors, flags, signoff, report }
export function shareBlockers(state) {
  const blockers = [];
  const factors = state.factors || [];
  const unresolved = factors.filter((f) => !f.confirmed_decision);
  if (factors.length === 0) blockers.push('No factor assessment exists yet.');
  if (unresolved.length > 0) blockers.push(`${unresolved.length} factor(s) not yet reviewed by an advisor.`);
  const unacked = (state.flags || []).filter((f) => ['critical', 'high'].includes(f.severity) && !f.acknowledged_at && !f.resolved_at);
  if (unacked.length > 0) blockers.push(`${unacked.length} check flag(s) not yet acknowledged.`);
  if (!state.signoff) blockers.push('No sign-off has been recorded.');
  else {
    if (state.signoff.checklist_version !== CHECKLIST_VERSION) blockers.push('Sign-off used an out-of-date checklist.');
    if (state.signoff.second_opinion_required && !state.secondOpinion && !state.signoff.second_opinion_waived_reason) {
      blockers.push('A second opinion is required and has been neither recorded nor explicitly waived.');
    }
  }
  if (!state.report || !['approved', 'issued'].includes(state.report.status)) blockers.push('No approved report exists.');
  return blockers;
}

export function assertShareable(state) {
  const blockers = shareBlockers(state);
  if (blockers.length > 0) {
    const err = new Error(`Not shareable: ${blockers.join(' ')}`);
    err.blockers = blockers;
    throw err;
  }
}

// Second-opinion policy — deterministic.
// ctx: { bundle, outcome, review, flags, disagreementCount, linkedMembers }
export function secondOpinionRequired(ctx) {
  const reasons = [];
  const seq = (label) => (ctx.bundle?.bands || []).findIndex((b) => String(b.label) === String(label));
  if (ctx.outcome?.bandLow && ctx.outcome?.bandHigh) {
    const span = seq(ctx.outcome.bandHigh) - seq(ctx.outcome.bandLow);
    if (span >= 2) reasons.push('range_spans_two_bands');
  }
  if ((ctx.flags || []).some((f) => f.rule_id === 'downbanding_exposure' && !f.resolved_at)) reasons.push('downbanding_risk');
  if (ctx.review?.kind === 'equal_pay') reasons.push('equal_pay');
  if ((ctx.flags || []).some((f) => f.rule_id === 'equal_pay_specialist' && !f.resolved_at)) reasons.push('equal_pay');
  if (['appeal_lodged', 'appeal_outcome'].includes(ctx.review?.stage) || ctx.review?.kind === 'appeal') reasons.push('formal_appeal');
  if ((ctx.disagreementCount || 0) >= 6) reasons.push('high_disagreement');
  if ((ctx.linkedMembers || 0) >= 3) reasons.push('collective_matter');
  return { required: reasons.length > 0, reasons: [...new Set(reasons)] };
}
