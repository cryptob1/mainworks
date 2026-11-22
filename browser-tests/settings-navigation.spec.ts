import { test, expect, type Page } from '@playwright/test';
import { boardApi } from './ui-board';

// GY-3598: the four places. Settings holds Agents, Workers, Costs, Setup, Delivery and Help, with
// Operator automation behind an Advanced fold for the admin alone; Product sits under Lead and
// Test cases under Work → Advanced. Each is reached by click and by keyboard at 1280px and 390px,
// the old direct links still open, and nothing scrolls sideways.

async function open(page: Page, role: string, hash = '') {
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/operator-agents') return route.fulfill({ json: [{ id: 'a', displayName: 'Master loop', capabilities: ['work.create'], scope: { repositories: [], workItems: [] }, fingerprints: [], revision: 1, revokedAt: null, lastMutation: { kind: 'create', actor: 'operator', at: '2026-01-01T00:00:00Z', reason: 'Scoped master loop' } }] });
    return route.fulfill({ json: boardApi(url.pathname.slice(1) + url.search, role) });
  });
  await page.goto(`/?sign-in${hash}`);
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
}

const primary = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const tabs = (page: Page) => page.getByRole('navigation', { name: 'Pages in this section' });
async function entry(page: Page, name: string) { await primary(page).getByRole('link', { name: new RegExp(`^${name}(\\s+\\d+)?$`) }).click(); }
async function heading(page: Page, name: string | RegExp) { await expect(page.getByRole('main').getByRole('heading', { name, level: 1 })).toBeVisible(); }

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
  test(`e2e:settings-navigation — four places and Settings sub-tabs at ${viewport.name} width`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    await open(page, 'admin');
    await heading(page, 'Work');

    // Settings holds Agents, Workers, Costs, Setup, Delivery, Help, and Operator automation behind Advanced.
    await entry(page, 'Settings');
    await heading(page, 'Agents');
    await expect(tabs(page).getByRole('button')).toHaveText(['Agents', 'Workers', 'Costs', 'Setup', 'Delivery', 'Help']);
    await expect(tabs(page).getByText('Advanced', { exact: true })).toBeVisible();
    await expect(tabs(page).getByRole('button', { name: 'Operator automation', includeHidden: true })).toBeHidden();
    await tabs(page).getByRole('button', { name: 'Setup', exact: true }).click();
    await heading(page, 'Set up Mainworks');
    await tabs(page).getByText('Advanced', { exact: true }).click();
    await tabs(page).getByRole('button', { name: 'Operator automation' }).click();
    await heading(page, 'Operator automation');

    // Product under Lead, Costs under Settings, Test cases under Work → Advanced.
    await entry(page, 'Lead');
    await tabs(page).getByRole('button', { name: 'Product', exact: true }).click();
    await heading(page, 'Product');
    await entry(page, 'Settings');
    await tabs(page).getByRole('button', { name: 'Costs', exact: true }).click();
    await heading(page, 'Costs');
    await entry(page, 'Work');
    await tabs(page).getByText('Advanced', { exact: true }).click();
    await tabs(page).getByRole('button', { name: 'Test cases', exact: true }).click();
    await heading(page, 'Test-case library');

    // The configuration area by keyboard alone: Enter opens the Settings place, Tab along its tabs, open Advanced.
    await primary(page).getByRole('link', { name: /^Settings/ }).focus();
    await page.keyboard.press('Enter');
    await heading(page, 'Agents');
    await tabs(page).getByRole('button', { name: 'Agents', exact: true }).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await heading(page, 'Set up Mainworks');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(tabs(page).locator('summary')).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await heading(page, 'Operator automation');
    await expect(tabs(page).getByRole('button', { name: 'Operator automation' })).toHaveAttribute('aria-current', 'page');

    // Every top-bar link fits, nothing scrolls sideways.
    for (const link of await primary(page).getByRole('link').all()) {
      const box = await link.evaluate(element => ({ clipped: element.scrollWidth > element.clientWidth + 1, right: element.getBoundingClientRect().right }));
      expect(box.clipped).toBe(false);
      expect(box.right).toBeLessThanOrEqual(viewport.width);
    }
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways).toBeLessThanOrEqual(0);
  });
}

for (const [hash, name] of [['#setup', 'Set up Mainworks'], ['#master', 'Lead']] as const) test(`e2e:settings-navigation — the direct link ${hash} still opens its page`, async ({ page }) => {
  await open(page, 'admin', hash);
  await heading(page, name);
});

test('e2e:settings-navigation — identities without the permission gain no configuration controls', async ({ page }) => {
  await open(page, 'reader');
  await heading(page, 'Work');
  await entry(page, 'Settings');
  await heading(page, 'Agents');
  await expect(tabs(page).getByRole('button')).toHaveText(['Agents', 'Workers', 'Costs', 'Delivery', 'Help']);
  await expect(page.getByText('Advanced', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open the first-run Setup checklist' })).toHaveCount(0);
  await tabs(page).getByRole('button', { name: 'Costs', exact: true }).click();
  await heading(page, 'Costs');
});

test('e2e:settings-navigation — a worker has no admin configuration controls', async ({ page }) => {
  await open(page, 'worker');
  await heading(page, 'Work');
  await entry(page, 'Settings');
  await expect(tabs(page).getByRole('button')).toHaveText(['Workers', 'Costs', 'Help']);
  await entry(page, 'Work');
  await heading(page, 'Work');
  // An empty test-case library is the admin's to fill, so a worker sees no Test cases tab (GY-3485).
  await expect(tabs(page).getByRole('button', { name: 'Test cases', exact: true, includeHidden: true })).toHaveCount(0);
});
