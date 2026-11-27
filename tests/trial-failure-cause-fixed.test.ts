import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { schemaAt } from '../src/cli/upgrade.js';
import { gitRepo } from './helpers/git-repo.js';
import { releaseBeforeNewestGeneration } from './helpers/release-before-newest-generation.js';

// GY-3960: upgrade-backup-before-checkout failed GY-3942's merge trial with 42 !== 43 because it took the
// parent of the newest commit touching the schema lineage as the release one generation older. GY-3942's
// second round rewrote its own new generation in place, so that parent already held the newest generation.
const lineage = (...digests: string[]) => `export const schemaGenerations: readonly (string | null)[] = [\n  null,\n${digests.map(digest => `  'sha256:${digest}',\n`).join('')}];\n`;

test('integration:trial-failure-cause-fixed — the upgrade test starts from the release one schema generation older, also when the newest lineage commit rewrote that generation in place', async () => {
  const repo = await gitRepo({ label: 'trial-failure-cause-fixed', files: { 'src/store/schema-lineage.ts': lineage('aa') } });
  const commit = (file: string, text: string) => {
    writeFileSync(join(repo.root, file), text);
    repo.git('add', '-A'); repo.git('commit', '-qm', file);
    return repo.git('rev-parse', 'HEAD');
  };
  const generationAt = (revision: string) => schemaAt(repo.git('show', `${revision}:src/store/schema-lineage.ts`));

  const older = commit('src/other.ts', 'export {};\n');
  const appended = commit('src/store/schema-lineage.ts', lineage('aa', 'bb'));
  assert.equal(releaseBeforeNewestGeneration(repo.root, appended), older, 'an appended generation: the release before it');

  // GY-3942's shape: the newest generation is rewritten in place, then an unrelated change lands.
  commit('src/store/schema-lineage.ts', lineage('aa', 'cc'));
  const newer = commit('src/other.ts', 'export const later = 1;\n');
  const previous = releaseBeforeNewestGeneration(repo.root, newer);
  assert.equal(generationAt(newer), 2);
  assert.equal(generationAt(previous), 1, 'the upgrade starts one generation older than the release it upgrades to');
  assert.equal(previous, older);
});
