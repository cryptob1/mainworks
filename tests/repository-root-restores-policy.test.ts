import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryPolicy } from '../src/model-boundary/repository-policy';
import { filingRefusal } from '../src/model-boundary/user-facing';
import { pointRepositoryRoot } from './helpers/repository-root';

test('unit:repository-root-restores-policy — a test that points the process at another checkout leaves no policy behind for the next', () => {
  const criteria = [{ proofs: ['e2e:some-case'] }];
  // This repository declares e2e.serve, so an e2e: proof is accepted.
  assert.ok(repositoryPolicy().e2e.serve);
  const other = mkdtempSync(join(tmpdir(), 'repository-root-'));
  writeFileSync(join(other, 'graphyard.json'), '{}');
  const restore = pointRepositoryRoot(other);
  // The other checkout declares no serve: the read made while it is in force refuses.
  assert.match(filingRefusal({ type: 'chore', criteria }) ?? '', /has no way to serve a head/);
  restore();
  // Restored, the next reader judges by this repository's policy again, not the cached other one.
  assert.ok(repositoryPolicy().e2e.serve);
  assert.equal(filingRefusal({ type: 'chore', criteria }), null);
});
