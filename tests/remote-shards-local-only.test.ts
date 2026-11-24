import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { localOnlyTestPattern, remoteableTestFile, splitLocalOnlyTests, type HostReading } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { shardHosts, shardRepository } from './helpers/shard-hosts.js';

// GY-3612: database and browser tests run on remote shards too (each shard container starts the shared
// warm Postgres cluster and ships Chromium in the trial image). Only tests that need the Docker socket
// or host-pinned confinement/benchmarks stay local; when a host's image lacks the browser, browser
// test files stay local and the reason is recorded once.

test('unit:only-docker-tests-stay-on-the-coordinator — postgres, withDatabase, playwright and chromium are remoteable; docker stays local', async () => {
  assert.equal(localOnlyTestPattern.source, 'docker|bwrap|unshare|landlock|hard-math|delivery-pipeline|npm exec|\\/var\\/tmp|npm_config_cache|worktreeRoot');
  for (const word of ['postgres', 'withDatabase', 'playwright', 'chromium']) {
    assert.equal(remoteableTestFile(`import { ${word} } from "./helper.js";\n`), true, `${word} is remoteable`);
  }
  assert.equal(remoteableTestFile('import { docker } from "docker";\n'), false, 'docker stays local');
  for (const word of ['bwrap', 'unshare', 'landlock', 'hard-math', 'npm_config_cache', 'worktreeRoot']) {
    assert.equal(remoteableTestFile(`// needs ${word}\n`), false, `${word} stays local`);
  }

  const contents: Record<string, string> = {
    'tests/db.test.ts': 'const store = await withDatabase("db");\n',
    'tests/pw.test.ts': 'import { chromium } from "playwright";\n',
    'browser-tests/dashboard.spec.ts': 'import { test } from "@playwright/test";\n',
    'tests/uses-docker.test.ts': 'import { docker } from "docker";\n',
  };
  const files = Object.keys(contents);
  const withBrowser = await splitLocalOnlyTests(files, async file => contents[file]!);
  assert.deepEqual(withBrowser, {
    remoteable: ['tests/db.test.ts', 'tests/pw.test.ts', 'browser-tests/dashboard.spec.ts'],
    localOnly: ['tests/uses-docker.test.ts'],
  });

  const withoutBrowser = await splitLocalOnlyTests(files, async file => contents[file]!, { remoteBrowser: false });
  assert.deepEqual(withoutBrowser, {
    remoteable: ['tests/db.test.ts'],
    localOnly: ['tests/pw.test.ts', 'browser-tests/dashboard.spec.ts', 'tests/uses-docker.test.ts'],
    browserLocalOnly: true,
  });
});

test('unit:only-docker-tests-stay-on-the-coordinator — when the trial image lacks a browser, browser tests stay local and the reason is recorded once', { timeout: 300_000 }, async () => {
  const image = 'mainworks-trial:no-browser-fixture';
  const hosts = await shardHosts('no-browser-trial', ['box'], { [image]: `sha256:${'3612'.repeat(16)}` });
  const browserFiles = ['tests/browser-a.test.ts', 'tests/browser-b.test.ts'];
  const plainFiles = ['tests/plain-a.test.ts', 'tests/plain-b.test.ts'];
  const files = [...browserFiles, ...plainFiles];
  const answers = join(hosts.root, 'answers.jsonl');
  const { root, sha } = await shardRepository('no-browser-repo', [], {
    'scripts/tests.mjs': `import { readFileSync, appendFileSync } from 'node:fs';
const at = name => process.argv[process.argv.indexOf(name) + 1];
const remote = process.cwd().includes('/.graphyard/runs/');
for (const file of readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean)) {
  appendFileSync(${JSON.stringify(answers)}, JSON.stringify({ file, remote }) + '\\n');
  appendFileSync(at('--durations'), JSON.stringify({ file, passed: true, durationMs: 1 }) + '\\n');
}
`,
    'tests/browser-a.test.ts': 'import { chromium } from "playwright";\n',
    'tests/browser-b.test.ts': 'test("launches chromium", () => {});\n',
    'tests/plain-a.test.ts': 'test("adds", () => {});\n',
    'tests/plain-b.test.ts': 'test("subtracts", () => {});\n',
  });
  const run = (hasBrowser: boolean): ChildRun => async (command, args, options) => {
    if (command === 'npm') return '';
    if (command === 'node' && args[0] === 'scripts/select.mjs') return files.join('\n');
    if (command === 'node' && args[0] === 'scripts/tests.mjs') return defaultChildRun(command, args, { ...options, wrapper: undefined });
    if (command === 'docker' && args[0] === 'image' && args[1] === 'inspect' && args.includes('{{range .Config.Env}}{{println .}}{{end}}')) {
      return hasBrowser ? 'PATH=/usr/local/bin:/usr/bin:/bin\nPLAYWRIGHT_BROWSERS_PATH=/opt/graphyard-browsers\n' : 'PATH=/usr/local/bin:/usr/bin:/bin\n';
    }
    return defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
  };
  const reading = (name: string, cores: number, busy: number): HostReading => ({ name, cores, busy, steal: 0, celsius: 60, limit: 92, away: false });
  const previous = process.env.GRAPHYARD_TRIAL_IMAGE;
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
  try {
    const withoutBrowser = await runTrial({
      root, base: await temporaryDirectory('no-browser-base'), mergeSha: sha, changedFiles: files, timeoutMs: 240_000, cores: 2, run: run(false), retries: 0,
      remote: { hosts: ['gy-compute@box'], read: async () => [reading('vishrog', 2, 2), reading('gy-compute@box', 8, 0)] },
    });
    assert.equal(withoutBrowser.build, 'pass', withoutBrowser.logTail);
    assert.deepEqual({ passed: withoutBrowser.tests.passed, failed: withoutBrowser.tests.failed }, { passed: files.length, failed: [] }, withoutBrowser.logTail);
    const lines = (await readFile(answers, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { file: string; remote: boolean });
    assert.ok(lines.filter(line => browserFiles.includes(line.file)).every(line => !line.remote), `browser files stayed local: ${JSON.stringify(lines)}`);
    assert.ok(lines.filter(line => plainFiles.includes(line.file)).every(line => line.remote), `plain files ran remotely: ${JSON.stringify(lines)}`);
    const reasonLines = withoutBrowser.logTail.split('\n').filter(line => /browser tests stay on this machine/i.test(line));
    assert.equal(reasonLines.length, 1, `reason recorded once in trial log: ${withoutBrowser.logTail}`);

    const withBrowser = await runTrial({
      root, base: await temporaryDirectory('with-browser-base'), mergeSha: sha, changedFiles: files, timeoutMs: 240_000, cores: 2, run: run(true), retries: 0,
      remote: { hosts: ['gy-compute@box'], read: async () => [reading('vishrog', 2, 2), reading('gy-compute@box', 8, 0)] },
    });
    assert.equal(withBrowser.build, 'pass', withBrowser.logTail);
    const afterLines = (await readFile(answers, 'utf8')).split('\n').filter(Boolean).slice(lines.length).map(line => JSON.parse(line) as { file: string; remote: boolean });
    assert.ok(afterLines.filter(line => browserFiles.includes(line.file)).every(line => line.remote), `browser files ran remotely when image ships browser: ${JSON.stringify(afterLines)}`);
  } finally { if (previous === undefined) delete process.env.GRAPHYARD_TRIAL_IMAGE; else process.env.GRAPHYARD_TRIAL_IMAGE = previous; }
});
