import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { hostableTrialCase, hostSafeMarker, remoteShardSummary } from '../src/merge-writer/remote-shards.js';
import { trialE2eHosts } from './helpers/trial-e2e-hosts.js';

// GY-4002 AC-1: a merge trial's local-environment e2e cases run on ready test machines through the
// daily catalog's image path, spread across hosts; a case declaring a secret or naming an environment
// runs here. Each result and failing step reaches the verdict the same way wherever it ran. A host
// that faults reruns its cases here once, named as a host fault, never failing the change; with no host
// ready every case runs here as before. Master status's remote share counts the e2e cases.

const proof = 'integration:trial-e2e-cases-run-on-a-test-machine';
const proofs = ['e2e:alpha', 'e2e:beta', 'e2e:gamma', 'e2e:delta', 'e2e:epsilon'];
let fixture: Awaited<ReturnType<typeof trialE2eHosts>>;

before(async () => { fixture = await trialE2eHosts('gy-4002-cases', { a: null, b: null }); });
after(() => fixture.restore());

test(`${proof} — the trial's cases run on two ready hosts, a secret's and an environment's case here, a faulting host's case here once, and every case here with no host ready`, { timeout: 600_000 }, async () => {
  const spread = await fixture.trial(['gy-compute@a', 'gy-compute@b'], proofs);
  const entry = (id: string) => spread.result.e2e?.find(item => item.case === id);
  assert.deepEqual(spread.where('alpha').length, 1, spread.result.logTail);
  const placed = ['alpha', 'beta', 'gamma'].map(id => spread.where(id)[0]);
  assert.ok(placed.every(host => host === 'a' || host === 'b'), `alpha, beta and gamma run on the test machines: ${JSON.stringify(spread.ran)}\n${spread.result.logTail}`);
  assert.equal(new Set(placed).size, 2, `the cases spread across both hosts: ${JSON.stringify(placed)}`);
  for (const id of ['alpha', 'beta', 'gamma']) assert.equal(entry(id)?.host, `gy-compute@${spread.where(id)[0]}`, `the trial record names the host ${id} ran on: ${JSON.stringify(entry(id))}`);
  assert.deepEqual([entry('alpha')?.executed, entry('alpha')?.failed], [1, 0]);
  assert.deepEqual([entry('gamma')?.executed, entry('gamma')?.failed], [1, 1]);
  assert.match(entry('gamma')?.failingStep ?? '', /^step 1 record gamma: /, 'the failing step comes back as it does from this machine');
  assert.equal(entry('delta')?.host, undefined, 'a case declaring a secret runs here');
  assert.ok(!spread.where('delta').some(host => host !== 'here'));
  assert.equal(entry('epsilon')?.host, undefined, 'a case naming an environment runs here');
  assert.match(entry('epsilon')?.failingStep ?? '', /environment "staging"/);
  assert.deepEqual(spread.latest?.e2e, { cases: 5, remote: 3 }, 'the trial record counts its e2e cases and those run remotely');
  const share = remoteShardSummary([{ ...spread.latest!, shards: 0, remote: 0 }]);
  assert.equal(share?.shardsRemote, '60%', 'master status\'s remote share counts e2e cases');

  // Host b reads ready but drops the run: its cases run here once, named as a host fault, and pass.
  await fixture.hosts.down('b', true);
  try {
    const faulted = await fixture.trial(['gy-compute@a', 'gy-compute@b'], ['e2e:alpha', 'e2e:beta']);
    const ran = (id: string) => faulted.result.e2e?.find(item => item.case === id);
    const onB = ['alpha', 'beta'].find(id => faulted.where(id)[0] === 'here')!;
    assert.ok(onB, `one case ran here after b faulted: ${JSON.stringify(faulted.ran)}\n${faulted.result.logTail}`);
    assert.deepEqual(faulted.where(onB), ['here'], 'the faulted case reruns here exactly once');
    assert.deepEqual([ran(onB)?.executed, ran(onB)?.failed, ran(onB)?.host], [1, 0, undefined], 'a host fault is never the change\'s failure');
    assert.match(faulted.result.logTail, new RegExp(`host fault: e2e:${onB} on gy-compute@b`), 'the log names the host fault');
  } finally { await fixture.hosts.down('b', false); }

  // No host under its heat limit: every case runs here, exactly as before.
  const hot = await fixture.trial(['gy-compute@a', 'gy-compute@b'], ['e2e:alpha', 'e2e:beta'], () => ({ celsius: 99 }));
  assert.deepEqual([hot.where('alpha'), hot.where('beta')], [['here'], ['here']], hot.result.logTail);
  assert.ok(hot.result.e2e?.every(item => item.host === undefined && item.failed === 0), JSON.stringify(hot.result.e2e));
});

test(`${proof} — a case whose tests name Docker only as text, marked so, may run on a test machine; one that uses it stays here`, async () => {
  assert.equal(await hostableTrialCase(join(import.meta.dirname, '..'), 'smoke'), true, 'smoke\'s tests name Docker only in approved prose');
  assert.equal(await hostableTrialCase(join(import.meta.dirname, '..'), 'verification-uses-remote-hosts'), false, 'its tests drive Docker');
  assert.ok(hostSafeMarker.length && !/docker|bwrap/i.test(hostSafeMarker));
});
