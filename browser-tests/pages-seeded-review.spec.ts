import { test, expect, type Page } from '@playwright/test';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, fleetView, foldObservation, proposedRuntimes } from '../src/model/registry';
import { costSummary } from '../src/model/token-costs';
import { NOW, boardApi } from './ui-board';
import { serveXterm } from './xterm';

// GY-3714: the pages an owner reads, opened over the seed fixture (browser-tests/ui-board.ts: work in
// every stage, a human-only request, agent sessions) plus a connected agent account, a week of usage
// and a declared application, at 1440 and 390 px. Each page shows its seeded items rather than its
// empty state, never scrolls sideways, and its visible text names no internal word. innerText leaves
// out the body of a closed Details fold, which is where internals belong.
const internal = /\b(?:trial|epoch|lease)s?\b/i;
const iso = (offset: number) => new Date(NOW + offset).toISOString();

const registry = (() => {
  const document = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'),
    models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: [{ name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host: 'build-1', home: '/home/agent/.coding_agents/claude-a' } }],
    roles: [{ name: 'worker', accounts: ['claude-a'], concurrency: 2 }, { name: 'reviewer', accounts: ['claude-a'], concurrency: 1 }],
    reason: 'pages seeded review',
  }, { actor: 'coordinator', at: iso(-3_600_000) }).registry;
  foldObservation(document.accounts[0], { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null }, { actor: 'coordinator', at: iso(-60_000) });
  return document;
})();
const costs = costSummary([{ id: 'w', work: 'GY-18', role: 'worker', account: 'claude-a', runtime: 'claude', model: 'claude-fable-5-2', reported: true, input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0, at: iso(-3_600_000) }],
  registry, new Set(['GY-18']), NOW);
const delivery = { mode: 'rapid', previews: 'local', candidateMaxChanges: 5, productionVerification: true, applications: [{ id: 'web', kind: 'static', directory: 'dist' }], cases: { 'checkout-pays': 'web' } };

function answer(path: string, search: string) {
  if (path === 'agent-registry') return fleetView(registry, NOW);
  if (path === 'costs') return costs;
  const json = boardApi(`api/${path}${search}`) as any;
  return path === 'status' ? { ...json, project: { delivery } } : json;
}

// What each page shows from the seed; Setup and Help hold no list, so only their empty state is checked.
const pages: [string, RegExp | null][] = [
  ['home', /Approve a spending cap/], ['work', /Cut the documentation to a short set/], ['item', /Cut the documentation to a short set/], ['lead', /Move sessions to Postgres/],
  ['agents', /claude-a/], ['workers', /Export monthly reports as CSV/], ['costs', /\$\d/], ['setup', null], ['delivery', /web · static site in dist/], ['guide', null],
];

async function open(page: Page, id: string) {
  if (id === 'item') {
    await page.evaluate(() => { location.hash = 'work'; });
    await page.getByRole('link', { name: /Cut the documentation to a short set/ }).first().click();
  } else await page.evaluate(hash => { location.hash = hash; }, id);
  const fact = page.locator('main .page-fact').first();
  await expect(fact, `${id} shows its primary fact`).toBeVisible({ timeout: 15_000 });
  await expect(fact, `${id} finishes reading`).not.toHaveText(/…$/, { timeout: 15_000 });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`e2e:pages-seeded-review — seeded pages show their items, fit and read plainly at ${viewport.width} px`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.clock.setFixedTime(new Date(NOW));
    await page.routeWebSocket(/\/api\/terminal/, () => {});
    await serveXterm(page);
    await page.route('**/api/**', route => { const url = new URL(route.request().url()); return route.fulfill({ json: answer(url.pathname.slice('/api/'.length), url.search) }); });
    await page.setViewportSize(viewport);
    await page.goto('/?sign-in');
    await page.getByLabel('Access token').fill('fixture');
    await page.getByRole('button', { name: 'Open control plane' }).click();
    await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible({ timeout: 15_000 });
    const found: string[] = [];
    for (const [id, seeded] of pages) {
      await open(page, id);
      if (seeded) await expect(page.getByRole('main'), `${id} shows its seeded items`).toContainText(seeded);
      await expect(page.locator('main .empty'), `${id} is not in its empty state`).toHaveCount(0);
      const read = await page.evaluate(() => ({ sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth, text: document.body.innerText }));
      expect(read.sideways, `${id} never scrolls sideways at ${viewport.width} px`).toBeLessThanOrEqual(0);
      for (const line of read.text.split('\n')) if (internal.test(line)) found.push(`${id}: ${line.trim()}`);
    }
    expect(found, `internal words outside Details at ${viewport.width} px`).toEqual([]);
  });
}
