import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// GY-3594: the code says Mainworks. The old name stays only inside the names tests/old-names.txt
// lists, which installs created before the rename still use.
const root = fileURLToPath(new URL('..', import.meta.url));
const allowlist = 'tests/old-names.txt';
const entries = readFileSync(new URL('old-names.txt', import.meta.url), 'utf8').split('\n').filter(line => line.trim() && !line.startsWith('#'));
/** `path P` lines name recorded historical files kept byte for byte; every other line is a pattern. */
const recorded = entries.filter(line => line.startsWith('path ')).map(line => `:!${line.slice(5)}`);
const allowed = entries.filter(line => !line.startsWith('path ')).map(line => new RegExp(line, 'g'));

/** Every line of a tracked text file that says the old name outside an allowlisted name. */
export function oldNameLines(): string[] {
  const out = execFileSync('git', ['grep', '-I', '-n', '-i', 'graphyard', '--', '.', `:!${allowlist}`, ...recorded], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  return out.split('\n').filter(Boolean).filter(match => {
    const line = match.replace(/^[^:]*:\d+:/, '');
    return /graphyard/i.test(allowed.reduce((rest, pattern) => rest.replace(pattern, ''), line));
  });
}

test('unit:old-name-appears-only-in-the-allowlist — a case-insensitive search for the old name over tracked files finds it only in allowlisted names', () => {
  const lines = oldNameLines();
  assert.deepEqual(lines.slice(0, 50), [], `${lines.length} line(s) say the old name outside ${allowlist}`);
});
