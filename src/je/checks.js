// Deterministic quality, fairness and safety checks over a review's
// assembled state. Same design as src/safety/urgency.js: an array of rule
// objects, each pure. Severity 'notice' informs; 'high'/'critical' also
// create je_flags rows (done by the service, not here).
//
// ctx: { review, bundle, outcome, factors, evidence, documents, comparators,
//        decisions, limits, priorConfirmedStats }

const bandSeq = (bundle, label) => bundle.bands.findIndex((b) => String(b.label) === String(label));

export const JE_CHECKS = [
  {
    id: 'no_approved_ruleset',
    severity: 'critical',
    applies: (ctx) => !ctx.bundle,
    message: () => 'No approved reference ruleset is loaded — indicative scoring is unavailable until an administrator loads and approves one.',
    actionable: () => 'Ask an administrator to load the job evaluation reference data.',
  },
  {
    id: 'seed_unverified',
    severity: 'notice',
    applies: (ctx) => !!ctx.bundle && ctx.bundle.ruleset.origin === 'seed' && !ctx.bundle.ruleset.verified_at,
    message: () => 'The reference data in use is the bundled seed and has not yet been verified against the published NHS Job Evaluation Handbook.',
    actionable: () => 'An administrator should verify the seeded reference data against the current handbook.',
  },
  {
    id: 'superseded_ruleset',
    severity: 'notice',
    applies: (ctx) => !!ctx.bundle && ctx.bundle.ruleset.status === 'superseded',
    message: () => 'This review is pinned to a reference ruleset that has since been superseded. Existing outcomes are unchanged; a recompute on the new ruleset is available.',
    actionable: () => 'Consider recomputing on the current ruleset and comparing.',
  },
  {
    id: 'no_jd',
    severity: 'high',
    applies: (ctx) => !(ctx.documents || []).some((d) => d.doc_role === 'jd' && d.status === 'extracted'),
    message: () => 'No readable job description is attached. An assessment without the JD rests only on the member’s own account.',
    actionable: () => 'Ask the member (or the employer) for the current job description — or record that none exists, which is itself relevant evidence.',
  },
  {
    id: 'jd_stale',
    severity: 'high',
    applies: (ctx) => {
      const jd = (ctx.documents || []).find((d) => d.doc_role === 'jd' && d.document_dated);
      return !!jd && !!ctx.review?.duties_changed_since && jd.document_dated < ctx.review.duties_changed_since;
    },
    message: (ctx) => {
      const jd = (ctx.documents || []).find((d) => d.doc_role === 'jd' && d.document_dated);
      return `The job description is dated ${jd.document_dated}, before the duties reportedly changed (${ctx.review.duties_changed_since}). It may not describe the job as now performed.`;
    },
    actionable: () => 'Build the duties-as-performed table from the member’s duty log and flag the JD as out of date in the submission.',
  },
  {
    id: 'factor_missing',
    severity: 'high',
    applies: (ctx) => (ctx.outcome?.missing || []).length > 0,
    message: (ctx) => `${ctx.outcome.missing.length} of ${ctx.bundle?.factors.length ?? 16} factors have no assessed level, so only a band range can be given.`,
    actionable: () => 'Resolve the unassessed factors, or ask the member the outstanding questions.',
  },
  {
    id: 'factor_unevidenced',
    severity: 'high',
    applies: (ctx) => (ctx.factors || []).some((f) => f.ai_level && !(ctx.evidence || []).some((e) => e.factor_code === f.factor_code && e.strength !== 'rejected')),
    message: (ctx) => {
      const codes = (ctx.factors || []).filter((f) => f.ai_level && !(ctx.evidence || []).some((e) => e.factor_code === f.factor_code && e.strength !== 'rejected')).map((f) => f.factor_code);
      return `Proposed levels without any supporting evidence item: ${codes.join(', ')}. Unevidenced proposals cannot be confirmed.`;
    },
    actionable: () => 'Gather evidence for these factors or mark them as not having enough information.',
  },
  {
    id: 'boundary_sensitive',
    severity: 'high',
    applies: (ctx) => {
      if (!ctx.bundle || !ctx.outcome?.complete) return false;
      const margin = ctx.bundle.matchRules.boundaryMarginPoints ?? 0;
      if (!margin) return false;
      const b = ctx.bundle.bands.find((x) => ctx.outcome.totalPoints >= x.min && ctx.outcome.totalPoints <= x.max);
      if (!b) return false;
      return ctx.outcome.totalPoints - b.min < margin || b.max - ctx.outcome.totalPoints < margin;
    },
    message: (ctx) => `The total (${ctx.outcome.totalPoints} points) sits close to a band boundary — small changes in one factor could change the indicative band.`,
    actionable: () => 'Treat the indicative band with extra caution and double-check the factors nearest their level boundaries.',
  },
  {
    id: 'low_confidence_dominant',
    severity: 'high',
    applies: (ctx) => (ctx.factors || []).filter((f) => ['low', 'insufficient'].includes(f.ai_confidence) && !f.confirmed_level).length >= 3,
    message: () => 'Three or more factors are low-confidence or unevidenced — a single-band conclusion is suppressed; only a range is supportable.',
    actionable: () => 'Prioritise the highest-impact evidence gaps before drawing conclusions.',
  },
  {
    id: 'claim_gap',
    severity: 'notice',
    applies: (ctx) => {
      if (!ctx.bundle || !ctx.review?.claimed_band || !ctx.outcome?.bandHigh) return false;
      const claim = bandSeq(ctx.bundle, ctx.review.claimed_band);
      const high = bandSeq(ctx.bundle, ctx.outcome.bandHigh);
      return claim !== -1 && high !== -1 && claim - high >= 2;
    },
    message: (ctx) => `The member’s hoped-for band (${ctx.review.claimed_band}) is two or more bands above what the current evidence supports (up to ${ctx.outcome.bandHigh}). Expectations need managing either way.`,
    actionable: () => 'Have the expectation conversation early — and check whether evidence for the higher claim simply has not been captured yet.',
  },
  {
    id: 'downbanding_exposure',
    severity: 'high',
    applies: (ctx) => {
      if (!ctx.bundle || !ctx.review?.current_band) return false;
      const cur = bandSeq(ctx.bundle, ctx.review.current_band);
      const high = bandSeq(ctx.bundle, ctx.outcome?.bandHigh || '');
      return cur !== -1 && high !== -1 && high < cur;
    },
    message: (ctx) => `The evidence currently supports a band below the member’s existing band (${ctx.review.current_band}). A review could, in principle, confirm or lower the banding — the member must understand this before anything is submitted.`,
    actionable: () => 'Hold the risk conversation before any submission; record the member’s decision.',
  },
  {
    id: 'no_actual_comparator',
    severity: 'high',
    applies: (ctx) => ctx.review?.kind === 'equal_pay' && !(ctx.comparators || []).some((c) => c.is_actual_person && c.status === 'verified'),
    message: () => 'An equal pay claim needs an actual (not hypothetical) comparator. No verified actual comparator is recorded.',
    actionable: () => 'Identify and verify an actual comparator, or reframe the request as a band review rather than an equal pay claim.',
  },
  {
    id: 'equal_pay_specialist',
    severity: 'high',
    applies: (ctx) => ctx.review?.kind === 'equal_pay' || (ctx.comparators || []).some((c) => c.basis !== 'like_work'),
    message: () => 'Equal pay / equal value matters carry strict time limits and litigation risk beyond this service’s scope.',
    actionable: () => 'Route the member to specialist advice (union, JE-trained representative or solicitor) alongside this preparation.',
  },
  {
    id: 'time_limit_watch',
    severity: 'high',
    applies: (ctx) => (ctx.limits || []).some((l) => l.status === 'closing' || l.status === 'may_have_passed'),
    message: (ctx) => {
      const worst = (ctx.limits || []).find((l) => l.status === 'may_have_passed') || (ctx.limits || []).find((l) => l.status === 'closing');
      return worst.status === 'may_have_passed'
        ? `${worst.label}: the indicative time limit (${worst.limitDate}) may already have passed — this needs specialist advice today. Dates are indicative and must be verified.`
        : `${worst.label}: the indicative time limit (${worst.limitDate}) is close (${worst.daysRemaining} days). Dates are indicative and must be verified.`;
    },
    actionable: () => 'Verify the dates with the member now and act on the nearest limit first.',
  },
  {
    id: 'appeal_window',
    severity: 'high',
    applies: (ctx) => (ctx.decisions || []).some((d) => d.kind === 'outcome_issued') && !(ctx.decisions || []).some((d) => ['appeal_lodged', 'appeal_heard', 'appeal_outcome'].includes(d.kind)),
    message: () => 'A matching/evaluation outcome has been recorded and no appeal is logged. Local review and appeal windows are usually short.',
    actionable: () => 'Check the employer’s JE procedure for the appeal window immediately and diarise it.',
  },
  {
    id: 'cross_review_variance',
    severity: 'notice',
    applies: (ctx) => (ctx.priorConfirmedStats?.varianceFactors || []).length >= 3,
    message: (ctx) => `Confirmed levels differ by a level or more from other reviews with the same employer and job title on ${ctx.priorConfirmedStats.varianceFactors.length} factors (${ctx.priorConfirmedStats.varianceFactors.join(', ')}). Consistency needs a look — in either direction.`,
    actionable: () => 'Compare against the earlier assessments and record why this job genuinely differs, or align the levels.',
  },
];

export function runJeChecks(ctx) {
  const results = [];
  for (const check of JE_CHECKS) {
    let applies = false;
    try { applies = !!check.applies(ctx); } catch { applies = false; }
    if (!applies) continue;
    results.push({
      id: check.id,
      severity: check.severity,
      message: check.message(ctx),
      actionable: check.actionable(ctx),
    });
  }
  return results;
}
