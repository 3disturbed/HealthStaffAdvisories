// Band review section: presentation-only metadata and formatters.
// HARD RULE: no scoring data lives here — factor names, level points, band
// boundaries and question wording all come from the server (the versioned
// ruleset and question set). This module only knows how to LABEL things.

export const STAGE_LABELS = {
  draft: 'Getting started',
  member_submitted: 'Sent to Kelly',
  analysing: 'Being prepared',
  advisor_review: 'Kelly is working through it',
  report_ready: 'Report ready',
  submitted_to_employer: 'With your employer',
  employer_review: 'With your employer',
  outcome_received: 'Outcome received',
  appeal_lodged: 'Appeal in progress',
  appeal_outcome: 'Appeal outcome received',
  closed: 'Closed',
};

// Member journey mapping (mirrors the case journey stepper idiom).
export const JOURNEY_LABELS = ['Your job', 'With Kelly', 'Being assessed', 'Your report', 'With your employer'];

export function journeyPosition(stage) {
  if (['draft'].includes(stage)) return 1;
  if (['member_submitted'].includes(stage)) return 2;
  if (['analysing', 'advisor_review'].includes(stage)) return 3;
  if (['report_ready'].includes(stage)) return 4;
  if (['submitted_to_employer', 'employer_review'].includes(stage)) return 5;
  return 6; // outcome/appeal/closed — journey complete
}

export const KIND_LABELS = {
  band_review: 'Band review — my job has grown',
  job_match: 'Banded wrong from the start',
  new_post: 'New post banding',
  appeal: 'Challenging an outcome',
  equal_pay: 'Paid less for the same work',
};

export const DECISION_LABELS = {
  request_submitted: 'Request submitted to employer',
  panel_matched: 'Considered by a matching panel',
  panel_evaluated: 'Evaluated by a panel',
  outcome_issued: 'Outcome issued',
  appeal_lodged: 'Appeal lodged',
  appeal_heard: 'Appeal heard',
  appeal_outcome: 'Appeal outcome issued',
  back_pay_agreed: 'Back pay agreed',
  withdrawn: 'Withdrawn',
};

export const FACTOR_STATE = {
  unreviewed: { label: 'Not reviewed by Kelly', cls: 'unreviewed', icon: 'file' },
  confirmed: { label: 'Confirmed', cls: 'confirmed', icon: 'clipboardCheck' },
  changed: { label: 'Changed by Kelly', cls: 'changed', icon: 'clipboardCheck' },
  insufficient: { label: 'Not enough information', cls: 'insufficient', icon: 'quote' },
  not_applicable: { label: 'Not applicable', cls: 'confirmed', icon: 'clipboardCheck' },
};

export function factorState(f) {
  if (!f.confirmed_decision) return FACTOR_STATE.unreviewed;
  if (f.confirmed_decision === 'agree') return FACTOR_STATE.confirmed;
  if (f.confirmed_decision === 'amend') return FACTOR_STATE.changed;
  if (f.confirmed_decision === 'not_applicable') return FACTOR_STATE.not_applicable;
  return FACTOR_STATE.insufficient;
}

export const AMEND_REASON_LABELS = {
  evidence_misread: 'The evidence was misread',
  wrong_descriptor: 'Wrong descriptor applied',
  over_scored: 'Proposed too high',
  under_scored: 'Proposed too low',
  job_vs_person: 'Assessed the person, not the job',
  profile_mismatch: 'Profile mismatch',
  outdated_reference: 'Out-of-date reference data',
  other: 'Other (see note)',
};

export const DOC_ROLE_LABELS = {
  jd: 'Job description',
  person_spec: 'Person specification',
  org_chart: 'Organisation chart',
  appraisal: 'Appraisal / PDR',
  rota: 'Rota',
  payslip: 'Payslip',
  comparator_jd: 'Comparator job description',
  outcome_letter: 'Outcome letter',
  other: 'Other document',
};

export function bandDisplay(outcome) {
  if (!outcome) return 'Not determined';
  if (outcome.bandLabel) return `Band ${outcome.bandLabel}`;
  if (outcome.bandLow && outcome.bandHigh && outcome.bandLow !== outcome.bandHigh) {
    return `Band ${outcome.bandLow}–${outcome.bandHigh}`;
  }
  if (outcome.bandLow) return `Band ${outcome.bandLow}`;
  return 'Not determined';
}

// The standard boundary sentence — verbatim everywhere it appears.
export const STANDARD_SENTENCE =
  'This is an indicative assessment prepared to help you gather and organise evidence. It is not a job evaluation and it does not decide your band. Only your employer’s job matching or job evaluation panel — which includes staff-side representatives — can determine a band.';
