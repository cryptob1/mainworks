import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withDatabase } from '../tests/helpers/postgres';
import { temporaryDirectory } from '../tests/helpers/temp-dirs';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { gitRunnerFor } from '../src/merge-writer/local-observation';
import { loopFetchRefusalHeader, loopPresenceHeader } from '../src/model/loop-presence';
import { proposedRuntimes } from '../src/model/registry';
import { friendlyName } from '../web/fun';

// e2e:first-run — GY-3603: first run takes a new person from connecting a repository to a first merged PR in four steps.

const adminToken = 'test-human-operator';
const workerToken = 'test-stub-builder';
const coordinatorToken = 'test-coordinator';

const seededIssues = [
  { number: 88, title: 'README install command is missing the port flag', body: 'Add --port to the README snippet.', labels: [{ name: 'small' }], state: 'open', html_url: 'https://github.com/fixture/first-run/issues/88' },
  { number: 91, title: 'Dates on the Shipped page ignore the browser time zone', body: 'Format dates in local time.', labels: [{ name: 'small' }], state: 'open', html_url: 'https://github.com/fixture/first-run/issues/91' },
  { number: 94, title: 'Typo in the sign-in error message', body: 'Fix spelling.', labels: [{ name: 'small' }], state: 'open', html_url: 'https://github.com/fixture/first-run/issues/94' },
  { number: 99, title: 'Rewrite the whole scheduler', body: 'A very long body describing a large multi-week architectural rewrite that is not small.', labels: [{ name: 'large' }], state: 'open', html_url: 'https://github.com/fixture/first-run/issues/99' },
  { number: 100, title: 'Open pull request should not appear as an issue', body: 'Short', labels: [{ name: 'small' }], state: 'open', pull_request: { url: 'https://github.com/fixture/first-run/pull/100' } },
];

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

