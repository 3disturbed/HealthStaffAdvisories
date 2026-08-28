// Deterministic banding / fair-pay signal rules — a sibling of urgency.js.
// `triggers` behave exactly like the existing engine (critical => critical,
// otherwise high, composable via maxUrgency). `flags` are a new 'notice'
// severity: they never raise urgency and never create escalations — they
// surface the banding section to members and a chip to advisors.

const JE_RULES = [
  { id: 'downbanding_risk', severity: 'critical', reason: 'Possible downbanding or pay protection issue',
    re: /\b(down.?band(ed|ing)?|re.?grad(ed|ing) down|reduced my band|band was lowered|band being lowered|pay protection)\b/i },
  { id: 'equal_pay', severity: 'high', reason: 'Possible equal pay / equal value issue — strict time limits apply',
    re: /\b(equal pay|equal value|work rated as equivalent|like work|sex equality clause|paid less than (a|my|the) (male|female|man|woman))\b/i },
  { id: 'banding_outcome_issued', severity: 'high', reason: 'A job matching or evaluation outcome appears to have been issued — review and appeal windows are short',
    re: /\b((job )?(matching|evaluation) (panel|outcome|decision)|je panel|band(ing)? (review )?(outcome|decision)|not upheld|remains? (at )?band)\b/i },
  { id: 'wages_deduction', severity: 'high', reason: 'Possible unpaid wages / unlawful deduction — time limits and a backstop may apply',
    re: /\b(underpaid|unpaid (wages|hours|pay)|deduction from (my )?(wages|pay)|paid at the wrong band|wrong band since)\b/i },
  // notice: surface the banding section; do NOT change urgency.
  { id: 'je_interest', severity: 'notice', reason: 'Member is asking about banding or job evaluation',
    re: /\b(re.?band(ing|ed)?|up.?band(ing|ed)?|re.?grad(e|ing)|job evaluation|job matching|band(ing)? review|agenda for change|afc band)\b/i },
  { id: 'jd_outdated', severity: 'notice', reason: 'Job description may not reflect the work actually done',
    re: /\b(job description (is )?(out of date|not been updated|hasn.?t been updated)|doing band ?\d\w? work|acting up|extra duties (with )?no (extra )?pay)\b/i },
];

// Returns { urgency, triggers, flags }. Compose with the base assessment:
//   urgency = maxUrgency(base.urgency, jeSignals.urgency)
export function assessJeSignals(text, fields = {}) {
  const haystack = [text, fields.formalStage, fields.meetingOrDeadline, fields.desiredOutcome]
    .filter(Boolean)
    .join('\n');
  const hits = JE_RULES.filter((r) => r.re.test(haystack)).map(({ id, reason, severity }) => ({ id, reason, severity }));
  const triggers = hits.filter((h) => h.severity !== 'notice');
  const flags = hits.filter((h) => h.severity === 'notice');
  const urgency = triggers.some((t) => t.severity === 'critical') ? 'critical' : triggers.length > 0 ? 'high' : 'normal';
  return { urgency, triggers, flags };
}
