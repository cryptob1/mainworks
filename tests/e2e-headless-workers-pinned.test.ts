import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { caseTestsRemoteable, hostableTrialCase } from '../src/merge-writer/remote-shards.js';

// GY-4099: the headless-workers case failed on a test machine in its first half second. Its test files
// call setupMaster through tests/helpers/headless-workers.ts, and a managed worktree root needs durable
// storage a test machine lacks (GY-4036), but placement read only the test files, not their helpers.
const repo = join(import.meta.dirname, '..');

test('unit:e2e-headless-workers-pinned — a case whose tests reach setupMaster through a helper stays on the coordinator', async () => {
  assert.equal(await hostableTrialCase(repo, 'headless-workers'), false, 'headless-workers needs durable managed worktrees');
  const files: Record<string, string> = {
    'tests/a.test.ts': "import { fixture } from './helpers/fixture.js';\n",
    'tests/helpers/fixture.ts': 'await setupMaster(root, {});\n',
    'tests/b.test.ts': "import { listen } from './helpers/http-server.js';\n",
    'tests/helpers/http-server.ts': 'export const listen = () => {};\n',
  };
  const read = async (file: string) => files[file] ?? '';
  assert.equal(await caseTestsRemoteable(['tests/a.test.ts'], read), false, 'a helper calling setupMaster keeps its test here');
  assert.equal(await caseTestsRemoteable(['tests/b.test.ts'], read), true, 'a helper naming no local-only word lets its test roam');
});
