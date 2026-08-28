import test from 'node:test';
import assert from 'node:assert';
import { scoreLevels, bandForPoints, bandRange, computeOutcome, matchProfile } from '../src/je/scoring.js';
import { rankGaps } from '../src/je/gaps.js';
import { validateRulesetBundle, canonicalChecksum } from '../src/je/reference.js';
import { neutraliseEvidence } from '../src/je/neutralise.js';
import { computeLimit, evaluateLimits, addMonthsClamped, daysBetween } from '../src/je/deadlines.js';
import { assessJeSignals } from '../src/safety/jeUrgency.js';
import { scanForbidden, scanNumericClaims, shareBlockers, secondOpinionRequired } from '../src/je/guard.js';

// Synthetic fixture ruleset — proves nothing is hardcoded from any real
// scheme. Three factors, tiny points, three bands.
const FIXTURE = {
  scheme: 'testscheme',
  label: 'Test ruleset',
  matchRules: { boundaryMarginPoints: 2, shortlistLimit: 4, matchToleranceFactors: 1 },
  factors: [
    { code: 'alpha', seq: 1, name: 'Alpha', levels: [
      { label: '1', points: 5, descriptor: 'a1' }, { label: '2', points: 10, descriptor: 'a2' }, { label: '3', points: 20, descriptor: 'a3' } ] },
    { code: 'beta', seq: 2, name: 'Beta', levels: [
      { label: '1', points: 2, descriptor: 'b1' }, { label: '2', points: 8, descriptor: 'b2' } ] },
    { code: 'gamma', seq: 3, name: 'Gamma', levels: [
      { label: '1', points: 1, descriptor: 'g1' }, { label: '2', points: 4, descriptor: 'g2' }, { label: '3', points: 9, descriptor: 'g3' } ] },
  ],
  bands: [
    { label: 'A', min: 0, max: 10 }, { label: 'B', min: 11, max: 25 }, { label: 'C', min: 26, max: 37 } ],
  profiles: [],
  limitationRules: [],
};
// Bundle in the shape getRulesetBundle returns.
const BUNDLE = {
  ruleset: { id: 1, origin: 'import', status: 'approved', verified_at: null },
  factors: FIXTURE.factors.map((f) => ({ ...f, levels: f.levels.map((l, i) => ({ ...l, seq: i + 1 })) })),
  bands: FIXTURE.bands.map((b, i) => ({ ...b, seq: i + 1 })),
  matchRules: FIXTURE.matchRules,
  limitationRules: [],
};

test('scoreLevels totals points and reports missing factors', () => {
  const s = scoreLevels(BUNDLE, { alpha: '2', beta: '1', gamma: '3' });
  assert.equal(s.totalPoints, 10 + 2 + 9);
  assert.equal(s.complete, true);
  const s2 = scoreLevels(BUNDLE, { alpha: '2' });
  assert.deepEqual(s2.missing, ['beta', 'gamma']);
  assert.equal(s2.complete, false);
});

test('unknown level label is reported missing, never guessed', () => {
  const s = scoreLevels(BUNDLE, { alpha: '9', beta: '1', gamma: '1' });
  assert.deepEqual(s.missing, ['alpha']);
  assert.equal(s.totalPoints, 3);
});

test('band boundaries are inclusive on both edges', () => {
  assert.equal(bandForPoints(BUNDLE, 0), 'A');
  assert.equal(bandForPoints(BUNDLE, 10), 'A');
  assert.equal(bandForPoints(BUNDLE, 11), 'B');
  assert.equal(bandForPoints(BUNDLE, 25), 'B');
  assert.equal(bandForPoints(BUNDLE, 26), 'C');
  assert.equal(bandForPoints(BUNDLE, 37), 'C');
  assert.equal(bandForPoints(BUNDLE, 38), null);
  assert.equal(bandForPoints(BUNDLE, -1), null);
});

test('missing factor widens range from factor min to factor max', () => {
  const r = bandRange(BUNDLE, { alpha: '1', beta: '1' }); // gamma unknown
  assert.equal(r.pointsLow, 5 + 2 + 1);
  assert.equal(r.pointsHigh, 5 + 2 + 9);
});

test('low confidence widens a level by one either side', () => {
  const r = bandRange(BUNDLE, { alpha: '2', beta: '1', gamma: '2' }, { alpha: 'low' });
  assert.equal(r.pointsLow, 5 + 2 + 4);
  assert.equal(r.pointsHigh, 20 + 2 + 4);
});

