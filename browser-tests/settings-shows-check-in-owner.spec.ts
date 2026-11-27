import { test, expect, type Page } from '@playwright/test';
import { NOW, boardApi } from './ui-board';

// GY-3850: Settings shows who every commit is authored by — the owner's name and email in its
// Identity section — and, with none named, the form that names them (GY-3995). Nothing scrolls sideways.

async function open(page: Page, owner: { name: string; email: string } | null) {
  await page.clock.setFixedTime(new Date(NOW));
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url()), path = url.pathname.slice('/api/'.length);
    const json = boardApi(url.pathname.slice(1) + url.search) as any;
    return route.fulfill({ json: path === 'status' ? { ...json, owner } : json });
  });
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Settings(\s+\d+)?$/ }).click();
  await page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: 'Delivery', exact: true }).click();
  return page.getByRole('main').getByRole('region', { name: 'Identity' });
}
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) test(`e2e:settings-shows-check-in-owner — Settings names the owner commits are authored by at ${viewport.width}px`, async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize(viewport);
  const identity = await open(page, { name: 'Ada Lovelace', email: 'ada@example.com' });
  await expect(identity.getByRole('heading', { name: 'Identity' })).toBeVisible();
  await expect(identity.locator('[data-owner-name]')).toHaveText('Ada Lovelace');
  await expect(identity.locator('[data-owner-email]')).toHaveText('ada@example.com');
  await expect(identity).toContainText('Commits are authored Ada Lovelace (Mainworks).');
  expect(await sideways(page)).toBe(0);
});

test('e2e:settings-shows-check-in-owner — with no owner named, Settings offers the one form that names them', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const identity = await open(page, null);
  await expect(identity).toContainText('Commits are authored Mainworks: name the owner below.');
  const form = identity.getByRole('form', { name: 'Name the owner' });
  await expect(form.getByRole('textbox', { name: 'Name' })).toBeVisible();
  await expect(form.getByRole('textbox', { name: 'Email' })).toBeVisible();
  await expect(form.getByRole('button', { name: 'Name the owner' })).toBeVisible();
  expect(await sideways(page)).toBe(0);
});
