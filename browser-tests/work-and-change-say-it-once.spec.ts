import { test, expect } from '@playwright/test';
import { NOW, buildDemoState, demoAnswer } from '../scripts/docs-media-demo.mjs';

// GY-3987: over the README's demo data at 390 and 1280 px, Work shows each count once, says which
// shipped count is the week's and reads its Now column owner-first; a change's Now line does not
// repeat its state word, its Next line names an action, and Details labels the priority picker.
for (const width of [390, 1280]) {
  test(`e2e:ux-rules-hold-at-390-and-1280 — Work and a change say each thing once, plainly, with a real next step at ${width} px`, async ({ page }) => {
    test.setTimeout(120_000);
    const state = buildDemoState('static');
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date(NOW));
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url());
      return route.fulfill({ json: demoAnswer(state, url.pathname.slice('/api/'.length), url.searchParams) });
    });
    await page.addInitScript(() => { localStorage.setItem('graphyard.theme', 'daylight'); localStorage.setItem('graphyard-token', 'demo-token'); });
    await page.goto('/#work');
    await expect(page.locator('[data-work-header]')).toContainText('merges/hour', { timeout: 15_000 });

    // The filter chips carry In flight and Shipped today; neither the header line nor the top strip repeats them.
    await expect(page.locator('[data-filter="in-flight"]')).toHaveText(/^In flight \d+$/);
    await expect(page.locator('[data-filter="shipped-today"]')).toHaveText(/^Shipped today \d+$/);
    await expect(page.locator('[data-work-header]')).not.toContainText(/in flight|merged today/);
    await expect(page.locator('.top-bar .activity-strip')).not.toContainText('merged today');
    await expect(page.locator('.top-bar .shipped-strip')).toContainText('shipped this week');
    // The Now column reads owner-first, without the merge writer's or reviewer's own words.
    const now = await page.locator('[data-col="now"]').allInnerTexts();
    expect(now.length).toBeGreaterThan(0);
    for (const cell of now) expect(cell).not.toMatch(/merge trial|latest main|diff and proofs/i);

    await page.getByRole('link', { name: /Rate-limit the login endpoint/ }).click();
    await expect(page.getByRole('heading', { name: 'Rate-limit the login endpoint', level: 1 })).toBeVisible();
    // Now says what is happening without repeating the state beside the title; Next names the action.
    const stateWord = (await page.locator('[data-task-state] strong').innerText()).trim();
    await expect(page.locator('.where-now .page-fact')).toHaveText(/^Now: \S/);
    await expect(page.locator('.where-now .page-fact')).not.toContainText(`${stateWord} ·`);
    await expect(page.locator('.where-now .next-line')).not.toContainText('(automatic)');
    await expect(page.locator('.where-now .next-line')).toHaveText(/^Next: \S+ \w+ .+/);
    // Details labels the priority picker.
    await page.getByRole('tablist', { name: 'Task evidence' }).getByRole('tab', { name: 'Details', exact: true }).click();
    await expect(page.locator('.priority-control')).toContainText('Priority');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `no sideways scroll at ${width}`).toBeLessThanOrEqual(0);
  });
}
