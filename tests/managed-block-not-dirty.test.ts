import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { coordinatorCheckoutRefusal, readCoordinatorCheckout } from '../src/master/profiles.js';
import { readRelease } from '../src/protocol-version.js';
import type { UpRequest } from '../src/up.js';

// GY-3271: the managed `<!-- graphyard -->` block of AGENTS.md is Mainworks's own writing — its
// refresh rewrites the committed block (GY-2240) — so a checkout whose only change lies inside it
// is clean to `up`'s preflight, to the loop's checkout refusal and to the release the loop records;
// a change outside the block still stops with the same dirty-checkout refusal as before.

// Loaded inside the test, so a tree without them fails as a test case, not at load.
const up = () => import('../src/up.js');

const agentsFile = (block: string) => `# Working here

Hand-written guidance the block never rewrites.

<!-- graphyard -->
## Mainworks coordination

${block}
<!-- /graphyard -->
`;
const committedBlock = 'This repository uses Mainworks; topics: claim, sync, complete.';
const rewrittenBlock = 'This repository uses Mainworks; topics: claim, sync, complete, park, blocked.';

test('unit:up-ignores-managed-block-dirty — a CLI checkout whose only change is inside AGENTS.md\'s managed block passes the dirty-checkout check; a change outside it still stops', async () => {
  const { upDependencies } = await up();
  const base = await temporaryDirectory('managed-block-not-dirty');
  const { root: checkout, head: commit } = await gitRepo({ root: join(base, 'graphyard'), files: { 'bin/graphyard.mjs': '// cli\n', 'src/loop.ts': 'export const loop = 1;\n', 'AGENTS.md': agentsFile(committedBlock) } });
  const repository = join(base, 'repository');
  await mkdir(join(repository, '.graphyard'), { recursive: true });
  const request: UpRequest = { repository: 'acme/shop', provider: 'compose', agent: false, master: 'claude' };
  const cliCheckout = () => upDependencies(repository, join(checkout, 'bin', 'graphyard.mjs'), request, () => {}).cliCheckout!();

  // The refresh's own change: only the block's text differs from the commit.
  await writeFile(join(checkout, 'AGENTS.md'), agentsFile(rewrittenBlock));
  assert.deepEqual(await cliCheckout(), { root: checkout, dirty: [] }, 'up proceeds past the dirty-checkout check');
  assert.equal(coordinatorCheckoutRefusal(await readCoordinatorCheckout(checkout), 'the master loop'), null, 'the loop refuses nothing');
  assert.deepEqual(readRelease(checkout), { commit, dirty: false }, 'the loop records a clean release');

  // Real work beside the managed-block change still stops the checkout.
  await writeFile(join(checkout, 'src', 'loop.ts'), 'export const loop = 2;\n');
  const beside = await cliCheckout();
  assert.ok(beside!.dirty.includes('src/loop.ts'), 'a change in another file is still dirty work');
  assert.equal(readRelease(checkout).dirty, true, 'the loop still records a dirty release');

  // A change outside the block — even the only one — stops with today's refusal.
  await execFileSync('git', ['-C', checkout, 'checkout', '--', 'src/loop.ts'], { stdio: 'ignore' });
  await writeFile(join(checkout, 'AGENTS.md'), `# Working here, edited by hand\n\nHand-written guidance the block never rewrites.\n\n<!-- graphyard -->\n## Mainworks coordination\n\n${rewrittenBlock}\n<!-- /graphyard -->\n`);
  assert.deepEqual(await cliCheckout(), { root: checkout, dirty: ['AGENTS.md'] }, 'a change outside the block still stops up');
  assert.match(coordinatorCheckoutRefusal(await readCoordinatorCheckout(checkout), 'the master loop')!, /holds uncommitted work/, 'the loop is still refused');
  assert.equal(readRelease(checkout).dirty, true, 'the loop still records a dirty release');
});
