import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { withDatabase } from '../tests/helpers/postgres';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { encodeLoopCheckoutTrust, loopPresenceHeader, loopStallAlarmHeader, loopSupervisionHeader } from '../src/model/loop-presence';
import { coordinationViewHeader } from '../src/server/work-view';
import { serveXterm } from './xterm';
import { proposedRuntimes } from '../src/model/registry';

async function plane(context: BrowserContext, label: string) {
  const store = await withDatabase(label);
  await store.init();
  const engine = new Engine(store, 120, 'fixture/shop');
  engine.gitRunner = null;
  const http = server(engine, [
    { id: 'operator', displayName: 'Avery', role: 'admin', sessionKind: 'human', token: 'test-human-operator' },
    { id: 'loop', role: 'coordinator', sessionKind: 'ai', token: 'test-loop' },
  ]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await context.route('**/*', async route => {
    const { pathname, search } = new URL(route.request().url());
    await route.fetch(pathname.startsWith('/api/') ? { url: url + pathname + search } : {})
      .then(response => route.fulfill({ response }), () => route.abort('connectionrefused'));
  });
  const close = async () => {
    await context.unrouteAll();
    await new Promise<void>(resolve => http.close(() => resolve()));
    await store.close();
  };
  return { url, close };
}

async function loopRead(url: string, alarm: string | null) {
  const read = await fetch(`${url}/api/work-snapshot`, {
    headers: {
      Authorization: 'Bearer test-loop',
      [coordinationViewHeader]: 'coordination',
      [loopPresenceHeader]: '15',
      [loopSupervisionHeader]: 'autonomous',
      [loopStallAlarmHeader]: alarm ? encodeLoopCheckoutTrust(alarm) : 'off',
    },
  });
  expect(read.status).toBe(200);
}

async function assertTopBar(page: Page, expectedActive: 'Home' | 'Work' | 'Lead' | 'Settings', width: number) {
  const header = page.locator('header.main-top-bar');
  await expect(header).toHaveCount(1);
  await expect(header).toBeVisible();
  // Product mark and name.
  await expect(header.locator('.brand-mark')).toBeVisible();
  await expect(header.locator('.brand-name')).toContainText(/mainworks/i);
  // Pause team button.
  await expect(header.getByRole('button', { name: /Pause team|Resume team/i })).toBeVisible();
  // Exactly four navigation links with the current one marked.
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav).toHaveCount(1);
  const links = nav.getByRole('link');
  await expect(links).toHaveCount(4);
  const labels = (await links.allTextContents()).map(t => t.replace(/\s+\d+$/, '').trim());
  expect(labels).toEqual(['Home', 'Work', 'Lead', 'Settings']);
  await expect(nav.getByRole('link', { name: new RegExp(`^${expectedActive}(\\s+\\d+)?$`) })).toHaveAttribute('aria-current', 'page');

  // No horizontal scroll.
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(sideways, `${expectedActive} at ${width}px must not scroll horizontally`).toBeLessThanOrEqual(0);

  // At 390 px, the four links are a bottom tab bar.
  if (width <= 390) {
    const box = await nav.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box, 'bottom nav has bounding box').not.toBeNull();
    expect(box!.y + box!.height, 'bottom nav sits at bottom of viewport').toBeGreaterThanOrEqual(viewport.height - 4);
    expect(box!.y, 'bottom nav is in the lower portion of the viewport').toBeGreaterThan(viewport.height - 100);
  }
}

for (const width of [1280, 390]) {
  test(`e2e:four-places — four places, old route redirects, and Caretaker pill at ${width}px`, async ({ page, context }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    const { url, close } = await plane(context, `four_places_${width}_${Date.now()}`);
    await serveXterm(context);
    try {
      await loopRead(url, null);
      const signIn = await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } });
      const { code } = await signIn.json() as { code: string };
      await page.goto(`/#sign-in=${code}`);
      await expect(page.locator('header.main-top-bar')).toBeVisible({ timeout: 15_000 });

      // Clean state: Caretaker pill shows quiet grey "Caretaker ✓ N min ago".
      const pill = page.locator('header.main-top-bar .caretaker-pill');
      await expect(pill).toBeVisible();
      await expect(pill).toContainText(/Caretaker ✓ \d+ min ago/);
      await expect(pill).toHaveAttribute('data-caretaker-faults', '0');

      // Open each of the four places via the navigation links.
      const nav = page.getByRole('navigation', { name: 'Main' });
      for (const place of ['Home', 'Work', 'Lead', 'Settings'] as const) {
        await nav.getByRole('link', { name: new RegExp(`^${place}(\\s+\\d+)?$`) }).click();
        await assertTopBar(page, place, width);
      }

      // Follow three old hash routes and assert they land on the right place.
      const oldRoutes: [string, 'Work' | 'Lead' | 'Settings'][] = [
        ['#master', 'Lead'],
        ['#shipped', 'Work'],
        ['#workers', 'Settings'],
      ];
      for (const [hash, expectedPlace] of oldRoutes) {
        await page.evaluate(h => { location.hash = h; }, hash);
        await assertTopBar(page, expectedPlace, width);
      }

      // Seed one fault (stall alarm) and assert the Caretaker pill shows 1 and opens it.
      const alarm = 'Stalled: 1 ready item, 1 free worker slot, no launch since 2026-11-16T08:00:00.000Z. Cause: launches waiting: CPU pressure 96 percent.';
      await loopRead(url, alarm);
      await expect(pill).toHaveAttribute('data-caretaker-faults', '1', { timeout: 20_000 });
      await expect(pill).toContainText(/1 fault/);
      await pill.click();
      await assertTopBar(page, 'Lead', width);
      await expect(page.locator('.stall-alarm')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.stall-alarm')).toContainText('CPU pressure 96 percent');

      // Pause team does nothing it cannot do: with no workers to pause it is disabled and says why.
      const pause = page.locator('header.main-top-bar .pause-team-btn');
      await expect(pause).toBeDisabled();
      await expect(pause).toHaveAttribute('title', 'No workers or reviewers to pause yet');

      // With a worker role, Pause team really sets its concurrency to 0, and Resume team brings it back.
      const apply = await fetch(`${url}/api/agent-registry/apply`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-human-operator', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runtimes: [proposedRuntimes.find(entry => entry.name === 'claude')!], models: [{ name: 'opus', id: 'claude-opus-5' }],
          accounts: [{ name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host: 'build-host', home: '/home/operator/.coding_agents/claude-a' } }],
          roles: [{ name: 'worker', accounts: ['claude-a'], concurrency: 2 }], reason: 'four-places pause',
        }),
      });
      expect(apply.status).toBe(200);
      const workerConcurrency = async () => {
        const status = await (await fetch(`${url}/api/status`, { headers: { Authorization: 'Bearer test-human-operator' } })).json() as { fleet: { roles: { role: string; concurrency: number }[] } };
        return status.fleet.roles.find(role => role.role === 'worker')?.concurrency;
      };
      await expect(pause).toHaveText('Pause team', { timeout: 20_000 });
      await expect(pause).toBeEnabled();
      await pause.click();
      await expect.poll(workerConcurrency).toBe(0);
      await expect(pause).toHaveText('Resume team');
      await pause.click();
      await expect.poll(workerConcurrency).toBe(1);
      await expect(pause).toHaveText('Pause team');
    } finally {
      await page.close();
      await close();
    }
  });
}
