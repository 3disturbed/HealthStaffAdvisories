import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessUrgency, maxUrgency } from '../src/safety/urgency.js';

test('dismissal is critical', () => {
  const r = assessUrgency('I was dismissed from my job last week after a meeting');
  assert.equal(r.urgency, 'critical');
  assert.ok(r.triggers.some((t) => t.id === 'dismissal_happened'));
});

test('imminent hearing is at least high', () => {
  const r = assessUrgency('My disciplinary meeting is tomorrow and I have had no letter');
  assert.ok(['critical', 'high'].includes(r.urgency));
});

test('suspension triggers', () => {
  const r = assessUrgency('I have been suspended pending investigation');
  assert.equal(r.urgency, 'high');
  assert.ok(r.triggers.some((t) => t.id === 'suspension'));
});

test('patient safety speaking up triggers', () => {
  const r = assessUrgency('I raised a patient safety concern about unsafe staffing and now my shifts were cut');
  assert.ok(r.triggers.some((t) => t.id === 'speaking_up'));
});

test('safeguarding is critical', () => {
  const r = assessUrgency('There is a safeguarding allegation against me');
  assert.equal(r.urgency, 'critical');
});

test('stated deadline field raises urgency even without keywords', () => {
  const r = assessUrgency('I disagree with my shift pattern change', { meetingOrDeadline: 'Meeting on the 3rd' });
  assert.equal(r.urgency, 'high');
  assert.ok(r.triggers.some((t) => t.id === 'stated_deadline'));
});

test('benign pay question is normal', () => {
  const r = assessUrgency('I think my annual leave allowance calculation is slightly wrong');
  assert.equal(r.urgency, 'normal');
  assert.equal(r.triggers.length, 0);
});

test('urgency can only be raised by maxUrgency', () => {
  assert.equal(maxUrgency('critical', 'normal'), 'critical');
  assert.equal(maxUrgency('normal', 'high'), 'high');
  assert.equal(maxUrgency('self_service', 'normal'), 'normal');
});
