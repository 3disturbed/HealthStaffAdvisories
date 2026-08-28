// Deterministic urgency rules (MVP.md §7, BACKLOG G1).
// These run on member-entered text and structured fields. They are keyword
// heuristics — deliberately over-inclusive, because a false "urgent" costs
// Kelly a glance while a false "normal" can cost a member a tribunal window.
// The LLM may also propose urgency, but can never lower what these rules set.

const RULES = [
  { id: 'immediate_danger', severity: 'critical', reason: 'Member may be in immediate danger', re: /\b(immediate danger|not safe|kill myself|suicid\w*|end my life|self.?harm)\b/i },
  { id: 'dismissal_happened', severity: 'critical', reason: 'Dismissal appears to have already happened', re: /\b(?:(?:was|were|been|got|being)\s+(?:dismissed|sacked|fired)|(?:dismissed|sacked|fired)\s+(?:me|from)|terminated my (?:contract|employment)|lost my job)\b/i },
  { id: 'tribunal_deadline', severity: 'critical', reason: 'Possible employment tribunal time limit', re: /\b(tribunal|acas early conciliation|et1|time limit)\b/i },
  { id: 'hearing_imminent', severity: 'high', reason: 'Hearing or formal meeting appears imminent', re: /\b(hearing|disciplinary meeting|grievance meeting|investigation meeting)\b.{0,40}\b(tomorrow|today|this week|monday|tuesday|wednesday|thursday|friday|next week)\b|\b(tomorrow|today|this week)\b.{0,40}\b(hearing|disciplinary|grievance)\b/i },
  { id: 'suspension', severity: 'high', reason: 'Member appears to be suspended', re: /\bsuspend(ed|sion)\b/i },
  { id: 'discrimination', severity: 'high', reason: 'Possible discrimination or reasonable-adjustment issue', re: /\b(discriminat|reasonable adjustment|disability|pregnan|maternity|race|racism|sexis|homophob|transphob|victimis)\w*\b/i },
  { id: 'speaking_up', severity: 'high', reason: 'Whistleblowing / patient safety concern', re: /\b(whistleblow|speak(ing)? up|patient safety|unsafe staffing|datix|freedom to speak up)\b/i },
  { id: 'regulator', severity: 'high', reason: 'Professional regulator involvement', re: /\b(nmc|gmc|hcpc|gdc|gphc|referred to the regulator|fitness to practi[sc]e)\b/i },
  { id: 'safeguarding', severity: 'critical', reason: 'Safeguarding allegation', re: /\bsafeguarding\b/i },
  { id: 'criminal', severity: 'critical', reason: 'Criminal allegation mentioned', re: /\b(police|arrested|criminal|assault charge|theft allegation)\b/i },
  { id: 'violence_threats', severity: 'high', reason: 'Violence, threats or serious harassment', re: /\b(threatened|threats|violence|violent|assaulted|stalking|serious harassment)\b/i },
  { id: 'right_to_work', severity: 'high', reason: 'Right-to-work / immigration employment issue', re: /\b(visa|right to work|immigration|sponsorship|cos revoked)\b/i },
];

// Returns { urgency, triggers: [{id, reason, severity}] }
export function assessUrgency(text, fields = {}) {
  const haystack = [text, fields.formalStage, fields.meetingOrDeadline, fields.desiredOutcome]
    .filter(Boolean)
    .join('\n');
  const triggers = RULES.filter((r) => r.re.test(haystack)).map(({ id, reason, severity }) => ({ id, reason, severity }));

  // A stated meeting/hearing/deadline in the structured field is high priority
  // even when no keyword matched.
  if (fields.meetingOrDeadline && String(fields.meetingOrDeadline).trim() && !triggers.some((t) => t.id === 'hearing_imminent')) {
    triggers.push({ id: 'stated_deadline', reason: 'Member reports a meeting, hearing or deadline', severity: 'high' });
  }

  const urgency = triggers.some((t) => t.severity === 'critical')
    ? 'critical'
    : triggers.length > 0
      ? 'high'
      : 'normal';
  return { urgency, triggers };
}

const URGENCY_RANK = { self_service: 0, normal: 1, high: 2, critical: 3 };

// Urgency can be raised automatically but only lowered by an advisor.
export function maxUrgency(a, b) {
  return URGENCY_RANK[a] >= URGENCY_RANK[b] ? a : b;
}
