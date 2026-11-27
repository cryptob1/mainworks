import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { liveModernVerbs, liveOldestVerbs } from './helpers/shard-hosts.js';
import { trialE2eHosts } from './helpers/trial-e2e-hosts.js';

// GY-4002 AC-2: a trial's e2e cases run on a test machine on each helper installed on the live
// machines today — vish-msi's run-shard:2 with receive-image:3, and omarchypc's run-shard:2 with
// receive-image:1 and prepare-run:1, which takes only two-part warm image tags — with no helper
// update, and each host stays ready.

const proof = 'integration:trial-e2e-on-each-installed-helper-version';
let fixture: Awaited<ReturnType<typeof trialE2eHosts>>;

before(async () => { fixture = await trialE2eHosts('gy-4002-helpers', { modern: liveModernVerbs, oldest: liveOldestVerbs }); });
after(() => fixture.restore());

test(`${proof} — the trial's case runs on a run-shard:2/receive-image:3 helper and on a run-shard:2/receive-image:1 helper`, { timeout: 600_000 }, async () => {
  for (const name of ['modern', 'oldest']) {
    const ran = await fixture.trial([`gy-compute@${name}`], ['e2e:alpha']);
    assert.deepEqual(ran.where('alpha'), [name], `alpha runs once, on ${name}: ${JSON.stringify(ran.ran)}\n${ran.result.logTail}`);
    const entry = ran.result.e2e?.find(item => item.case === 'alpha');
    assert.deepEqual([entry?.executed, entry?.failed, entry?.host], [1, 0, `gy-compute@${name}`]);
    assert.equal(ran.latest?.hosts.find(host => host.name === `gy-compute@${name}`)?.away, false, `${name} stays ready: ${JSON.stringify(ran.latest?.hosts)}`);
    assert.doesNotMatch(ran.result.logTail, /update-shim/, 'no helper update is attempted');
  }
});
