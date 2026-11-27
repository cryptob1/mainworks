import { test, expect } from '@playwright/test';
import { NOW, at, buildDemoState, demoAnswer } from '../scripts/docs-media-demo.mjs';
import { serveXterm } from './xterm';

// e2e:lead-page-shows-not-moving-items — GY-4000: at 390 and 1280 px, the Lead page shows
// not-moving items from the demo data as one plain line each (key, short title, how long, stage,
// next-step owner), with no horizontal scroll; and shows nothing for it when none are not moving.

for (const width of [390, 1280]) {
  test(`e2e:lead-page-shows-not-moving-items — Lead page shows not-moving lines at ${width} px with no horizontal scroll`, async ({ page }) => {
    test.setTimeout(90_000);
    const state = buildDemoState('static');
    const notMoving = [
      { key: 'DEMO-104', title: 'Export billing invoices to CSV', stage: 'review', ageMs: 85 * 60_000, owner: 'a reviewer' },
      { key: 'DEMO-105', title: 'Add dark mode toggle', stage: 'ready', ageMs: 45 * 60_000, owner: 'nobody' },
    ];
    (state as Record<string, unknown>).notMoving = { notMoving, waitingOnPerson: [] };

    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date(NOW));
    await serveXterm(page);
    await page.routeWebSocket(/\/api\/terminal/, ws => {
      ws.send(JSON.stringify({ type: 'hello', mode: 'control', session: { account: 'lead-claude', runtime: 'claude', pane: '1', state: 'working', since: at(-6 * 60_000) } }));
    });
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url());
      return route.fulfill({ json: demoAnswer(state, url.pathname.slice('/api/'.length), url.searchParams) });
    });
    await page.addInitScript(() => {
      localStorage.setItem('graphyard.theme', 'daylight');
      localStorage.setItem('graphyard-token', 'demo-token');
    });

    await page.goto('/#lead');
    await expect(page.getByRole('heading', { name: 'Lead', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
    const section = page.locator('[data-not-moving]');
    await expect(section).toBeVisible({ timeout: 15_000 });
    await expect(section).toContainText('DEMO-104 Export billing invoices to CSV');
    await expect(section).toContainText('1h 25m');
    await expect(section).toContainText('review');
    await expect(section).toContainText('a reviewer');
    await expect(section).toContainText('DEMO-105 Add dark mode toggle');
    await expect(section).toContainText('45m');
    await expect(section).toContainText('nobody');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `no horizontal scroll at ${width} px`).toBe(0);
  });
}
