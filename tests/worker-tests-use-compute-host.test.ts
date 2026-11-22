import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { readShardHosts } from '../src/merge-writer/remote-shards.js';
import { runHere, runOnComputeHosts } from './helpers/compute-host-tests.js';
import { shardHosts, shardRepository } from './helpers/shard-hosts.js';

// GY-3610: workers' own test runs were the largest CPU load on the coordinator. With a compute host
// ready, `npm run test:affected` runs its selected files there through the merge trial's
// remote-shard runner; only files pinned local-only start a process here.

const image = 'graphyard-trial:worker-tests';
/** The fixture's suite runner: files from --files-from (a shard) or its arguments (a run here); each prints its result and records where it ran. */
const runner = (answers: string) => `import { readFileSync, appendFileSync } from 'node:fs';
const argv = process.argv.slice(2), at = name => argv[argv.indexOf(name) + 1];
const files = argv.includes('--files-from') ? readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean) : argv.filter(arg => !arg.startsWith('-'));
const where = process.cwd().match(/\\/hosts\\/([^/]+)\\/home\\//)?.[1] ?? 'here';
let failed = 0;
for (const file of files) {
  readFileSync(file);
  const passed = !file.includes('fails'); failed += passed ? 0 : 1;
  appendFileSync(${JSON.stringify(answers)}, JSON.stringify({ file, where }) + '\\n');
  if (argv.includes('--durations')) appendFileSync(at('--durations'), JSON.stringify({ file, passed, durationMs: 1 }) + '\\n');
  console.log((passed ? 'ok ' : 'not ok ') + file);
}
process.exit(failed ? 1 : 0);
`;

test('integration:worker-tests-use-compute-host — with a compute host ready, test:affected runs its files there through the remote-shard runner, prints the local run\'s results and exit code, and starts only pinned files here', { timeout: 600_000 }, async () => {
  const hosts = await shardHosts('worker-tests-host', ['host-a'], { [image]: `sha256:${'3610'.repeat(16)}` });
  const answers = join(hosts.root, 'answers.jsonl');
  const plain = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c-fails.test.ts'], pinned = ['tests/uses-docker.test.ts'];
  const repository = await shardRepository('worker-tests-repo', [], { 'scripts/tests.mjs': runner(answers),
    ...Object.fromEntries(plain.map(file => [file, 'test("adds", () => 1)\n'])), [pinned[0]!]: 'import { docker } from "docker"\n' });
  // The worker's uncommitted file runs too: the host gets the working tree as it stands.
  await writeFile(join(repository.root, 'tests/d.test.ts'), 'test("new", () => 1)\n');
  const files = [...plain, 'tests/d.test.ts', ...pinned], command = ['node', 'scripts/tests.mjs'];
  const run: ChildRun = (program, args, options) => defaultChildRun(program, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
  const read = async (named: readonly string[]) => (await readShardHosts(named, run, 2)).map(reading => ({ ...reading, cores: 8, busy: 0, steal: 0, celsius: null }));
  const lines = async () => existsSync(answers) ? (await readFile(answers, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { file: string; where: string }) : [];
  const results = (text: string) => text.split('\n').filter(line => /^(not )?ok tests\//.test(line)).sort();

  let remoteOut = '';
  const code = await runOnComputeHosts({ root: repository.root, files, run, hosts: ['gy-compute@host-a'], command, image, read, print: text => { remoteOut += text; } });
  const placed = await lines();
  assert.deepEqual(placed.map(line => line.file).sort(), [...files].sort(), remoteOut);
  assert.deepEqual(placed.filter(line => line.where === 'here').map(line => line.file), pinned, `no test file started here but the pinned one: ${JSON.stringify(placed)}`);
  assert.ok(placed.filter(line => line.where !== 'here').every(line => line.where === 'host-a'), JSON.stringify(placed));

  await rm(answers);
  let localOut = '';
  const none = await runOnComputeHosts({ root: repository.root, files, run, hosts: [], command, image, read });
  assert.equal(none, null, 'with no host ready the files run here');
  const localCode = await runHere(repository.root, files, command, text => { localOut += text; });
  assert.deepEqual(results(remoteOut), results(localOut), 'the same per-file results as a local run');
  assert.equal(code, localCode, 'and the same exit code');
  assert.equal(code, 1, 'the failing file fails the run');
});