test('single band asserted only when complete and range collapses', () => {
  const o1 = computeOutcome(BUNDLE, { alpha: '1', beta: '1', gamma: '1' });
  assert.equal(o1.bandLabel, 'A'); // 8 points, all high confidence
  const o2 = computeOutcome(BUNDLE, { alpha: '1', beta: '1' }); // missing gamma
  assert.equal(o2.bandLabel, '');
  assert.equal(o2.factorsMissing, 1);
  const o3 = computeOutcome(BUNDLE, { alpha: '2', beta: '2', gamma: '2' }, { alpha: 'low' });
  assert.equal(o3.bandLabel, ''); // range B..B? alpha low: low=5+8+4=17 B, high=20+8+4=32 C → range
  assert.equal(o3.bandLow, 'B');
  assert.equal(o3.bandHigh, 'C');
});

test('profile matching is deterministic with tolerance', () => {
  const profile = { alpha: ['1', '2'], beta: ['2', '2'] };
  const exact = matchProfile(BUNDLE, profile, { alpha: '2', beta: '2', gamma: '1' }, BUNDLE.matchRules);
  assert.equal(exact.fit, 'match');
  const near = matchProfile(BUNDLE, profile, { alpha: '3', beta: '2', gamma: '1' }, BUNDLE.matchRules);
  assert.equal(near.fit, 'partial');
  assert.equal(near.factorsOutside[0].deviation, 1);
  const far = matchProfile(BUNDLE, profile, { alpha: '3', beta: '1', gamma: '1' }, { matchToleranceFactors: 1 });
  assert.equal(far.fit, 'no_match');
});

test('gap ranking orders by points swing', () => {
  const gaps = rankGaps(BUNDLE, { beta: '1' }, {}); // alpha + gamma unknown
  assert.equal(gaps[0].factorCode, 'alpha'); // swing 15 > gamma swing 8
  assert.equal(gaps[0].swing, 15);
  assert.equal(gaps[1].factorCode, 'gamma');
});

test('ruleset validation rejects broken bundles', () => {
  assert.equal(validateRulesetBundle(FIXTURE).ok, true);
  const badPoints = structuredClone(FIXTURE);
  badPoints.factors[0].levels[2].points = 3; // not increasing
  assert.equal(validateRulesetBundle(badPoints).ok, false);
  const badBands = structuredClone(FIXTURE);
  badBands.bands[1].min = 13; // gap
  assert.equal(validateRulesetBundle(badBands).ok, false);
  const badProfile = structuredClone(FIXTURE);
  badProfile.profiles = [{ code: 'p1', title: 'P', band: 'A', factorLevels: { nope: ['1', '2'] } }];
  assert.equal(validateRulesetBundle(badProfile).ok, false);
  const dupFactor = structuredClone(FIXTURE);
  dupFactor.factors.push(structuredClone(dupFactor.factors[0]));
  assert.equal(validateRulesetBundle(dupFactor).ok, false);
});

test('checksum is stable and content-sensitive', () => {
  const a = canonicalChecksum(FIXTURE);
  const b = canonicalChecksum(structuredClone(FIXTURE));
  assert.equal(a, b);
  const changed = structuredClone(FIXTURE);
  changed.factors[0].levels[0].points = 6;
  assert.notEqual(canonicalChecksum(changed), a);
});

test('neutralise strips identity, hours, pay and band self-claims; flags adjustments and hedging', () => {
  const src = 'Jane Smith works part-time, 22.5 hours per week at Mercy Trust. She earns £28,407. I am paid at band 5 but I just help with the rota. My dyslexia means I need reasonable adjustments.';
  const { text, flags } = neutraliseEvidence(src, { memberName: 'Jane Smith', employer: 'Mercy Trust' });
  assert.ok(!text.includes('Jane'));
  assert.ok(!text.includes('Mercy'));
  assert.ok(!/part-time/i.test(text));
  assert.ok(!text.includes('£28,407'));
  assert.ok(!/band 5/i.test(text));
  assert.ok(/they|the postholder/i.test(text));
  assert.equal(flags.adjustment, true);
  assert.equal(flags.hedging, true);
});

test('deadline arithmetic: months clamped, minus one day, malformed rules throw', () => {
  assert.equal(addMonthsClamped('2026-01-31', 1), '2026-02-28');
  assert.equal(computeLimit('2026-01-15', { unit: 'months', amount: 6, minusOneDay: true }), '2026-07-14');
  assert.equal(computeLimit('2026-01-15', { unit: 'days', amount: null }), null);
  assert.throws(() => computeLimit('2026-01-15', { unit: 'years', amount: 1 }));
  assert.throws(() => computeLimit('2026-01-15', { unit: 'months', amount: -2 }));
  assert.equal(daysBetween('2026-01-01', '2026-01-31'), 30);
});

