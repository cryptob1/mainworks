import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { hostGitTrust } from './helpers/git-trust.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3649: the batch gate's check test:tests/reporter-identity.test.ts failed on d6390204cd78 and
// passed on its re-run because only the failing run had scheduled the file onto a remote shard. A
// shard container runs as a user that does not own the run's checkout, and the host shim trusts
// that checkout only through GIT_CONFIG_* environment (src/host-shim.ts). The reporter test
// replaced its CLI children's whole environment and dropped that trust, so the CLI read its own
// release as `unreleased unknown` and the release-skew guard (src/cli/context.ts) refused every
// command. The child environment now keeps the host's git trust; this pin fails without that.

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

test('unit:reporter-identity-pinned — the reporter test\'s CLI children keep the host\'s git trust, so on a shard the CLI still reads its own release', async () => {
  const file = await readFile(fileURLToPath(new URL('./reporter-identity.test.ts', import.meta.url)), 'utf8');
  assert.match(file, /GRAPHYARD_TOKEN_FILE: tokenFile, \.\.\.hostGitTrust\(\)/, 'the reporter child environment keeps the host git trust');

  // The shard's condition, with git's own knob: a user that does not own the checkout, trusted only by the shim's environment.
  const home = await temporaryDirectory('reporter-pinned-home');
  const shard = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: root, UNRELATED: 'dropped' };
  const cliRelease = (env: NodeJS.ProcessEnv) =>
    execFileSync(process.execPath, [cli, 'version'], { cwd: home, env: { PATH: process.env.PATH, HOME: home, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1', ...env }, encoding: 'utf8' }).split('\n')[0]!;

  assert.deepEqual(Object.keys(hostGitTrust(shard)).sort(), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']);
  assert.match(cliRelease({}), /unreleased unknown/, 'without the trust the CLI cannot read its release, as on the shard');
  assert.doesNotMatch(cliRelease(hostGitTrust(shard)), /unknown/, 'with the host trust kept, the CLI reads its release');
});
