import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { builtEntry } from '../bin/built-entry.mjs';

/**
 * GY-3754: `tests/cli-start-is-cheap.test.ts` flaked because `src/cli/index.ts` eagerly loaded
 * every command module (master, install, upgrade, db, merge-writer, daemon, reviewer, hundreds of
 * Zod schemas) on every CLI start, pushing 20 starts of `bin/graphyard.mjs --help` past the 10 s
 * CPU budget. Pin both the cause (importing `src/cli/index.ts` and answering `--help` never loads
 * heavy command implementations) and the result (20 starts stay well under budget).
 * Proof: unit:cli-start-is-cheap-pinned.
 */
const root = fileURLToPath(new URL('..', import.meta.url));

test('unit:cli-start-is-cheap-pinned — answering --help loads no heavy command implementation modules', { timeout: 60_000 }, () => {
  const probe = `
    import { registerHooks } from 'node:module';
    const loaded = new Set();
    registerHooks({
      load(url, context, nextLoad) {
        loaded.add(url);
        return nextLoad(url, context);
      },
    });
    const { main } = await import('./src/cli/index.ts');
    await main(['--help']);
    const heavy = [
      '/src/daemon/state.ts',
      '/src/merge-writer/trial.ts',
      '/src/reviewer.ts',
      '/src/install/index.ts',
      '/src/store.ts',
      '/src/repository-setup.ts',
      '/src/master/profiles.ts',
    ];
    const hit = heavy.filter(suffix => [...loaded].some(url => url.endsWith(suffix)));
    process.stderr.write(JSON.stringify({ total: loaded.size, hit }) + '\\n');
  `;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probe], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^Usage: /m, '--help still prints usage');
  const report = JSON.parse(run.stderr.trim().split('\n').at(-1)!);
  assert.deepEqual(report.hit, [], `answering --help eagerly loaded heavy modules: ${report.hit.join(', ')}`);
});

test('unit:cli-start-is-cheap-pinned — twenty starts of the built CLI answering --help stay well under 10 s CPU', { timeout: 120_000 }, () => {
  assert.ok(builtEntry(root, 'cli'), 'the test runner built dist/cli.mjs before the first file');
  const times = execFileSync('/bin/sh', ['-c', 'i=0; while [ $i -lt 20 ]; do "$0" bin/graphyard.mjs --help >/dev/null || exit 1; i=$((i+1)); done; times', process.execPath], { cwd: root, encoding: 'utf8' });
  const [user, system] = [...times.trim().split('\n')[1]!.matchAll(/(\d+)m([\d.]+)s/g)].map(([, minutes, seconds]) => Number(minutes) * 60 + Number(seconds));
  const cpu = user! + system!;
  assert.ok(cpu < 8, `twenty starts took ${cpu.toFixed(2)} s of CPU (user ${user}, system ${system}); expected < 8 s`);
});
