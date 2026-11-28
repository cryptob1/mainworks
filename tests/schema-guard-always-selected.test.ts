import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { changedDeclarations, changedExports, dependencyMap, listTestFiles, repositoryRoot, selectAffected } from '../scripts/ci-tests.mjs';
import { gitRepo } from './helpers/git-repo.js';

// GY-4067: GY-4058 changed SQL a table's projection embeds (src/store/coordination-sql.ts). The
// schema generation guard reaches that file only through other modules, which an item trial's
// one-hop selection (GY-3866) skips: the trial passed, the batch gate failed on the served commit,
// and the merge was reverted. The guard is a static rule now: every item trial selects it.

const guard = 'tests/schema-generation-guard.test.ts', file = 'src/store/coordination-sql.ts';

test('unit:schema-guard-always-selected — an item trial of a body-only change to src/store/coordination-sql.ts selects the schema generation guard', async () => {
  const text = readFileSync(join(repositoryRoot, file), 'utf8');
  // GY-4058's shape of change: a key the projection strips from the document changes; no export, type or import moves.
  const stripped = "`d.document - '{";
  assert.ok(text.includes(stripped), `${file} no longer strips a key list from the document: move this edit to its SQL`);
  const { root, head: base } = await gitRepo({ label: 'schema-guard-selection', files: { [file]: text } });
  try {
    writeFileSync(join(root, file), text.replace(stripped, "`d.document - '{gy4067,"));
    // What the merge writer's trial asks its selector: against the base tip, one hop from the changed file.
    const changed = [file], tests = listTestFiles(), trial = selectAffected(changed, dependencyMap(repositoryRoot, tests), tests, changedDeclarations(changed, base, root), changedExports(changed, base, root));
    assert.equal(trial.mode, 'affected', trial.reason);
    assert.ok(trial.files.includes(guard), `the trial selects ${trial.files.length} files for this change, and ${guard} is not one of them: ${trial.files.join(', ')}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
