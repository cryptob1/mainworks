import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdictRefusal } from '../src/review-cap.js';

// GY-3641: an incomplete approval or an unlocated objection each cost a full round, so the verdict
// route refuses both, naming exactly what the reviewer must add.
const ids = ['AC-1', 'AC-2'];

test('unit:verdict-rules-on-every-criterion — a verdict rules on every criterion id, and a change request names where it blocks', () => {
  // A full verdict: each criterion ruled on, approval or a located change request.
  assert.equal(verdictRefusal('APPROVE', 'Reviewed head against base.\nAC-1 met: the route refuses.\n[AC-2] Met — the step records it.', ids), null);
  assert.equal(verdictRefusal('REQUEST_CHANGES', 'AC-1 met.\nAC-2 unmet.\nBLOCKING: src/e2e/steps.ts:310 — the baseline error fails the candidate', ids), null);

  // One missing AC-2: refused, naming AC-2 and the line to add. Mentioning it without a ruling is not ruling on it.
  const missing = verdictRefusal('APPROVE', 'AC-1 met.', ids);
  assert.ok(missing && /AC-2/.test(missing) && !/AC-1\b/.test(missing.split('add')[0]!), missing ?? 'no refusal');
  assert.match(missing!, /"AC-2 met — WHY" or "AC-2 unmet — WHY"/);
  assert.match(verdictRefusal('APPROVE', 'AC-1 met. AC-2 is interesting.', ids) ?? '', /AC-2/);
  assert.match(verdictRefusal('REQUEST_CHANGES', 'AC-1 met.\nBLOCKING: AC-1 — unmet', ids) ?? '', /AC-2/);

  // A request for changes with no location: refused, telling the reviewer the two forms.
  const unlocated = verdictRefusal('REQUEST_CHANGES', 'AC-1 met.\nAC-2 met.\nBLOCKING: this feels fragile', ids);
  assert.ok(unlocated, 'an unlocated change request is refused');
  assert.match(unlocated!, /BLOCKING: PATH:LINE — FINDING/);
  assert.match(unlocated!, /BLOCKING: AC-N — FINDING/);
  assert.ok(verdictRefusal('REQUEST_CHANGES', 'AC-1 met.\nAC-2 met.\nThe diff is wrong somewhere.', ids));

  // One with only a criterion id: accepted.
  assert.equal(verdictRefusal('REQUEST_CHANGES', 'AC-1 met.\nAC-2 unmet.\nBLOCKING: AC-2 — a broken baseline still fails the candidate', ids), null);

  // An item without criteria asks for no rulings.
  assert.equal(verdictRefusal('APPROVE', 'Looks right.', []), null);
  // A COMMENT records a blocker, not a verdict.
  assert.equal(verdictRefusal('COMMENT', 'BLOCKED: git show failed', ids), null);
});
