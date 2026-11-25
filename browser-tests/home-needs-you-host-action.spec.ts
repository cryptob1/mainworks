import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';

// e2e:home-needs-you-host-action — GY-3827: a test machine whose helper is older than this release
// takes no test work until its owner runs a one-time prepare. Home's Needs you shows one card per such
// machine with the command and what it unblocks; the card goes once the machine reads current.

const hour = 3_600_000;
const at = (ago: number) => new Date(Date.now() - ago).toISOString();
const work = [{ dependencies: [], scenarioRequirements: [], id: 'fixture-GY-1', key: 'GY-1', title: 'Earlier change', description: 'Earlier change', type: 'feature', priority: 2,
  stage: 'done', stageEnteredAt: at(hour), createdAt: at(2 * hour), ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [], criteria: [], evidence: [], gates: [], sessions: [], lease: null,
  delivery: { mergedAt: at(hour), mergeSha: 'a'.repeat(40) } }];
const old = (host: string) => ({ host, away: true, update: true, reason: `${host}'s graphyard-host-shim is older than this release` });
let hosts: unknown[] = [];

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('e2e:home-needs-you-host-action — one Needs you card per outdated test machine with the command and gain, gone once current, at 1280 and 390 px', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url());
    const now = new Date().toISOString();
    if (pathname.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, repository: 'fixture/repository', jobs: [], hosts, now } });
    if (pathname.endsWith('/work-snapshot')) return route.fulfill({ json: { work, now } });
    if (pathname.endsWith('/board')) return route.fulfill({ json: boardFromStatus(work as never, Date.parse(now), null) });
    return route.fulfill({ json: [] });
  });
  for (const width of [1280, 390]) {
    hosts = [{ host: 'here', local: true, away: false }, old('gy-compute@vish-msi'), old('gy-compute@omarchypc')];
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/?sign-in#home');
    await page.getByLabel('Access token').fill('fixture');
    await page.getByRole('button', { name: 'Open control plane' }).click();
    await expect(page.getByRole('heading', { name: 'Home', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
    const section = page.locator('.group-needs-you');
    const cards = section.locator('[data-host-action]');
    await expect(cards).toHaveCount(2);
    for (const name of ['vish-msi', 'omarchypc']) {
      const card = section.locator(`[data-host-action="gy-compute@${name}"]`);
      await expect(card).toContainText(name);
      await expect(card).toContainText('mainworks host prepare');
      await expect(card).toContainText('with sudo');
      await expect(card).toContainText('moves test work off this machine');
      await expect(card).not.toContainText(/GY-\d|shim/);
    }
    await expect(page.locator('[data-host-update]')).toHaveCount(0);
    expect(await noSideScroll(page)).toBe(true);

    // The owner prepares vish-msi; the next read shows it current and its card goes.
    hosts = [{ host: 'here', local: true, away: false }, { host: 'gy-compute@vish-msi', away: false }, old('gy-compute@omarchypc')];
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Home', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(cards).toHaveCount(1);
    await expect(section.locator('[data-host-action="gy-compute@vish-msi"]')).toHaveCount(0);
    hosts = [{ host: 'here', local: true, away: false }, { host: 'gy-compute@vish-msi', away: false }, { host: 'gy-compute@omarchypc', away: false }];
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Home', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-host-action]')).toHaveCount(0);
    expect(await noSideScroll(page)).toBe(true);
  }
});
