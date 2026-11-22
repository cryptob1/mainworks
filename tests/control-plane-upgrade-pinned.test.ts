import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyInstall, buildPlan, installRequestFromArgs, prepareInstall, redeployArguments } from '../src/install/index.js';
import { installDirectory, readInstallRecord } from '../src/install/secrets.js';
import { harness } from './install-harness.js';

// GY-3646: the daily control-plane upgrade failed at restart because the deploy watch's
// `install ... --plan` of an existing install ran the GitHub CLI preflight, and the watch's
// service environment had no working gh login ("gh is missing or not authenticated"). The
// restart of an install whose deploy key is registered needs nothing from gh.

const GH_FAILING = { match: 'gh ', result: { stdout: '', stderr: 'gh: not logged in', code: 1 } };

test('unit:control-plane-upgrade-pinned — the deploy watch\'s restart plan of an existing install passes preflight and runs no gh when gh is signed out', async () => {
  const initial = await harness({ provider: 'compose', serverUrl: 'http://127.0.0.1:4310' });
  try {
    const { request } = installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--apply']);
    const session = await prepareInstall(initial.root, request, initial.deps, 'apply');
    await applyInstall(session, await buildPlan(session));
    const record = await readInstallRecord(installDirectory('owner-project', initial.configHome));
    assert.ok(record, 'the first install wrote its record');

    const restart = await harness({
      provider: 'compose', serverUrl: 'http://127.0.0.1:4310',
      root: initial.root, configHome: initial.configHome, installed: true,
      extraResponses: [GH_FAILING],
    });
    // The exact argv the watch's restart port runs first (src/cli/upgrade.ts watchPorts).
    const args = redeployArguments(record, 'graphyard-local:abcdef123456');
    const planned = await prepareInstall(restart.root, installRequestFromArgs([...args.slice(0, -1), '--plan']).request, restart.deps, 'plan');
    const plan = await buildPlan(planned);
    assert.deepEqual(plan.preflight.filter(item => !item.ok), [], 'the restart plan passes preflight without a gh login');
    assert.deepEqual(restart.allCommandLines().filter(line => line.startsWith('gh ')), [], 'the restart never asks gh');
  } finally { await initial.cleanup(); }
});
