import { test, expect } from '@playwright/test';
import { priorityServer } from '../helpers/priority-server';
import type { Work } from '../../src/model';

// GY-3723: item-why-and-simplest.spec.ts failed on a loaded batch gate and passed its re-run. The create box
// opened the new item only after its refresh succeeded, so one failed read of that refresh left the operator on
// the Work list with the item filed but never opened. The first work-snapshot read after the create fails here;
// the new item must still open once a later read brings it.
test('a new work item opens even when the refresh after its create fails once', async ({ page }) => {
  test.setTimeout(120_000);
  const f = await priorityServer();
  try {
    let created = false, failed = false;
    await page.route('**/api/**', async route => {
      const { pathname, search } = new URL(route.request().url());
      if (pathname === '/api/work' && route.request().method() === 'POST') created = true;
      else if (created && !failed && pathname === '/api/work-snapshot') { failed = true; return route.fulfill({ status: 503, json: { error: 'unavailable' } }).catch(() => {}); }
      const response = await route.fetch({ url: f.url + pathname + search }).catch(() => null);
      await (response ? route.fulfill({ response }) : route.abort()).catch(() => {});
    });
    const { code } = await f.ok('sign-in-links', {});
    await page.goto('/#sign-in=' + code + '&work');
    await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: '＋ New work item' }).click();
    const form = page.getByRole('dialog', { name: 'New work item' });
    await form.getByLabel('Title', { exact: true }).fill('Opens after a failed read');
    await form.getByLabel('Why it helps users').fill('Owners see the item they just filed.');
    await form.getByLabel('Why it is the simplest thing that works').fill('Open it before the refresh, not after.');
    const posted = page.waitForResponse(response => response.url().endsWith('/api/work') && response.request().method() === 'POST');
    await form.getByRole('button', { name: 'Create work item', exact: true }).click();
    const item = await (await posted).json() as Work;
    await expect(page.locator('article.item-page h1')).toHaveText(item.title, { timeout: 20_000 });
    expect(failed).toBe(true);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await f.close();
  }
});
