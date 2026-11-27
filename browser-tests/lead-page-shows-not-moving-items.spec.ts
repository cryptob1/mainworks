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
    await expect(section.getByRole('heading', { name: 'Not moving (2)' })).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `no horizontal scroll at ${width} px`).toBe(0);

    // Each line opens its item, like the Blocked list.
    await section.getByRole('button', { name: /DEMO-104/ }).click();
    await expect(page.getByRole('heading', { name: 'Add dark mode to account settings', level: 1 })).toBeVisible();
  });
}

test('e2e:lead-page-shows-not-moving-items — 5+ not-moving items at 390x844 never clip the feed or collide with the context rail', async ({ page }) => {
  test.setTimeout(90_000);
  const state = buildDemoState('static');
  const notMoving = [
    { key: 'DEMO-101', title: 'Export billing invoices to CSV', stage: 'review', ageMs: 185 * 60_000, owner: 'a reviewer' },
    { key: 'DEMO-102', title: 'Add dark mode toggle to settings', stage: 'ready', ageMs: 145 * 60_000, owner: 'nobody' },
    { key: 'DEMO-103', title: 'Fix webhook retry backoff schedule', stage: 'in_progress', ageMs: 120 * 60_000, owner: 'a builder' },
    { key: 'DEMO-104', title: 'Migrate session store to Postgres', stage: 'review', ageMs: 95 * 60_000, owner: 'a reviewer' },
    { key: 'DEMO-105', title: 'Verify email change confirmation link', stage: 'ready', ageMs: 65 * 60_000, owner: 'nobody' },
    { key: 'DEMO-106', title: 'Rotate signing key without downtime', stage: 'ready', ageMs: 45 * 60_000, owner: 'nobody' },
  ];
  (state as Record<string, unknown>).notMoving = { notMoving, waitingOnPerson: [] };

  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(new Date(NOW));
  await serveXterm(page);
  await page.routeWebSocket(/\/api\/terminal/, ws => {
    ws.send(JSON.stringify({ type: 'hello', mode: 'watch', session: { account: 'lead-claude', runtime: 'claude', pane: '1', state: 'working', since: at(-6 * 60_000) } }));
  });
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const body = demoAnswer(state, url.pathname.slice('/api/'.length), url.searchParams);
    // Render as a watching viewer so the watching footer note is shown, matching the mobile layout check.
    if (url.pathname.endsWith('/api/status') && body && typeof body === 'object') {
      (body as Record<string, unknown>).actor = { login: 'viewer', role: 'viewer', sessionKind: 'human' };
    }
    return route.fulfill({ json: body });
  });
  await page.addInitScript(() => {
    localStorage.setItem('graphyard.theme', 'daylight');
    localStorage.setItem('graphyard-token', 'demo-token');
  });

  await page.goto('/#lead');
  await expect(page.getByRole('heading', { name: 'Lead', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
  const section = page.locator('[data-not-moving]');
  await expect(section).toBeVisible({ timeout: 15_000 });
  await expect(section.getByRole('heading', { name: 'Not moving (6)' })).toBeVisible();
  await expect(section).toContainText('+1 more');

  const metrics = await page.evaluate(() => {
    const feed = document.querySelector('.lead-feed')?.getBoundingClientRect();
    const box = document.querySelector('.lead-box')?.getBoundingClientRect();
    const rail = document.querySelector('.lead-rail')?.getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      feedHeight: feed?.height ?? 0,
      boxBottom: box?.bottom ?? 0,
      railTop: rail?.top ?? 0,
    };
  });
  expect(metrics.scrollWidth, 'no horizontal scroll at 390 px').toBe(metrics.clientWidth);
  expect(metrics.scrollHeight, 'document never scrolls on Lead page').toBe(metrics.clientHeight);
  expect(metrics.feedHeight, 'conversation feed keeps visible height').toBeGreaterThanOrEqual(40);
  expect(metrics.boxBottom, 'watching footer never overlaps the Lead context rail').toBeLessThanOrEqual(metrics.railTop + 1);
});