test('e2e:first-run — walks a fresh install through steps 1 to 4 to a first merged PR, shipped toast, and Home', async ({ page }) => {
  test.setTimeout(120_000);
  const store = await withDatabase(`first_run_${randomUUID().slice(0, 8)}`);
  await store.init();
  const repoDir = await temporaryDirectory('first-run-git');
  git(repoDir, 'init', '-b', 'main');
  git(repoDir, 'config', 'user.name', 'Stub Builder');
  git(repoDir, 'config', 'user.email', 'builder@example.test');
  writeFileSync(join(repoDir, 'README.md'), '# First-run fixture\nRun `mainworks up`.\n');
  git(repoDir, 'add', 'README.md');
  git(repoDir, 'commit', '-m', 'Initial commit');
  const baseTip = git(repoDir, 'rev-parse', 'HEAD');
  git(repoDir, 'update-ref', 'refs/remotes/origin/main', baseTip);

  const engine = new Engine(store, 120, 'fixture/first-run');
  engine.gitRunner = gitRunnerFor(repoDir);

  const runId = randomUUID();
  const http = server(engine, [
    { id: 'operator', displayName: 'Avery', role: 'admin', sessionKind: 'human', token: adminToken },
    { id: 'builder-stub', role: 'worker', sessionKind: 'ai', token: workerToken },
    { id: 'loop', role: 'coordinator', sessionKind: 'ai', token: coordinatorToken },
  ], { listOpenIssues: async () => seededIssues });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;

  // Connect the real host-supervisor bridge (/api/terminal-host) so /api/work/:id/runs/:runId/log
  // serves the stub Builder's live session log end-to-end with no browser route mocking.
  const hostBridge = new WebSocket(`ws://127.0.0.1:${port}/api/terminal-host`, ['graphyard', coordinatorToken]);
  await new Promise<void>((resolve, reject) => {
    hostBridge.addEventListener('open', () => resolve(), { once: true });
    hostBridge.addEventListener('error', reject, { once: true });
  });
  hostBridge.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.type === 'log' && message.run === runId) {
      hostBridge.send(JSON.stringify({
        id: message.id,
        answer: {
          run: { account: 'builder-stub', kind: 'implementation' },
          lines: [
            { at: new Date().toISOString(), stream: 'stdout', text: 'Branching from main and writing the E2E test for #88...' },
            { at: new Date().toISOString(), stream: 'stdout', text: 'Tests passed. Submitting head to the control plane.' },
          ],
          cursor: 2,
          ended: false,
        },
      }));
    }
  });

  try {
    // Forward the built dashboard's /api/** requests straight to this test's real control plane without altering any response.
    await page.route('**/api/**', async route => {
      try {
        const reqUrl = new URL(route.request().url());
        const response = await route.fetch({ url: url + reqUrl.pathname + reqUrl.search });
        return await route.fulfill({ response });
      } catch {
        await route.abort().catch(() => {});
      }
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

    // Report a real repository fetch refusal through the coordinator's status poll so Step 1 starts genuinely not done.
    const fetchError = 'Deploy key for fixture/first-run was rejected by GitHub.';
    await api('work-snapshot', coordinatorToken, undefined, {
      [loopPresenceHeader]: '5',
      [loopFetchRefusalHeader]: fetchError,
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/?sign-in#home');
    await page.getByLabel('Access token').fill(adminToken);
    await page.getByRole('button', { name: 'Open control plane' }).click();
    await expect(page.locator('header.main-top-bar')).toBeVisible({ timeout: 15_000 });

    // AC-1: An install with no merged work opens on the first-run page instead of an empty Home,
    // showing four steps with the current one marked.
    const stepsList = page.getByRole('list', { name: 'Steps' });
    await expect(stepsList).toBeVisible();
    const stepItems = stepsList.locator('> li');
    await expect(stepItems).toHaveCount(4);

    // Step 1 is current, steps 2-4 are pending, the real refusal is shown, and its true terminal equivalent is stated.
    await expect(stepItems.nth(0)).toHaveAttribute('aria-current', 'step');
    await expect(stepItems.nth(0)).toHaveAttribute('data-step-state', 'current');
    await expect(stepItems.nth(1)).toHaveAttribute('data-step-state', 'pending');
    await expect(stepItems.nth(2)).toHaveAttribute('data-step-state', 'pending');
    await expect(stepItems.nth(3)).toHaveAttribute('data-step-state', 'pending');
    await expect(page.getByRole('alert')).toContainText(fetchError);
    await expect(page.locator('[data-terminal-equivalent]')).toContainText('mainworks up --repo fixture/first-run');
    await expect(page.locator('[data-terminal-equivalent]')).not.toContainText('npx mainworks');

    // Repository connection succeeds -> coordinator poll clears fetchRefusal -> Step 1 ticks with repository name, Step 2 becomes current.
    await api('work-snapshot', coordinatorToken, undefined, { [loopPresenceHeader]: '5' });
    await page.getByRole('button', { name: 'Check connection' }).click();
    await expect(stepItems.nth(0)).toHaveAttribute('data-step-state', 'done');
    await expect(stepItems.nth(0)).toContainText('✓');
    await expect(stepItems.nth(0)).toContainText('fixture/first-run');
    await expect(stepItems.nth(1)).toHaveAttribute('aria-current', 'step');
    await expect(stepItems.nth(1)).toHaveAttribute('data-step-state', 'current');
    await expect(page.locator('[data-terminal-equivalent]')).toContainText('mainworks master registry propose --apply');

    // Register a stub Builder account with a concrete registered model id.
    const modelId = 'claude-opus-5-5';
    const builderFriendly = friendlyName('builder-stub') ?? 'builder-stub';
    await api('agent-registry/apply', adminToken, {
      runtimes: [proposedRuntimes.find(r => r.name === 'claude')!],
      models: [{ name: 'opus', id: modelId }],
      accounts: [{ name: 'builder-stub', runtime: 'claude', model: 'opus', credential: { host: 'build-host', home: '/home/operator/.coding_agents/builder-stub' } }],
      roles: [{ name: 'worker', accounts: ['builder-stub'], concurrency: 1 }],
      reason: 'Seed stub Builder for first-run E2E',
    });

    // AC-1: Step 2 does NOT pass when the live request fails; it says the provider's sentence.
    await api('agent-registry/observe', coordinatorToken, {
      host: 'build-host',
      observations: [{
        account: 'builder-stub',
        quota: { loggedIn: true, state: 'broken', usage: [], resetsAt: null, reason: 'Your Anthropic API key was rejected.' },
        smoke: { result: 'fail', reason: 'Your Anthropic API key was rejected.' },
      }],
    });
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await expect(stepItems.nth(1)).toHaveAttribute('data-step-state', 'current');
    await expect(page.getByRole('alert')).toContainText('Your Anthropic API key was rejected.');
    await expect(page.locator('main')).toContainText(modelId);

    // AC-1: Step 2 passes once a live request answers on the registered model, and ticks with Builder name and model id.
    await api('agent-registry/observe', coordinatorToken, {
      host: 'build-host',
      observations: [{
        account: 'builder-stub',
        quota: { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null, since: new Date().toISOString() },
        smoke: { result: 'pass', reason: null },
      }],
    });
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await expect(stepItems.nth(1)).toHaveAttribute('data-step-state', 'done');
    await expect(stepItems.nth(1)).toContainText('✓');
    await expect(stepItems.nth(1)).toContainText(builderFriendly);
    await expect(stepItems.nth(1)).toContainText(modelId);

    // AC-2: Step 3 lists up to three small open issues and a free-text box.
    await expect(stepItems.nth(2)).toHaveAttribute('aria-current', 'step');
    await expect(stepItems.nth(2)).toHaveAttribute('data-step-state', 'current');
    await expect(page.locator('[data-terminal-equivalent]')).toContainText('mainworks create task.json');
    await expect(page.locator('[data-terminal-equivalent]')).toContainText('mainworks ready');
    await expect(page.getByRole('radio')).toHaveCount(3);
    await expect(page.locator('main')).toContainText('#88');
    await expect(page.locator('main')).toContainText('#91');
    await expect(page.locator('main')).toContainText('#94');
    await expect(page.locator('main')).not.toContainText('#99');
    await expect(page.locator('main')).not.toContainText('#100');
    await expect(page.getByLabel('Or describe your own')).toBeVisible();

    // Select issue #88 and start the Builder on it.
    await page.getByRole('radio', { name: /#88/ }).check();
    await page.getByRole('button', { name: new RegExp(`Start ${builderFriendly} on #88`) }).click();

    // Step 4 becomes current and shows the created task's pipeline and live session.
    await expect(stepItems.nth(2)).toHaveAttribute('data-step-state', 'done');
    await expect(stepItems.nth(3)).toHaveAttribute('aria-current', 'step');
    await expect(stepItems.nth(3)).toHaveAttribute('data-step-state', 'current');

    // Verify the created task in the control plane has an e2e: proof criterion and is ready (dispatched).
    const snapshot = await api('work-snapshot', adminToken);
    expect(snapshot.work).toHaveLength(1);
    const created = snapshot.work[0];
    expect(created.ready).toBe(true);
    expect(created.criteria.length).toBeGreaterThanOrEqual(1);
    expect(created.criteria.some((ac: { proofs: string[] }) => ac.proofs.some(p => p.startsWith('e2e:')))).toBe(true);
    await expect(page.locator('[data-terminal-equivalent]')).toContainText(`mainworks status ${created.key}`);

    // Stub Builder claims the task, registers its workspace, and records a live implementation session.
    const branch = `graphyard/${created.key.toLowerCase()}-1`;
    await api(`work/${created.id}/claim`, workerToken, {});
    await api(`work/${created.id}/workspace`, workerToken, { epoch: 1, host: 'build-host', path: repoDir, branch });
    await api(`work/${created.id}/session`, workerToken, {
      id: 'builder-stub:1',
      kind: 'implementation',
      runtime: 'claude',
      host: 'build-host',
      state: 'running',
      subject: created.title,
      transcript: `run:${runId}`,
      epoch: 1,
    });

    // Step 4 shows both the pipeline and the Builder's live session output streamed through /api/terminal-host.
    await expect(page.getByRole('region', { name: 'Pipeline' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('tabpanel', { name: 'Live session' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('tabpanel', { name: 'Live session' })).toContainText('Branching from main and writing the E2E test for #88', { timeout: 15_000 });

    // Responsive check: no horizontal scroll at 1280 and 390 px.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await noSideScroll(page), `first-run at ${width}px must not scroll horizontally`).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // Stub Builder commits the fix on its branch and submits its head through the real /submit route.
    git(repoDir, 'checkout', '-b', branch);
    writeFileSync(join(repoDir, 'README.md'), '# First-run fixture\nRun `mainworks up --port 4310`.\n');
    git(repoDir, 'add', 'README.md');
    git(repoDir, 'commit', '-m', 'Add --port flag to README install command');
    const headSha = git(repoDir, 'rev-parse', 'HEAD');
    await api(`work/${created.id}/submit`, workerToken, { epoch: 1, head: headSha });

    // Independent product review approves the submitted head before the merge writer delivers it.
    await api(`work/${created.id}/product-review`, coordinatorToken, {
      sha: headSha, baseSha: baseTip, verdict: 'approved', reviewer: 'review-stub', findings: 'Verified #88 fix end to end.',
    });

    // Merge writer merges the branch onto main and delivers through the real /merge-record ledger.
    git(repoDir, 'checkout', 'main');
    git(repoDir, 'merge', '--no-ff', '-m', `Merge ${created.key}`, branch);
    const mergeSha = git(repoDir, 'rev-parse', 'HEAD');
    git(repoDir, 'update-ref', 'refs/remotes/origin/main', mergeSha);

    const pushedAt = new Date(Date.now() + 3 * 60_000).toISOString();
    await api(`work/${created.id}/merge-record`, coordinatorToken, {
      kind: 'intent', head: headSha, baseTip, mergeSha, risk: 'normal', at: new Date().toISOString(),
    });
    await api(`work/${created.id}/merge-record`, coordinatorToken, {
      kind: 'trial', head: headSha, baseTip, mergeSha, outcome: 'verdict', build: 'pass',
      tests: { passed: 1, failed: [], files: 1 }, files: ['README.md'],
      proofs: { 'e2e:issue-88': { executed: 1, failed: 0 } }, durationMs: 5, attempts: [],
    });
    await api(`work/${created.id}/merge-record`, coordinatorToken, {
      kind: 'pushed', mergeSha, pushedAt,
    });
    await api(`work/${created.id}/merge-record`, coordinatorToken, {
      kind: 'reconciled', mergeSha, observedTip: mergeSha,
    });

    // AC-2: Shipped toast appears with Builder name and time from start to merge, and the install switches to Home.
    const toast = page.locator(`[data-toast="${created.key}"]`);
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(toast).toContainText(builderFriendly);
    await expect(toast).toContainText(created.title);
    await expect(toast).toContainText(/in \d+ min/);
    await expect(page.getByRole('heading', { name: 'Home', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('list', { name: 'Steps' })).toHaveCount(0);

    // Reloading #home now opens Home directly.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Home', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
  } finally {
    hostBridge.close();
    await page.unrouteAll().catch(() => {});
    await new Promise<void>(resolve => http.close(() => resolve()));
    await store.close();
    rmSync(repoDir, { recursive: true, force: true });
  }
});
