import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withDatabase } from '../tests/helpers/postgres';
import { temporaryDirectory } from '../tests/helpers/temp-dirs';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { save } from '../src/store/store';
import { lockedWork } from '../src/store/locked-read';
import { gitRunnerFor } from '../src/merge-writer/local-observation';
import { loopPresenceHeader } from '../src/model/loop-presence';
import { proposedRuntimes } from '../src/model/registry';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy';
import { friendlyName } from '../web/fun';

// e2e:first-run-start-task — GY-3709: first-run steps 3 and 4. A fresh install with its repository
// and Builder connected lists up to three small open issues and a free-text box; starting the seeded
// issue files one released task with an E2E-proof criterion drafted from it; step 4 shows its
// pipeline and the stub Builder's live session; when it merges the shipped toast names how long it
// took and the install opens on Home.

const adminToken = 'test-human-operator';
const workerToken = 'test-stub-builder';
const coordinatorToken = 'test-coordinator';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

const long = (words: number) => Array.from({ length: words }, (_, n) => `word${n}`).join(' ');
// The loop reads these with `gh issue list`; #7 is labelled small, #3 and #5 have the shortest bodies.
const issues = [
  { number: 1, title: 'Rewrite the billing engine', body: long(400), labels: ['epic'], url: 'https://github.com/fixture/first-run/issues/1' },
  { number: 3, title: 'Fix the typo on the About page', body: 'It says "teh".', labels: [], url: 'https://github.com/fixture/first-run/issues/3' },
  { number: 5, title: 'Make the footer link open in a new tab', body: 'The footer link to docs replaces the app.', labels: [], url: 'https://github.com/fixture/first-run/issues/5' },
  { number: 7, title: 'Show the version number in the footer', body: long(80), labels: ['small'], url: 'https://github.com/fixture/first-run/issues/7' },
  { number: 9, title: 'Add dark mode', body: long(120), labels: ['enhancement'], url: 'https://github.com/fixture/first-run/issues/9' },
];

