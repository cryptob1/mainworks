import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { completeCommand } from '../src/cli/complete.js';
import type { CliContext } from '../src/cli/context.js';
import { Engine } from '../src/engine.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import type { Principal } from '../src/model.js';
import { server } from '../src/server.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3892: complete runs the fast static rule test files (GY-3826) on the head before submitting
// and refuses with the failing file and its first failing line when one fails.

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const launcher = fileURLToPath(new URL('../bin/mainworks.mjs', import.meta.url));
const oldNameWord = `${'graph'}${'yard'}`;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

async function seedStaticRuleRepo(label: string) {
  const root = await temporaryDirectory(label);
  const noOldNameTest = await readFile(join(repoRoot, 'tests/no-old-name.test.ts'), 'utf8');
  git(root, 'init', '--quiet', '-b', 'main');
  await writeFiles(root, {
    '.gitignore': `.${oldNameWord}/\n`,
    'package.json': '{"type":"module"}\n',
    'tests/old-names.txt': `\\.${oldNameWord}\\b\npath tests/no-old-name.test.ts\n`,
    'tests/no-old-name.test.ts': noOldNameTest,
    'tests/architecture.test.ts': "import { test } from 'node:test';\ntest('unit:architecture — ok', () => {});\n",
  });
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'base');
  const baseSha = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/main', baseSha);
  return { root, baseSha };
}

function stubContext(root: string, head: string) {
  const calls: { path: string; body: unknown }[] = [];
  const context = {
    args: ['1', '--head', head],
    repositoryRoot: () => root,
    print: () => {},
    api: async (path: string, body: unknown) => {
      if (path !== 'owner') calls.push({ path, body });
      return { submitted: true };
    },
  } as unknown as CliContext;
  return { context, calls };
}

test('integration:complete-runs-static-rules — complete refuses a head adding an old-name line with the failing file and first failing line under 30s, and submits a clean head', async () => {
  const { root } = await seedStaticRuleRepo('complete-runs-static-rules');
  git(root, 'checkout', '--quiet', '-b', 'mainworks/gy-1-1');

  // Seed a head that adds an unallowlisted old-name line.
  const badLine = `export const label = 'legacy ${oldNameWord} banner';`;
  await writeFiles(root, {
    'src/added.ts': `${badLine}\n`,
    'tests/proof.test.ts': "import { test } from 'node:test';\ntest('integration:complete-runs-static-rules — works', () => {});\n",
  });
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'add old-name line');
  const badHead = git(root, 'rev-parse', 'HEAD');

  const work = {
    id: 'id-1',
    key: 'GY-1',
    type: 'chore',
    criteria: [{ id: 'AC-1', text: 'Runs static rules', proofs: ['integration:complete-runs-static-rules'] }],
  };

  {
    const { context, calls } = stubContext(root, badHead);
    const started = performance.now();
    await assert.rejects(
      completeCommand.run(context, work as never),
      (error: Error) => {
        assert.ok(error.message.includes('tests/no-old-name.test.ts'), `refusal must name failing static rule file: ${error.message}`);
        assert.ok(error.message.includes('src/added.ts:1:'), `refusal must include first failing line: ${error.message}`);
        return true;
      },
    );
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 30_000, `static rule refusal took ${Math.round(elapsedMs)}ms, expected < 30000ms`);
    assert.equal(calls.length, 0, 'no submission recorded when static rules fail');
  }

  // Clean head removes the old-name line and submits.
  await writeFiles(root, {
    'src/added.ts': "export const label = 'Mainworks banner';\n",
  });
  git(root, 'add', 'src/added.ts');
  git(root, 'commit', '--quiet', '-m', 'use Mainworks name');
  const cleanHead = git(root, 'rev-parse', 'HEAD');

  {
    const { context, calls } = stubContext(root, cleanHead);
    const started = performance.now();
    await completeCommand.run(context, work as never);
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 30_000, `clean static rule run took ${Math.round(elapsedMs)}ms, expected < 30000ms`);
    assert.deepEqual(calls, [{ path: 'work/id-1/submit', body: { epoch: 1, head: cleanHead } }]);
  }
});

