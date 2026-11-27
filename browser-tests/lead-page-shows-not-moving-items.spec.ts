import { test, expect } from '@playwright/test';
import { NOW, at, buildDemoState, demoAnswer } from '../scripts/docs-media-demo.mjs';
import { deriveNotMoving } from '../src/daemon/stall-alarm';
import { serveXterm } from './xterm';

// e2e:lead-page-shows-not-moving-items — GY-4000 (AC-2, AC-5): at 390 and 1280 px, the Lead page
// shows not-moving items derived from the demo's own items (oldest first, one plain line each, with
// blocker reason for blocked items), replaces the Blocked panel so no item appears twice across
// panels, opens each clicked item with that line's own title, and has no horizontal scroll.

function demoStateWithNotMoving() {
  const state = buildDemoState('static');
  const item104 = state.work.find(w => w.key === 'DEMO-104') as any;
  const item105 = state.work.find(w => w.key === 'DEMO-105') as any;
  // Age DEMO-104 in review (85m -> owner 'a reviewer') and block DEMO-105 in build (45m -> owner 'nobody').
  item104.stageEnteredAt = at(-85 * 60_000);
  item104.candidate.createdAt = at(-100 * 60_000);
  item104.observation.at = at(-85 * 60_000);
  item104.sessions[0].startedAt = at(-85 * 60_000);

  item105.stageEnteredAt = at(-45 * 60_000);
  item105.blocker = 'Waiting for staging database credentials';
  item105.blockedAt = at(-45 * 60_000);
  item105.sessions = [];
  item105.lease = null;

  (state as Record<string, unknown>).notMoving = deriveNotMoving(state.work as never, NOW);
  return { state, item104, item105 };
}

for (const width of [390, 1280]) {
  test(`e2e:lead-page-shows-not-moving-items — Lead page shows not-moving lines at ${width} px with no horizontal scroll and no duplicates`, async ({ page }) => {
    test.setTimeout(90_000);
    const { state, item104, item105 } = demoStateWithNotMoving();

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
    await expect(section.getByRole('heading', { name: 'Not moving (2)' })).toBeVisible();
    await expect(section).toContainText(`DEMO-104 ${item104.title}`);
    await expect(section).toContainText('1h 25m');
    await expect(section).toContainText('review');
    await expect(section).toContainText('a reviewer');
    await expect(section).toContainText(`DEMO-105 ${item105.title}`);
    await expect(section).toContainText('45m');
    await expect(section).toContainText('build');
    await expect(section).toContainText('nobody');
    await expect(section).toContainText('Waiting for staging database credentials');

    // AC-5: Not moving replaces Blocked; no Blocked panel exists and no item appears twice across panels.
    await expect(page.getByRole('region', { name: 'Blockers the Lead owes' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /^Blocked\b/ })).toHaveCount(0);
    const panelKeys = await page.evaluate(() => {
      const matches: string[] = [];
      for (const panel of document.querySelectorAll('section.panel')) {
        for (const button of panel.querySelectorAll('li button')) {
          const match = button.textContent?.match(/\bDEMO-\d+\b/);
          if (match) matches.push(match[0]);
        }
      }
      return matches;
    });
    expect(panelKeys).toEqual(['DEMO-104', 'DEMO-105']);
    expect(new Set(panelKeys).size, `no item appears twice across panels at ${width} px`).toBe(panelKeys.length);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `no horizontal scroll at ${width} px`).toBe(0);

    // Clicking a line opens the item with that line's own title.
    await section.getByRole('button', { name: /DEMO-104/ }).click();
    await expect(page.getByRole('heading', { name: item104.title, level: 1 })).toBeVisible();
    await page.getByRole('button', { name: '← Back' }).click();
    await expect(section).toBeVisible({ timeout: 15_000 });
    await section.getByRole('button', { name: /DEMO-105/ }).click();
    await expect(page.getByRole('heading', { name: item105.title, level: 1 })).toBeVisible();
  });
}

test('e2e:lead-page-shows-not-moving-items — 5+ not-moving items at 390x844 never clip the feed or collide with the context rail', async ({ page }) => {
  test.setTimeout(90_000);
  const { state, item105 } = demoStateWithNotMoving();
  for (const [n, title, mins] of [
    [201, 'Fix webhook retry backoff schedule', 185],
    [202, 'Migrate session store to Postgres', 145],
    [203, 'Verify email change confirmation link', 120],
    [204, 'Rotate signing key without downtime', 65],
  ] as const) {
    state.work.push({
      ...item105,
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      key: `DEMO-${n}`,
      title,
      stage: 'ready',
      stageEnteredAt: at(-mins * 60_000),
      blocker: null,
      blockedAt: null,
      sessions: [],
      lease: null,
    });
  }
  (state as Record<string, unknown>).notMoving = deriveNotMoving(state.work as never, NOW);

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
  await expect(page.getByRole('region', { name: 'Blockers the Lead owes' })).toHaveCount(0);

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
