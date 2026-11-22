import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { builtEntry } from '../bin/built-entry.mjs';

/**
 * GY-3611: the CLI starts from dist/cli.mjs, one built file, not ~550 TypeScript files compiled by
 * tsx on every call (28 s of CPU for twenty starts from source). Proof: integration:cli-start-is-cheap.
 */
const root = fileURLToPath(new URL('..', import.meta.url));

test('integration:cli-start-is-cheap — twenty starts of the built CLI answering --help take under 10 s of user plus system CPU', { timeout: 120_000 }, () => {
  assert.ok(builtEntry(root, 'cli'), 'the test runner built dist/cli.mjs before the first file');
  // The shell's `times` prints its children's user and system CPU on its second line.
  const times = execFileSync('/bin/sh', ['-c', 'i=0; while [ $i -lt 20 ]; do "$0" bin/graphyard.mjs --help >/dev/null || exit 1; i=$((i+1)); done; times', process.execPath], { cwd: root, encoding: 'utf8' });
  const [user, system] = [...times.trim().split('\n')[1]!.matchAll(/(\d+)m([\d.]+)s/g)].map(([, minutes, seconds]) => Number(minutes) * 60 + Number(seconds));
  const cpu = user! + system!;
  assert.ok(cpu < 10, `twenty starts took ${cpu.toFixed(2)} s of CPU (user ${user}, system ${system})`);
});