test('e2e:complete-runs-static-rules — on a running test install a worker completing a head with an old-name line is refused at complete, before any trial', async () => {
  const { root } = await seedStaticRuleRepo('complete-runs-static-rules-e2e');
  const store = await withDatabase('complete-runs-static-rules-e2e');
  await store.init();
  const operator: Principal = { id: 'operator', role: 'admin' };
  const worker: Principal = { id: 'worker-1', role: 'worker' };
  const adminToken = `e2e-admin-${'a'.repeat(32)}`;
  const workerToken = `e2e-worker-${'w'.repeat(32)}`;
  const engine = new Engine(store, 120, 'owner/mainworks-e2e');
  engine.gitRunner = gitRunnerFor(root);
  engine.baseBranch = 'main';
  const http: Server = server(engine, [
    { ...operator, token: adminToken },
    { ...worker, token: workerToken },
  ]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;

  try {
    let item = await engine.execute(operator, 'create', null, {
      type: 'chore',
      title: 'Static rule check at complete',
      criteria: [{ id: 'AC-1', text: 'Passes', proofs: ['unit:static-e2e', 'e2e:fixture'] }],
    }, randomUUID());
    item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
    item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());

    const branch = `${oldNameWord}/${item.key.toLowerCase()}-1`;
    git(root, 'checkout', '--quiet', '-b', branch);
    await writeFiles(root, {
      'src/legacy.ts': `export const heading = 'Welcome to ${oldNameWord}';\n`,
      'tests/proof.test.ts': "import { test } from 'node:test';\ntest('unit:static-e2e — works', () => {});\n",
    });
    git(root, 'add', '-A');
    git(root, 'commit', '--quiet', '-m', 'introduce old name');
    const badHead = git(root, 'rev-parse', 'HEAD');
    await engine.execute(worker, 'workspace', item.id, { epoch: item.epoch, host: 'test-host', path: root, branch }, randomUUID());

    const runComplete = async (head: string) => {
      const env: NodeJS.ProcessEnv = { ...process.env, MAINWORKS_URL: url, MAINWORKS_TOKEN: workerToken };
      delete env.MAINWORKS_TOKEN_FILE;
      delete env.MAINWORKS_REQUEST_ID;
      delete env[`${oldNameWord.toUpperCase()}_URL`];
      delete env[`${oldNameWord.toUpperCase()}_TOKEN`];
      delete env[`${oldNameWord.toUpperCase()}_TOKEN_FILE`];
      delete env[`${oldNameWord.toUpperCase()}_REQUEST_ID`];
      try {
        const out = await exec(process.execPath, [launcher, 'complete', item.key, String(item.epoch), '--head', head], { cwd: root, env, timeout: 30_000 });
        return { ok: true as const, stdout: out.stdout, stderr: out.stderr };
      } catch (error: any) {
        return { ok: false as const, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
      }
    };

    const refused = await runComplete(badHead);
    assert.equal(refused.ok, false, 'complete must refuse a head with an old-name line');
    const combined = `${refused.stdout}\n${refused.stderr}`;
    assert.ok(combined.includes('tests/no-old-name.test.ts'), `refusal names failing file: ${combined}`);
    assert.ok(combined.includes('src/legacy.ts:1:'), `refusal names first failing line: ${combined}`);

    const afterRefusal = (await store.workDocument(item.id))!;
    assert.equal(afterRefusal.stage, 'build', 'item remains in build after refusal');
    assert.equal(afterRefusal.submission, null, 'no submission recorded');
    const { rows: trialRows } = await store.pool.query(
      "SELECT COUNT(*)::int AS count FROM events WHERE work_id = $1 AND kind = 'merge.trial'",
      [item.id],
    );
    assert.equal(trialRows[0]!.count, 0, 'refused before any merge trial');

    // Fix the old-name line and confirm complete now submits.
    await writeFiles(root, { 'src/legacy.ts': "export const heading = 'Welcome to Mainworks';\n" });
    git(root, 'add', 'src/legacy.ts');
    git(root, 'commit', '--quiet', '-m', 'fix old name');
    const cleanHead = git(root, 'rev-parse', 'HEAD');

    const accepted = await runComplete(cleanHead);
    assert.equal(accepted.ok, true, `complete should accept clean head: ${accepted.ok ? '' : accepted.stderr}`);
    const afterAccept = (await store.workDocument(item.id))!;
    assert.notEqual(afterAccept.stage, 'build', 'clean head leaves build stage');
    assert.equal(afterAccept.submission?.epoch, item.epoch, 'clean head submission recorded for epoch');
  } finally {
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
    await store.close();
  }
});
