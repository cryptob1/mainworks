import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completePreflight } from '../src/cli/complete.js';
import { flowNumbers } from '../src/flow-numbers.js';
import { gitRepo } from './helpers/git-repo.js';

// GY-4054: incomplete sweeps leaving untouched sibling callers/surfaces behind was the top shared
// review and product-review rework cause in the 6 h before filing (7 of 11 reworks across 5 items:
// GY-4000, GY-4016, GY-4030, GY-4042, GY-4050). When a head renames a CLI command, complete now
// refuses untouched sibling callers and user-facing surfaces until they are updated or ruled out of scope.

test('integration:review-cause-fixed-at-source-3 — complete refuses a command rename that leaves untouched sibling callers or surfaces behind', async () => {
  const { root, git } = await gitRepo({
    label: 'review-cause-3',
    files: {
      'src/master/guide.ts': "export default 'Run mainworks master status before acting.';\n",
      'src/harness.ts': "export const allow = ['Bash(${cli} master:*)', 'Bash(${cli} master review:*)'];\n",
      'src/master/harness.ts': "export const prompt = 'Run node ${config.cliPath} master status, then node ${config.cliPath} master guide.';\n",
      'web/pages/guide.tsx': "export const cmd = '<code>{COMMAND_NAME} master status</code>';\n",
    },
  });
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');

  // Reproduces GY-4050's and GY-4042's product-review findings: guide text renamed master -> lead,
  // while the Lead harness allowlist, launch prompt, and Help page still only reference master.
  git('checkout', '-qb', 'graphyard/gy-1-1');
  await writeFile(join(root, 'src/master/guide.ts'), "export default 'Run mainworks lead status before acting.';\n");
  git('commit', '-qam', 'GY-1: rename master to lead in guide\n\nAC-1 — met: guide says lead');

  const work = {
    key: 'GY-1',
    type: 'chore',
    criteria: [{ id: 'AC-1', text: 'Lead guide says mainworks lead', proofs: [] }],
  };

  await assert.rejects(completePreflight(root, work, git('rev-parse', 'HEAD')), (error: Error) => {
    assert.match(error.message, /master.*lead/);
    assert.match(error.message, /src\/harness\.ts:1/);
    assert.match(error.message, /src\/master\/harness\.ts:1/);
    assert.match(error.message, /web\/pages\/guide\.tsx:1/);
    assert.match(error.message, /out of scope/);
    return true;
  });

  // Adding the new lead allowlist rule beside the kept master alias satisfies src/harness.ts;
  // updating src/master/harness.ts satisfies it; ruling web/pages/guide.tsx out of scope satisfies it.
  await writeFile(
    join(root, 'src/harness.ts'),
    "export const allow = ['Bash(${cli} lead:*)', 'Bash(${cli} lead review:*)', 'Bash(${cli} master:*)', 'Bash(${cli} master review:*)'];\n",
  );
  await writeFile(
    join(root, 'src/master/harness.ts'),
    "export const prompt = 'Run node ${config.cliPath} lead status, then node ${config.cliPath} lead guide.';\n",
  );
  git('commit', '-qam', 'GY-1: update Lead harness and launch prompt');

  // web/pages/guide.tsx is still untouched and unruled, so complete still refuses naming only it.
  await assert.rejects(completePreflight(root, work, git('rev-parse', 'HEAD')), (error: Error) => {
    assert.doesNotMatch(error.message, /src\/harness\.ts/);
    assert.doesNotMatch(error.message, /src\/master\/harness\.ts/);
    assert.match(error.message, /web\/pages\/guide\.tsx:1/);
    return true;
  });

  // Once the remaining intentionally untouched file is ruled out of scope, complete accepts.
  git('commit', '-q', '--allow-empty', '-m', 'GY-1: scope\n\nweb/pages/guide.tsx — out of scope: companion item updates dashboard copy');
  await completePreflight(root, work, git('rev-parse', 'HEAD'));

  // A normal change that does not rename a CLI command is unaffected even if master appears elsewhere.
  await mkdir(join(root, 'src/other'), { recursive: true });
  await writeFile(join(root, 'src/other/unrelated.ts'), 'export const ok = true;\n');
  git('add', 'src/other/unrelated.ts');
  git('commit', '-qm', 'GY-1: unrelated file');
  await completePreflight(root, work, git('rev-parse', 'HEAD'));
});

test('integration:review-cause-fixed-at-source-3 — master status counts the group as missed sibling so its fall after deploy shows', () => {
  const now = Date.parse('2026-11-27T18:45:00Z');
  const findings = [
    ['GY-4042', 'Settings → Agents (web/pages/fleet.tsx) — The primary empty-state notice instructs the owner to run `mainworks master registry propose --apply` instead of `mainworks lead registry propose --apply`'],
    ['GY-4050', "LEAD SESSION FLOW — the Claude Lead's generated harness (src/harness.ts:567-568) allows only `master:*` and `master review:*`, while the guide tells it to run `mainworks lead status`"],
    ['GY-4030', 'src/host-lock.ts:12 — Writing `${process.pid} ${holder}` into the shared lock file breaks backwards compatibility with pre-GY-4030 `takeLock` callers (AC-1, AC-2.2)'],
  ];
  const items = findings.map(([key, finding], index) => ({
    key, title: key, stage: 'build', stageEnteredAt: new Date(now).toISOString(), mergedAt: null, attempts: [],
    events: [{ kind: 'rework', at: new Date(now - (index + 1) * 60_000).toISOString(), binding: `abc${index}:verdict:review-codex`, reason: `${key}: the product review requested changes on abc: BLOCKING: ${finding}. The verdict stands.` }],
  }));
  assert.deepEqual(flowNumbers(items, 24, now).reviewReasons, [{ label: 'missed sibling', count: 3 }]);
});
