import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { withDatabase } from '../tests/helpers/postgres';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { proposedRuntimes } from '../src/model/registry';

// e2e:account-check-environment-fault — GY-3788: on the served dashboard, the Workers account list
// shows a logged-in Pi account whose live check hit a read-only home as usable, with one plain line
// naming the check's fault, not as broken.

const HOST = 'build-host';
const checkFault = "check environment fault: read-only account home (EROFS: mkdir '/home/vish/.coding_agents/pi-a/settings.json.lock')";

async function plane(context: BrowserContext) {
  const store = await withDatabase(`env_fault_${randomUUID().slice(0, 8).replace(/-/g, '')}`);
  await store.init();
  const engine = new Engine(store, 120, 'fixture/shop');
  engine.gitRunner = null;
  const http = server(engine, [
    { id: 'operator', role: 'admin', sessionKind: 'human', token: 'test-human-operator' },
    { id: 'executor', role: 'coordinator', sessionKind: 'ai', token: 'test-executor' },
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

async function post(url: string, token: string, path: string, body: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function seed(url: string) {
  const pi = proposedRuntimes.find(entry => entry.name === 'pi')!;
  await post(url, 'test-human-operator', 'agent-registry/apply', {
    runtimes: [pi],
    models: [{ name: 'glm', id: 'zai/glm-5.4' }],
    accounts: [{ name: 'pi-a', runtime: 'pi', model: 'glm', credential: { host: HOST, home: '/home/vish/.coding_agents/pi-a' } }],
    roles: [{ name: 'worker', accounts: ['pi-a'], concurrency: 1 }],
    reason: 'check environment fault e2e',
  });
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  await post(url, 'test-executor', 'agent-registry/observe', {
    host: HOST,
    observations: [
      { account: 'pi-a', quota: { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null, since } },
    ],
  });
  await post(url, 'test-executor', 'agent-registry/observe', {
    host: HOST,
    observations: [
      { account: 'pi-a', quota: { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null, since, fault: checkFault } },
    ],
  });
}

async function openWorkers(page: Page, url: string) {
  const signIn = await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } });
  expect(signIn.status).toBe(200);
  const { code } = await signIn.json() as { code: string };
  await page.goto(`/#sign-in=${code}&work`);
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: 'Workers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Workers', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`e2e:account-check-environment-fault — Workers lists a logged-in Pi account with a read-only check fault as usable, naming the fault in one line, at ${viewport.width} px`, async ({ page, context }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    const { url, close } = await plane(context);
    try {
      await seed(url);
      await openWorkers(page, url);
      const list = page.getByRole('list', { name: 'Account availability' });
      await expect(list).toBeVisible({ timeout: 15_000 });
      const row = list.locator('[data-availability-row="pi-a"]');
      await expect(row).toHaveAttribute('data-state', 'available');
      await expect(row).toContainText('pi-a · available');
      await expect(row).toContainText('read-only account home');
      await expect(row).not.toContainText('broken');
      const { height, lineHeight } = await row.evaluate(element => ({ height: element.clientHeight, lineHeight: parseFloat(getComputedStyle(element).lineHeight) || 18 }));
      expect(height, 'one plain line').toBeLessThan(lineHeight * 2 + 16);
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(viewport.width);
    } finally { await page.close(); await close(); }
  });
}
