import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { withDatabase } from '../tests/helpers/postgres';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { encodeLoopHosts, loopHostsHeader, loopPresenceHeader, loopSupervisionHeader, type LoopHost } from '../src/model/loop-presence';
import { coordinationViewHeader } from '../src/server/work-view';

// e2e:scale-limits-with-hosts — GY-3528: the loop names each machine it reads with its cores busy,
// temperature and heavy-job slots; the Workers page shows the budget the ready machines share and
// each machine's load, one short line each, with host names and no SSH targets, at 1280 and 390 px.

async function plane(context: BrowserContext) {
  const store = await withDatabase('scale_limits_with_hosts');
  await store.init();
  const engine = new Engine(store, 120, 'fixture/shop');
  engine.gitRunner = null;
  const http = server(engine, [
    { id: 'operator', role: 'admin', sessionKind: 'human', token: 'test-human-operator' },
    { id: 'loop', role: 'coordinator', sessionKind: 'ai', token: 'test-loop' },
  ]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await context.route('**/*', async route => {
    const { pathname, search } = new URL(route.request().url());
    await route.fetch(pathname.startsWith('/api/') ? { url: url + pathname + search } : {})
      .then(response => route.fulfill({ response }), () => route.abort('connectionrefused'));
  });
  const close = async () => { await context.unrouteAll(); await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); };
  return { url, close };
}

/** The hosts as `master run` sends them: each reading with the slots its share holds. */
const hosts: LoopHost[] = [
  { host: 'vishrog', local: true, away: false, cores: 24, busy: 6.4, celsius: 61, steal: 0, runs: 2, slots: 4 },
  { host: 'gy-compute@vish-msi:2222', away: false, cores: 24, busy: 3, celsius: 58, steal: 0, runs: 1, slots: 4 },
  { host: 'gy-compute@omarchypc:2222', away: false, cores: 32, busy: 12.2, celsius: 70, steal: 1, runs: 3, slots: 5 },
];

async function openWorkers(page: Page, url: string) {
  const read = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: 'Bearer test-loop', [coordinationViewHeader]: 'coordination', [loopPresenceHeader]: '15', [loopSupervisionHeader]: 'autonomous', [loopHostsHeader]: encodeLoopHosts(hosts) } });
  expect(read.status).toBe(200);
  const signIn = await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } });
  const { code } = await signIn.json() as { code: string };
  await page.goto(`/#sign-in=${code}`);
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: 'Workers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Workers', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`e2e:scale-limits-with-hosts — Workers shows the heavy-job budget across the ready machines and each machine's load in one line, at ${viewport.width} px`, async ({ page, context }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    const { url, close } = await plane(context);
    try {
      await openWorkers(page, url);
      // GY-3485: the hosts and budget sit in the closed Machine details fold.
      await page.getByText('Machine details', { exact: true }).click();
      await expect(page.locator('[data-heavy-budget]')).toHaveText('13 heavy-job slots (this machine 4, vish-msi 4, omarchypc 5)', { timeout: 15_000 });
      await expect(page.locator('[data-machine-load]')).toHaveCount(0);
      const table = page.getByRole('table', { name: 'Hosts' });
      const local = table.locator('[data-host="vishrog"]');
      await expect(local.locator('[data-label="Host"]')).toHaveText('vishrog (this machine)');
      await expect(local.locator('[data-label="Cores"]')).toHaveText('6 of 24 busy');
      await expect(local.locator('[data-label="Temperature"]')).toHaveText('61°C');
      const msi = table.locator('[data-host="gy-compute@vish-msi:2222"]');
      await expect(msi.locator('[data-label="Host"]')).toHaveText('vish-msi');
      await expect(msi.locator('[data-label="Cores"]')).toHaveText('3 of 24 busy');
      await expect(msi.locator('[data-label="Temperature"]')).toHaveText('58°C');
      const omarchy = table.locator('[data-host="gy-compute@omarchypc:2222"]');
      await expect(omarchy.locator('[data-label="Host"]')).toHaveText('omarchypc');
      await expect(omarchy.locator('[data-label="Cores"]')).toHaveText('12 of 32 busy');
      await expect(omarchy.locator('[data-label="Temperature"]')).toHaveText('70°C');
      const hostsSection = page.locator('section.hosts-section', { has: table });
      await expect(hostsSection).not.toContainText('gy-compute');
      await expect(hostsSection).not.toContainText(':2222');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    } finally { await page.close(); await close(); }
  });
}
