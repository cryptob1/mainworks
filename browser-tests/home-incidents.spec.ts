import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';

// e2e:home-incidents — GY-3601: Home says in ten seconds whether work is moving and what broke.
// The status snapshot is seeded with a release check wedged 28 hours and half the Builder accounts held.

const minute = 60_000, hour = 60 * minute;
const at = (ago: number) => new Date(Date.now() - ago).toISOString();
const item = (key: string, title: string, extra: Record<string, unknown> = {}) => ({ dependencies: [], scenarioRequirements: [], id: `fixture-${key}`, key, title, description: title, type: 'feature', priority: 2,
  stage: 'build', stageEnteredAt: at(10 * minute), createdAt: at(hour), ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [], criteria: [], evidence: [], gates: [], sessions: [], lease: null, ...extra });
const merged = (key: string, title: string, mergedAt: string) => item(key, title, { stage: 'done', delivery: { mergedAt, mergeSha: key.replace(/\D/g, '').padStart(40, 'a') } });
const account = (name: string, eligible: boolean) => ({ name, eligible, resetsAt: null, roles: [{ role: 'worker' }] });
const status = {
  actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, repository: 'fixture/repository', jobs: [],
  releaseCheck: { since: at(28 * hour) }, live: { commit: 'c'.repeat(40), waiting: [] }, app: { deployedAt: at(2 * hour) },
  fleet: { accounts: [account('claude-a', false), account('claude-b', false), account('codex-a', true), account('codex-b', true)], roles: [{ role: 'worker', live: 1, limit: 3 }] },
  hosts: [{ host: 'runner-1', away: false }, { host: 'runner-2', away: false }],
};

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function homeAt(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  // The first line: state, Builders working of allowed, test machines ready of configured, last live, merges an hour today.
  const line = page.locator('[data-status-line]');
  await expect(line).toHaveAttribute('data-status-line', 'Slowed');
  await expect(line).toContainText('Slowed');
  await expect(line).toContainText('1 of 3 Builders working');
  await expect(line).toContainText('2 of 2 test machines ready');
  await expect(line).toContainText('Last live 2 h ago');
  await expect(line).toContainText(/\d+\.\d merges an hour today/);
  // One card per incident: what broke, impact, what the team does, one button naming verb and object.
  const release = page.locator('[data-incident="release-check"]');
  await expect(release).toContainText('The release check has not passed in 28 h.');
  await expect(release).toContainText('Impact');
  await expect(release).toContainText('Team');
  await expect(release.getByRole('button')).toHaveText('Ask the Lead');
  const accounts = page.locator('[data-incident="accounts"]');
  await expect(accounts).toContainText('2 of 4 Builder accounts are held');
  await expect(accounts.getByRole('button')).toHaveText('Open accounts');
  await expect(page.locator('[data-incident]')).toHaveCount(2);
  // The top bar omits its duplicate activity strip on Home so working/merged counts appear once.
  await expect(page.locator('.top-bar .activity-strip')).toHaveCount(0);
  // The status line comes first in the page's content.
  const first = await page.evaluate(() => {
    const line = document.querySelector('[data-status-line]')!, top = line.getBoundingClientRect().top;
    return [...document.querySelectorAll('.main *')].filter(el => !line.contains(el) && !el.closest('.top-bar') && !el.closest('[role=alert]') && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent!.trim()) && (el as HTMLElement).offsetParent)
      .every(el => el.getBoundingClientRect().top >= top);
  });
  expect(first).toBe(true);
  expect(await noSideScroll(page)).toBe(true);
}

test('e2e:home-incidents — the status line and both incident cards at 1280 and 390 px', async ({ page }) => {
  test.setTimeout(120_000);
  const work = [merged('GY-1', 'Earlier change', at(hour)), item('GY-2', 'Rows are one line', { lease: { owner: 'graphyard-claude-1', epoch: 1, expiresAt: at(-hour) } })];
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url());
    const now = new Date().toISOString();
    if (pathname.endsWith('/status')) return route.fulfill({ json: { ...status, now } });
    if (pathname.endsWith('/work-snapshot')) return route.fulfill({ json: { work, now } });
    if (pathname.endsWith('/board')) return route.fulfill({ json: boardFromStatus(work as never, Date.parse(now), null) });
    return route.fulfill({ json: [] });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.locator('header.main-top-bar')).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home(\s+\d+)?$/ }).click();
  await expect(page).toHaveURL(/#home$/);
  await expect(page.getByRole('heading', { name: 'Home', exact: true, level: 1 })).toBeVisible();
  for (const width of [1280, 390]) await homeAt(page, width);
});
