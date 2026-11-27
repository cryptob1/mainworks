import { test, expect } from '@playwright/test';
import { judge, open, read, settle } from './ux-rules';

// GY-3989: the first screens a newcomer sees (Sign-in, Setup and the first-run steps) keep the
// newcomer rules of ./ux-rules, show no terminal command outside a fold, and name the next step.
for (const width of [390, 1280]) {
  test(`e2e:ux-rules-hold-at-390-and-1280 — the first-run step 2 says what it checks in plain words at ${width} px`, async ({ page }) => {
    await open(page, 'empty', width);
    await expect(page.getByRole('main')).toContainText(/\S/, { timeout: 15_000 });
    await settle(page);
    await expect(page.locator('.first-run-lead')).toHaveText('Mainworks sends your Builder account one test request to check it answers before it starts work.');
    expect(judge('first-run step 2', await read(page), width)).toEqual([]);
  });

  test(`e2e:ux-rules-hold-at-390-and-1280 — Sign-in and Setup name the next step without a terminal command at ${width} px`, async ({ page }) => {
    test.setTimeout(120_000);
    const found: string[] = [];
    // Setup with the writing account connected and the reviewing one not: the count names the one step left.
    await open(page, 'setup', width);
    await page.evaluate(() => { location.hash = 'setup'; });
    await expect(page.getByRole('heading', { name: 'Set up Mainworks', level: 1 })).toBeVisible();
    await settle(page);
    await expect(page.locator('.page-fact')).toHaveText('1 of 4 steps left. Next: Let an account review the code.');
    // One account can do both: the review row says so rather than reading as a second account to buy.
    await expect(page.locator('[data-setup-item="account:reviewer"]')).toContainText('The account that writes can also review');
    found.push(...judge('Setup', await read(page), width));
    // Every open step has its action, or says who does it.
    await open(page, 'static', width);
    await page.evaluate(() => { location.hash = 'setup'; });
    await expect(page.getByRole('heading', { name: 'Set up Mainworks', level: 1 })).toBeVisible();
    await settle(page);
    for (const row of await page.locator('[data-setup-item][data-done="no"]').all()) await expect(row.locator('[data-setup-action]')).toBeVisible();
    found.push(...judge('Setup (fresh)', await read(page), width));
    // Sign-in: no token stored and every read refused.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.route('**/api/**', route => route.fulfill({ status: 401, json: { error: 'Rejected' } }));
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto('/?sign-in');
    await expect(page.getByLabel('Access token')).toBeVisible();
    found.push(...judge('Sign-in', await read(page), width));
    expect(found, `Sign-in and Setup at ${width} px`).toEqual([]);
  });
}
