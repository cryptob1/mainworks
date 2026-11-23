import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { remoteCheckEnd } from '../src/merge-writer/remote-shards.js';
import { trialContainerFault } from '../src/merge-writer/trial-load.js';

// GY-3744: a host prepared before the rename runs a helper that prints `graphyard-check …` lines and
// `graphyard trial container: …`. The coordinator reads them as it reads `mainworks-…`: the host's verdict stands, never rerun here.

const proof = 'unit:host-helper-lines-read-with-either-name';

test(`${proof} — an older helper's check lines are the host's verdict: exit 0 passed, exit 1 failed, neither dropped`, () => {
  for (const name of ['graphyard', 'mainworks']) {
    const passed = remoteCheckEnd('gy-compute@box', `postgres answered\n\n${name}-check services 120\n${name}-check command 40\n${name}-check teardown 9\n${name}-check exit 0\n`);
    assert.equal(passed.status, 0, `${name}: judged passed on the host`);
    assert.deepEqual(passed.steps.map(step => step.step), ['services', 'command', 'teardown']);
    assert.equal(passed.out.trim(), 'postgres answered', `${name}: the helper's own lines are stripped`);
    const failed = remoteCheckEnd('gy-compute@box', `not ok 1\n\n${name}-check command 40\n${name}-check exit 1`);
    assert.equal(failed.status, 1, `${name}: judged failed on the host, not dropped to this machine`);
  }
  assert.equal(trialContainerFault('graphyard trial container: Trial-host fault: the disk is full\n'), 'Trial-host fault: the disk is full');
  assert.throws(() => remoteCheckEnd('gy-compute@box', 'graphyard trial container: Trial-host fault: the disk is full\n'), /dropped/);
});

test(`${proof} — every parser of a helper line accepts both names`, () => {
  const helper = readFileSync('src/host-shim.ts', 'utf8');
  assert.match(helper, /'mainworks-check '/, 'the helper prints the new name');
  const marker = /(graphyard|mainworks)(-check\b|-no-docker\b| trial container)/g;
  for (const file of ['src/merge-writer/remote-shards.ts', 'src/merge-writer/trial-load.ts', 'src/hosts.ts']) {
    const source = readFileSync(file, 'utf8');
    // The one constant whose words the launcher prints is an emitter, not a parser.
    const lineOf = (index: number) => source.slice(source.lastIndexOf('\n', index) + 1, index);
    const one = [...source.matchAll(marker)].filter(match => !source.slice(0, match.index).endsWith('(?:graphyard|') && !lineOf(match.index).startsWith("const launcherLine = '"));
    assert.deepEqual(one.map(match => match[0]), [], `${file} reads a helper line under one name only`);
    assert.ok(/\(\?:graphyard\|mainworks\)/.test(source), `${file} reads both names`);
  }
});
