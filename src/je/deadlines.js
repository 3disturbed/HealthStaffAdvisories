// Deterministic date arithmetic for job-evaluation time limits. This module
// contains NO duration literals — every amount comes from a ruleset's
// limitation_rules_json (data, admin-replaceable). Every result is
// indicative and must be verified by a human; wording built from these
// values must never assert that a limit "has passed".

const DAY_MS = 24 * 60 * 60 * 1000;

function parseIso(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  const d = new Date(`${dateStr}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIso(d) {
  return d.toISOString().slice(0, 10);
}

export function addMonthsClamped(dateStr, months) {
  const d = parseIso(dateStr);
  if (!d || !Number.isInteger(months)) return null;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return toIso(target);
}

export function addDays(dateStr, days) {
  const d = parseIso(dateStr);
  if (!d || !Number.isInteger(days)) return null;
  return toIso(new Date(d.getTime() + days * DAY_MS));
}

export function daysBetween(fromStr, toStr) {
  const a = parseIso(fromStr);
  const b = parseIso(toStr);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

// Compute an indicative limit date from a base event date and a limitation
// rule ({ unit, amount, minusOneDay }). Throws on a malformed rule — a
// missing parameter must fail loudly, never default silently.
export function computeLimit(baseDateStr, rule) {
  if (!rule || typeof rule !== 'object') throw new Error('limitation rule required');
  if (rule.amount === null || rule.amount === undefined) return null; // local-procedure rule: no computable date
  if (!Number.isInteger(rule.amount) || rule.amount <= 0) throw new Error(`limitation rule ${rule.code || ''}: invalid amount`);
  if (!['days', 'months'].includes(rule.unit)) throw new Error(`limitation rule ${rule.code || ''}: invalid unit`);
  let limit = rule.unit === 'months' ? addMonthsClamped(baseDateStr, rule.amount) : addDays(baseDateStr, rule.amount);
  if (!limit) return null;
  if (rule.minusOneDay) limit = addDays(limit, -1);
  return limit;
}

// Evaluate every limitation rule against known base-event dates.
// baseDates: { [baseEvent]: 'YYYY-MM-DD' }. todayStr injectable for tests.
// Returns [{ code, label, note, baseEvent, baseDate, limitDate, daysRemaining,
//            status: 'watch'|'closing'|'may_have_passed'|'no_date'|'not_computable', indicative: true }]
export function evaluateLimits(limitationRules, baseDates, todayStr) {
  const out = [];
  for (const rule of limitationRules || []) {
    const baseDate = baseDates?.[rule.baseEvent] || null;
    if (!baseDate) {
      out.push({ code: rule.code, label: rule.label, note: rule.note, baseEvent: rule.baseEvent, baseDate: null, limitDate: null, daysRemaining: null, status: 'no_date', indicative: true });
      continue;
    }
    const limitDate = computeLimit(baseDate, rule);
    if (!limitDate) {
      out.push({ code: rule.code, label: rule.label, note: rule.note, baseEvent: rule.baseEvent, baseDate, limitDate: null, daysRemaining: null, status: 'not_computable', indicative: true });
      continue;
    }
    const daysRemaining = daysBetween(todayStr, limitDate);
    const warn = Number.isInteger(rule.warnDays) ? rule.warnDays : 0;
    const status = daysRemaining === null ? 'not_computable' : daysRemaining < 0 ? 'may_have_passed' : daysRemaining <= warn ? 'closing' : 'watch';
    out.push({ code: rule.code, label: rule.label, note: rule.note, baseEvent: rule.baseEvent, baseDate, limitDate, daysRemaining, status, indicative: true });
  }
  return out;
}
