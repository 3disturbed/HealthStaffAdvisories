// Deterministic evidence neutralisation, run BEFORE any text reaches the
// model for factor-level proposals (anti-anchoring and bias containment).
// Removes/replaces identity, hours/contract-type, employer, pay and band
// self-claims; FLAGS (never deletes) disability/adjustment content and
// hedging so Kelly sees them and the model is told they carry no scoring
// weight. Reproducible and unit-testable by design — never model-driven.

const PRONOUNS = [
  [/\bhe\b/gi, 'they'], [/\bshe\b/gi, 'they'],
  [/\bhimself\b/gi, 'themself'], [/\bherself\b/gi, 'themself'],
  [/\bhim\b/gi, 'them'], [/\bhis\b/gi, 'their'], [/\bhers\b/gi, 'theirs'], [/\bher\b/gi, 'their'],
];

const HOURS_PATTERNS = [
  /\b\d{1,2}(?:\.\d+)?\s*hours?\s*(?:a|per)\s*week\b/gi,
  /\b(?:part|full)[- ]time\b/gi,
  /\bjob[- ]share\b/gi,
  /\bterm[- ]time(?:\s+only)?\b/gi,
  /\bbank\s+(?:shifts?|staff|worker)\b/gi,
  /\bzero[- ]hours?\b/gi,
  /\b0\.\d\s*(?:wte|fte)\b/gi,
  /\b(?:wte|fte)\s*0\.\d+\b/gi,
];

const PAY_PATTERN = /£\s?\d[\d,]*(?:\.\d+)?/g;
const SELF_BAND_CLAIM = /\b(?:i(?:'m| am)?(?: currently)?(?: paid)?(?: at| on| a)? band|my band(?: is)?|paid at band|doing band)\s*\d\w?(?:\s*(?:work|duties|money|pay))?\b/gi;

const ADJUSTMENT_PATTERN = /\b(disab\w*|reasonable adjustment\w*|adjustments?\b|health condition|long[- ]term condition|wheelchair|neurodiver\w*|dyslex\w*|autis\w*|adhd|chronic (?:pain|fatigue|illness)|occupational health|phased return)\b/i;
const HEDGING_PATTERN = /\b(i just\b|i only\b|only help\w*\b|a bit of\b|i suppose\b|nothing special\b|just the usual\b)/i;

// name/employer: exact-phrase removal for values we know structurally.
function scrubKnown(text, value, replacement) {
  const v = String(value || '').trim();
  if (v.length < 3) return text;
  const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'gi'), replacement);
}

// Returns { text, flags: { adjustment, hedging }, redactions }.
export function neutraliseEvidence(text, { memberName = '', employer = '' } = {}) {
  let out = String(text || '');
  let redactions = 0;
  const count = (before, after) => { if (before !== after) redactions += 1; return after; };

  out = count(out, scrubKnown(out, memberName, 'the postholder'));
  out = count(out, scrubKnown(out, employer, 'the employer'));
  for (const [re, rep] of PRONOUNS) out = count(out, out.replace(re, rep));
  for (const re of HOURS_PATTERNS) out = count(out, out.replace(re, '[working pattern removed]'));
  out = count(out, out.replace(PAY_PATTERN, '[pay figure removed]'));
  out = count(out, out.replace(SELF_BAND_CLAIM, '[band claim removed]'));

  const flags = {
    adjustment: ADJUSTMENT_PATTERN.test(String(text || '')),
    hedging: HEDGING_PATTERN.test(String(text || '')),
  };
  return { text: out, flags, redactions };
}