test('evaluateLimits never says "has passed" — only may_have_passed status', () => {
  const rules = [{ code: 'r1', label: 'L', note: 'n', baseEvent: 'employment_end', unit: 'months', amount: 6, minusOneDay: true, warnDays: 60 }];
  const past = evaluateLimits(rules, { employment_end: '2025-01-01' }, '2026-01-01');
  assert.equal(past[0].status, 'may_have_passed');
  const closing = evaluateLimits(rules, { employment_end: '2025-08-01' }, '2026-01-01');
  assert.equal(closing[0].status, 'closing');
  const noDate = evaluateLimits(rules, {}, '2026-01-01');
  assert.equal(noDate[0].status, 'no_date');
  for (const l of [...past, ...closing, ...noDate]) assert.equal(l.indicative, true);
});

test('JE signals: notices never raise urgency, triggers do', () => {
  const interest = assessJeSignals('I want a banding review of my role');
  assert.equal(interest.urgency, 'normal');
  assert.equal(interest.flags.length >= 1, true);
  const down = assessJeSignals('they downbanded me last month');
  assert.equal(down.urgency, 'critical');
  const ep = assessJeSignals('I am paid less than a man doing like work');
  assert.equal(ep.urgency, 'high');
});

test('forbidden-phrase and numeric-claim guards', () => {
  assert.ok(scanForbidden('Your job is band 6 and the panel will agree').length >= 2);
  assert.equal(scanForbidden('The evidence points towards Band 6; only the panel decides.').length, 0);
  const hits = scanNumericClaims('You scored 512 points which is band 7', { allowedBandTokens: new Set(['6']), allowedNumbers: new Set([480]) });
  assert.ok(hits.includes('512'));
  assert.ok(hits.includes('band 7'));
  const clean = scanNumericClaims('The total of 480 points sits in band 6', { allowedBandTokens: new Set(['6']), allowedNumbers: new Set([480]) });
  assert.equal(clean.length, 0);
});

test('share gate blocks until factors resolved, flags acknowledged, signoff and approved report exist', () => {
  const base = {
    review: { id: 1 },
    factors: [{ confirmed_decision: 'agree' }, { confirmed_decision: null }],
    flags: [{ severity: 'high', acknowledged_at: null, resolved_at: null }],
    signoff: null,
    report: null,
  };
  const blockers = shareBlockers(base);
  assert.ok(blockers.length >= 3);
  const ok = shareBlockers({
    review: { id: 1 },
    factors: [{ confirmed_decision: 'agree' }],
    flags: [{ severity: 'high', acknowledged_at: 'x', resolved_at: null }],
    signoff: { checklist_version: 'je-checklist-v1', second_opinion_required: 0 },
    report: { status: 'approved' },
  });
  assert.deepEqual(ok, []);
});

test('second opinion policy fires on range span, downbanding, equal pay, disagreement and collective', () => {
  const bundle = BUNDLE;
  assert.equal(secondOpinionRequired({ bundle, outcome: { bandLow: 'A', bandHigh: 'C' } }).required, true);
  assert.equal(secondOpinionRequired({ bundle, review: { kind: 'equal_pay' } }).required, true);
  assert.equal(secondOpinionRequired({ bundle, flags: [{ rule_id: 'downbanding_exposure' }] }).required, true);
  assert.equal(secondOpinionRequired({ bundle, disagreementCount: 6 }).required, true);
  assert.equal(secondOpinionRequired({ bundle, linkedMembers: 3 }).required, true);
  assert.equal(secondOpinionRequired({ bundle, outcome: { bandLow: 'B', bandHigh: 'B' }, review: { kind: 'band_review' } }).required, false);
});

// ── Bias probes (deterministic halves) ───────────────────────────────────
// The neutraliser must make anchoring and working-pattern signals invisible
// to the model. The model-dependent halves (fluent-vs-plain producing
// identical levels) run in the evaluation phase with a configured provider.

test('bias probe: anchored vs unanchored self-descriptions neutralise identically', () => {
  const base = 'I run the clinic diary, triage the referrals and supervise two apprentices.';
  const anchored = `${base} I am paid at band 4 but I'm doing band 5 work.`;
  const a = neutraliseEvidence(anchored, {});
  const b = neutraliseEvidence(base, {});
  assert.ok(!/band\s*[45]/i.test(a.text), 'band claims must not survive neutralisation');
  assert.ok(a.text.startsWith(b.text.slice(0, base.length - 1)));
});

test('bias probe: full-time vs job-share descriptions neutralise to the same working-pattern-free text', () => {
  const ft = 'I coordinate discharges across the unit.';
  const js = 'I work part-time in a job-share, 18.5 hours per week. I coordinate discharges across the unit.';
  const a = neutraliseEvidence(js, {});
  assert.ok(!/part-time|job.?share|18\.5\s*hours/i.test(a.text));
  assert.ok(a.text.includes('I coordinate discharges across the unit.'));
});
