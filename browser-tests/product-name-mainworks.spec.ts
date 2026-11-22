import { test, expect, type Page } from '@playwright/test';
import { boardApi, boardStatus, boardWork, NOW } from './ui-board';
import { boardFromStatus } from '../src/model/board';
import { onboardingBranch, onboardingWorkRequest } from '../src/model/onboarding-work';

// GY-3572: the dashboard names the product Mainworks on every page a person reads, and in the tab title.
// The board every fresh install shows: the onboarding change `up` files is on it, waiting to merge.
function work() {
  const board = boardWork(), { policy: _policy, ...request } = onboardingWorkRequest('a'.repeat(40), null, 'served-head');
  const template = board.find(item => item.key === 'GY-20');
  return [...board, { ...template, ...request, id: '00000000-0000-4000-8000-000000000099', key: 'GY-99', humanRequest: null, blocker: null, workspaces: [{ branch: onboardingBranch }] }];
}
async function serve(page: Page) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/sign-in')) return route.fulfill({ json: { token: 'fixture' } });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work: work(), jobs: [], now: new Date(NOW).toISOString() } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(work() as any, NOW, boardStatus()) });
    return route.fulfill({ json: path.endsWith('/status') ? boardStatus() : boardApi(path.slice(1)) });
  });
}
const settled = { timeout: 15_000 };
async function namesMainworks(page: Page) {
  await expect(page.locator('body')).toContainText('Mainworks', settled);
  await expect(page.locator('body')).not.toContainText('Graphyard');
  // The wordmark beside the logo is the name too, lower case in the sidebar.
  await expect(page.locator('.brand')).toHaveText(/^\s*mainworks\s*$/i);
  await expect(page).toHaveTitle(/Mainworks/);
  expect(await page.title()).not.toContain('Graphyard');
}

test('e2e:product-name-mainworks — sign-in, home and an invite link say Mainworks, never Graphyard', async ({ page }) => {
  test.setTimeout(90_000);
  await serve(page);
  await page.goto('/?sign-in');
  await expect(page.getByLabel('Access token')).toBeVisible();
  await namesMainworks(page);

  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible(settled);
  await expect(page.locator('body')).toContainText('Add Mainworks onboarding');
  await namesMainworks(page);

  // The onboarding change: its row on Work, its own page, and the Setup page's current step.
  await page.getByText('Add Mainworks onboarding').first().click();
  await expect(page.locator('body')).toContainText('so Mainworks can start delivering', settled);
  await namesMainworks(page);
  await page.goto('/#setup');
  await expect(page.locator('[data-setup-item="onboarding"]')).toContainText("adds Mainworks's delivery workflows", settled);
  await namesMainworks(page);

  // The Help page embeds the setup and infra guide topics in its Reference folds.
  await page.goto('/#guide');
  await page.getByText('Setup prerequisites and options').click();
  await page.getByText('Every part, with its log command').click();
  await expect(page.locator('#docs-reference')).toContainText('runs on a Linux host', settled);
  await expect(page.locator('#docs-reference')).toContainText("Mainworks's files", settled);
  await namesMainworks(page);

  // An invite link opens once and lands on the home page.
  const invite = await page.context().newPage();
  await serve(invite);
  await invite.goto('/#sign-in=invite-code-0123456789');
  await expect(invite.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible(settled);
  await namesMainworks(invite);
});
