import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// GY-3647: the batch gate's check test:tests/product-reviews-run-in-parallel.test.ts failed on the
// loaded gate host and passed its re-run. The spec's own synchronization was load-sensitive: a
// reviewer whose first run timed out waiting for the other was retried, and that retry incremented
// the arrival counter to 2 — releasing the pair with one reviewer absent, so the both-alive
// assertion could never be set again — and the wait itself was a fixed five seconds of wall clock,
// which a launch lagging under load overruns. The spec must wait its settled budget for the other
// reviewer and count reviewers by name, never runs.

const spec = () => readFileSync(join(process.cwd(), 'tests/product-reviews-run-in-parallel.test.ts'), 'utf8');

test('unit:product-reviews-run-in-parallel-pinned — the spec waits its settled budget for the second reviewer and counts reviewers by name, not runs', () => {
  const source = spec();
  // The wait for the other reviewer is the spec's settled budget — the same bound until() polls on —
  // so a loaded host cannot decide the outcome, while a product that stops reviewing in parallel
  // still exhausts it and fails.
  const wait = /setTimeout\(\(\) => reject\(new Error\('product reviews did not run in parallel'\)\), ([\w]+)\)/.exec(source)?.[1];
  assert.ok(wait, 'the spec bounds its wait for the other reviewer');
  assert.equal(wait, 'settledMs', `the wait for the other reviewer is the settled budget, not a fixed wall-clock bound (found ${wait})`);
  const settled = /const settledMs = (\d+) \* (\d+);/.exec(source);
  assert.ok(settled, 'the spec names its settled budget beside until()');
  const tries = /for \(let tries = 0; tries < (\d+); tries\+\+\)/.exec(source)?.[1];
  const delay = /setTimeout\(resolve, (\d+)\)/.exec(source)?.[1];
  assert.ok(tries && delay, "the spec's until() names its tries and delay");
  assert.equal(`${settled![1]} * ${settled![2]}`, `${tries} * ${delay}`, 'the parallel wait is exactly until()\'s settled budget');
  // A reviewer's retried run must not release the other reviewer or stand in for it: arrivals are names.
  assert.doesNotMatch(source, /arrived\+\+/, 'arrivals are never counted per run');
  assert.match(source, /arrived\.add\(name\)/, 'a reviewer is counted when its own run arrives');
  assert.match(source, /arrived\.size === 2/, 'the pair is released only when both reviewer names have arrived');
  assert.match(source, /arrived\.has\('first'\) && arrived\.has\('second'\)/, 'the both-alive check runs whenever both reviewers are present');
});
