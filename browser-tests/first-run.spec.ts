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

// e2e:first-run — GY-3603: a fresh install opens on the four-step first-run page; steps 1 to 3 show their state and the model id.

const adminToken = 'test-human-operator';
const workerToken = 'test-stub-builder';
const coordinatorToken = 'test-coordinator';

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

test('e2e:first-run — a fresh install opens on the first-run page and walks steps 1 to 3 with a stub Builder account', async ({ page }) => {
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

  const http = server(engine, [
    { id: 'operator', displayName: 'Avery', role: 'admin', sessionKind: 'human', token: adminToken },
    { id: 'builder-stub', role: 'worker', sessionKind: 'ai', token: workerToken },
    { id: 'loop', role: 'coordinator', sessionKind: 'ai', token: coordinatorToken },
  ]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;

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
    // The install's own address, with no page named: a fresh install opens on the first-run page.
    await page.goto('/?sign-in');
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

    // Step 3 is current: it starts one small task, and states its terminal equivalent.
    await expect(stepItems.nth(2)).toHaveAttribute('aria-current', 'step');
    await expect(stepItems.nth(2)).toHaveAttribute('data-step-state', 'current');
    await expect(stepItems.nth(3)).toHaveAttribute('data-step-state', 'pending');
    await expect(page.getByRole('heading', { name: 'Ship one small change', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start task' })).toBeVisible();
    await expect(page.locator('[data-terminal-equivalent]')).toContainText('mainworks create task.json');
    await expect(page.locator('[data-terminal-equivalent]')).toContainText('mainworks ready');

    // No horizontal scroll at 1280 and 390 px.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await noSideScroll(page), `first-run at ${width}px must not scroll horizontally`).toBe(true);
    }
  } finally {
    await page.unrouteAll().catch(() => {});
    await new Promise<void>(resolve => http.close(() => resolve()));
    await store.close();
    rmSync(repoDir, { recursive: true, force: true });
  }
});