test('e2e:first-run-start-task — step 3 starts the first task from a small issue; step 4 watches it merge, then Home opens', async ({ page }) => {
  test.setTimeout(180_000);
  const policy = repositoryPolicy();
  setRepositoryPolicy({ ...policy, e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
  const store = await withDatabase(`first_run_start_${randomUUID().slice(0, 8)}`);
  await store.init();
  const repoDir = await temporaryDirectory('first-run-start-git');
  git(repoDir, 'init', '-q', '-b', 'main');
  git(repoDir, 'config', 'user.name', 'Stub Builder');
  git(repoDir, 'config', 'user.email', 'builder@example.test');
  writeFileSync(join(repoDir, 'README.md'), '# First-run fixture\n');
  git(repoDir, 'add', 'README.md');
  git(repoDir, 'commit', '-q', '-m', 'Initial commit');
  const baseTip = git(repoDir, 'rev-parse', 'HEAD');
  git(repoDir, 'update-ref', 'refs/remotes/origin/main', baseTip);

  const engine = new Engine(store, 120, 'fixture/first-run');
  engine.gitRunner = gitRunnerFor(repoDir);
  engine.baseBranch = 'main';
  const http = server(engine, [
    { id: 'operator', displayName: 'Avery', role: 'admin', sessionKind: 'human', token: adminToken },
    { id: 'builder-stub', role: 'worker', sessionKind: 'ai', token: workerToken },
    { id: 'loop', role: 'coordinator', sessionKind: 'ai', token: coordinatorToken },
  ]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;

  try {
    await page.route('**/api/**', async route => {
      const { pathname, search } = new URL(route.request().url());
      const response = await route.fetch({ url: url + pathname + search }).catch(() => null);
      await (response ? route.fulfill({ response }) : route.abort()).catch(() => {});
    });
    const api = async (path: string, token: string, data?: unknown, extraHeaders: Record<string, string> = {}) => {
      const response = await fetch(`${url}/api/${path}`, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...extraHeaders },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const body = await response.json();
      expect(response.status, `${path}: ${JSON.stringify(body)}`).toBe(200);
      return body;
    };

    // Steps 1 and 2 done: the loop reads the repository without refusal, and the stub Builder answers on its registered model.
    await api('work-snapshot', coordinatorToken, undefined, { [loopPresenceHeader]: '5' });
    await api('agent-registry/apply', adminToken, {
      runtimes: [proposedRuntimes.find(r => r.name === 'claude')!],
      models: [{ name: 'opus', id: 'claude-opus-5-5' }],
      accounts: [{ name: 'builder-stub', runtime: 'claude', model: 'opus', credential: { host: 'build-host', home: '/home/operator/.coding_agents/builder-stub' } }],
      roles: [{ name: 'worker', accounts: ['builder-stub'], concurrency: 1 }],
      reason: 'Seed stub Builder for first-run E2E',
    });
    await api('agent-registry/observe', coordinatorToken, {
      host: 'build-host',
      observations: [{ account: 'builder-stub', quota: { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null, since: new Date().toISOString() }, smoke: { result: 'pass', reason: null } }],
    });
    // The loop reports the repository's open issues.
    await api('first-run/issues', coordinatorToken, { issues });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/?sign-in');
    await page.getByLabel('Access token').fill(adminToken);
    await page.getByRole('button', { name: 'Open control plane' }).click();

    // Step 3: the small-labelled issue, then the two shortest bodies; three in all, and a free-text box.
    await expect(page.getByRole('heading', { name: 'Ship one small change', level: 1 })).toBeVisible({ timeout: 15_000 });
    const listed = page.getByRole('list', { name: 'Small issues' }).locator('> li');
    await expect(listed).toHaveCount(3);
    await expect(listed.nth(0)).toContainText('Show the version number in the footer');
    await expect(listed.nth(1)).toContainText('Fix the typo on the About page');
    await expect(listed.nth(2)).toContainText('Make the footer link open in a new tab');
    await expect(page.getByLabel('Or describe a change')).toBeVisible();
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `step 3 at ${width}px`).toBe(true);
    }

    // Starting the seeded issue creates one task with an E2E-proof criterion drafted from it, released for the Builder.
    await listed.nth(0).getByRole('button', { name: 'Start' }).click();
    await expect(page.getByRole('heading', { name: 'Watch it merge', level: 1 })).toBeVisible({ timeout: 15_000 });
    const filed = await store.list();
    expect(filed).toHaveLength(1);
    const task = filed[0]!;
    expect(task.title).toBe('Show the version number in the footer');
    expect(task.description).toContain(issues[3]!.url);
    expect(task.criteria).toHaveLength(1);
    expect(task.criteria[0]!.proofs.some(proof => proof.startsWith('e2e:'))).toBe(true);
    expect(task.ready).toBe(true);

    // The Builder is dispatched: the stub Builder claims it, as the loop's dispatch does, and its session runs.
    const claimed = await api(`work/${task.id}/claim`, workerToken, {});
    const branch = `graphyard/${task.key.toLowerCase()}-1`;
    await api(`work/${task.id}/workspace`, workerToken, { epoch: claimed.epoch, host: 'build-host', path: `/tmp/${task.key}`, branch });
    await api(`work/${task.id}/session`, workerToken, { id: `builder-stub:${claimed.epoch}`, kind: 'implementation', epoch: claimed.epoch, runtime: 'claude', host: 'build-host', transcript: `run:${randomUUID()}`, subject: task.key, state: 'running' });

    // Step 4: that task's pipeline and the Builder's live session.
    const builderName = friendlyName('builder-stub') ?? 'builder-stub';
    const body = page.locator('.first-run-body');
    await expect(body.locator('.steps-bar')).toBeVisible();
    await expect(body).toContainText(`${builderName}'s session on build-host`, { timeout: 15_000 });
    await expect(body.getByRole('button', { name: 'Open the task' })).toBeVisible();

    // The stub Builder completes it and it merges, as the merge writer records a delivery.
    git(repoDir, 'checkout', '-q', '-b', branch);
    writeFileSync(join(repoDir, 'footer.txt'), 'v1.0.0\n');
    git(repoDir, 'add', 'footer.txt');
    git(repoDir, 'commit', '-q', '-m', 'Show the version');
    const head = git(repoDir, 'rev-parse', 'HEAD');
    await api(`work/${task.id}/submit`, workerToken, { epoch: claimed.epoch, head });
    await store.transaction(async (db, now) => {
      const work = (await lockedWork(db, [task.id]))[0]!;
      work.stage = 'done';
      work.lease = null;
      work.delivery = { mergedAt: now.toISOString(), mergeSha: 'c'.repeat(40), authorizationRevision: work.policyRevision };
      await save(db, work, 'loop', 'merge-writer.reconciled', now);
    });

    // The shipped toast says how long it took from start to merge, and the install opens on Home.
    await expect(page.locator(`[data-toast="${task.key}"]`)).toContainText(/shipped “Show the version number in the footer” in \S+/, { timeout: 20_000 });
    await expect(page.getByRole('list', { name: 'Steps' })).toHaveCount(0);
    await expect(page.locator('.first-run')).toHaveCount(0);
  } finally {
    setRepositoryPolicy(policy);
    await page.unrouteAll().catch(() => {});
    await new Promise<void>(resolve => http.close(() => resolve()));
    await store.close();
    rmSync(repoDir, { recursive: true, force: true });
  }
});
