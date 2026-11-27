import { test, expect } from '@playwright/test';
import { judge, nav, open, read, settle } from './ux-rules';

// The rules and helpers live in ./ux-rules (GY-3962); Sign-in, Setup and the first-run steps are in ux-first-screens.spec.ts (GY-3989).
for (const width of [390, 1280]) {
  test(`e2e:ux-rules-hold-at-390-and-1280 — Home, Work, a change and Lead keep the four newcomer rules at ${width} px`, async ({ page }) => {
    test.setTimeout(180_000);
    const found: string[] = [];
    await open(page, 'static', width);
    await expect(page.locator('[data-status-line]')).toBeVisible({ timeout: 15_000 });
    await settle(page);
    found.push(...judge('Home', await read(page), width));

    await nav(page, 'Work');
    await expect(page.locator('[data-work-header]')).toContainText('merges/hour');
    // The demo line is healthy: at least 3 merges an hour.
    expect(Number(/([\d.]+) merges\/hour/.exec(await page.locator('[data-work-header]').innerText())![1])).toBeGreaterThanOrEqual(3);
    await settle(page);
    found.push(...judge('Work', await read(page), width));

    await page.getByRole('link', { name: /Rate-limit the login endpoint/ }).click();
    await expect(page.getByRole('heading', { name: 'Rate-limit the login endpoint', level: 1 })).toBeVisible();
    // Details is the Details area; every other tab is a primary view.
    for (const tab of ['Checks and diff', 'Live session', 'Lead']) {
      await page.getByRole('tablist', { name: 'Task evidence' }).getByRole('tab', { name: tab, exact: true }).click();
      await settle(page);
      found.push(...judge(`Change · ${tab}`, await read(page), width));
    }

    await nav(page, 'Lead');
    await expect(page.getByRole('heading', { name: 'Lead', level: 1 })).toBeVisible();
    for (const tab of ['Conversation', 'Live session', 'History']) {
      await page.getByRole('tablist', { name: 'Lead views' }).getByRole('tab', { name: tab, exact: true }).click();
      await settle(page);
      found.push(...judge(`Lead · ${tab}`, await read(page), width));
    }
    await page.evaluate(() => { location.hash = 'product'; });
    await expect(page.getByRole('heading', { name: 'Product', level: 1 })).toBeVisible();
    await settle(page);
    found.push(...judge('Lead · Product', await read(page), width));
    expect(found, `newcomer rules at ${width} px`).toEqual([]);
  });

  test(`e2e:ux-rules-hold-at-390-and-1280 — a fresh install's empty Home, Work and Lead say what happens next at ${width} px`, async ({ page }) => {
    test.setTimeout(120_000);
    const found: string[] = [];
    await open(page, 'empty', width);
    await expect(page.getByRole('main')).toContainText(/\S/, { timeout: 15_000 });
    await settle(page);
    found.push(...judge('first-run Home', await read(page), width));
    await nav(page, 'Work');
    await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible();
    await settle(page);
    found.push(...judge('empty Work', await read(page), width));
    await nav(page, 'Lead');
    for (const tab of ['Conversation', 'History']) {
      await page.getByRole('tablist', { name: 'Lead views' }).getByRole('tab', { name: tab, exact: true }).click();
      await settle(page);
      found.push(...judge(`empty Lead · ${tab}`, await read(page), width));
    }
    expect(found, `empty states at ${width} px`).toEqual([]);
  });

}
