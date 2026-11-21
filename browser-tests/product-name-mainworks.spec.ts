import { test, expect, type Page } from '@playwright/test';
import { boardApi, boardStatus } from './ui-board';

// GY-3572: the dashboard names the product Mainworks on every page a person reads, and in the tab title.
async function serve(page: Page) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/sign-in')) return route.fulfill({ json: { token: 'fixture' } });
    return route.fulfill({ json: path.endsWith('/status') ? boardStatus() : boardApi(path.slice(1)) });
  });
}
const settled = { timeout: 15_000 };
async function namesMainworks(page: Page) {
  await expect(page.locator('body')).toContainText('Mainworks', settled);
  await expect(page.locator('body')).not.toContainText('Graphyard');
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
  await namesMainworks(page);

  // An invite link opens once and lands on the home page.
  const invite = await page.context().newPage();
  await serve(invite);
  await invite.goto('/#sign-in=invite-code-0123456789');
  await expect(invite.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible(settled);
  await namesMainworks(invite);
});
