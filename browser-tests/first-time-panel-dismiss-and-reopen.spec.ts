import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';

// e2e:first-time-panel-dismiss-and-reopen — GY-4066: Got it hides the day-one checklist and it stays hidden
// after a reload; Settings → Help has one Show the first-time checklist button that opens Home with the
// checklist shown again, whether Help was reached from Settings or with the address still on Home.

const hour = 3_600_000;
const at = (ago: number) => new Date(Date.now() - ago).toISOString();
const merged = { dependencies: [], scenarioRequirements: [], id: 'fixture-GY-1', key: 'GY-1', title: 'Earlier change', description: 'Earlier change', type: 'feature', priority: 2,
  stage: 'done', stageEnteredAt: at(hour), createdAt: at(2 * hour), ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [], criteria: [], evidence: [], gates: [], sessions: [], lease: null,
  delivery: { mergedAt: at(hour), mergeSha: 'a'.repeat(40) } };
const work = [merged];
const status = { actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, repository: 'fixture/repository', jobs: [] };

const panel = (page: Page) => page.getByRole('region', { name: 'First time here?', exact: true });
const homeShown = (page: Page) => expect(page.getByRole('heading', { name: 'Home', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
const helpTab = (page: Page) => page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: 'Help', exact: true }).click();
const show = (page: Page) => page.getByRole('button', { name: 'Show the first-time checklist', exact: true });
/** Help offers one Show the first-time checklist button, and pressing it opens Home with the checklist. */
async function reopenedFromHelp(page: Page) {
  await expect(show(page)).toBeVisible();
  await expect(page.getByRole('button', { name: /first-time checklist/i })).toHaveCount(1);
  await show(page).click();
  await expect(page).toHaveURL(/#home$/);
  await homeShown(page);
  await expect(panel(page).getByRole('listitem')).toHaveCount(7);
  // The dismissal is gone from this browser, not only from the page that was open.
  await page.reload();
  await expect(panel(page).getByRole('listitem')).toHaveCount(7);
}

test('e2e:first-time-panel-dismiss-and-reopen — Got it hides the checklist for good, and the button on Help opens Home with it again', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url());
    const now = new Date().toISOString();
    if (pathname.endsWith('/status')) return route.fulfill({ json: { ...status, now } });
    if (pathname.endsWith('/work-snapshot')) return route.fulfill({ json: { work, now } });
    if (pathname.endsWith('/board')) return route.fulfill({ json: boardFromStatus(work as never, Date.parse(now), null) });
    return route.fulfill({ json: [] });
  });
  await page.goto('/?sign-in#home');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await homeShown(page);
  await expect(panel(page).getByRole('listitem')).toHaveCount(7);

  // Got it hides the checklist, and a reload does not bring it back.
  await panel(page).getByRole('button', { name: 'Got it' }).click();
  await expect(panel(page)).toHaveCount(0);
  await page.reload();
  await homeShown(page);
  await expect(panel(page)).toHaveCount(0);

  // Settings → Help on a phone: the one button brings the checklist back and opens Home.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true }).click();
  await helpTab(page);
  await expect(page.getByRole('heading', { name: 'How Mainworks works', exact: true, level: 1 })).toBeVisible();
  await reopenedFromHelp(page);

  // Help opened with the address still on Home (g s jumps to Setup; a tab keeps the address): the button opens Home all the same.
  await panel(page).getByRole('button', { name: 'Got it' }).click();
  await expect(panel(page)).toHaveCount(0);
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await expect(page.getByRole('heading', { name: 'Set up Mainworks', exact: true, level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/#home$/);
  await helpTab(page);
  await expect(page.getByRole('heading', { name: 'How Mainworks works', exact: true, level: 1 })).toBeVisible();
  await reopenedFromHelp(page);
});
