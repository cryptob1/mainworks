import { test, expect, type Page } from '@playwright/test';
import { boardApi, boardStatus } from './ui-board';
import { costSummary, type UsageRow } from '../src/model/token-costs';
import { emptyRegistry, type AgentRegistry } from '../src/model/registry';

// e2e:workers-tests-plain — GY-3485: Workers, Costs and Tests keep one fact line and their main
// table; machine internals, model breakdowns, price sheets and where tests run fold into Details.
// The dashboard is served over stubbed reads: a loop CPU reading, two live sessions' cgroup scopes
// and two hosts; usage with two models on no price sheet and a runtime that reported nothing; and
// three cases of one category that ran only in a merge trial, one of them never.

const now = Date.now(), at = new Date(now).toISOString();
const model = (name: string) => ({ name, id: null, cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong', contextTokens: null } });
const registry = { ...emptyRegistry(), models: [model('claude-fable-5-2'), model('gpt-6-astra'), model('mystery-1')], accounts: [{ name: 'claude-a' }, { name: 'codex-a' }] } as unknown as AgentRegistry;
const row = (id: string, model: string, input: number, output: number, reported = true): UsageRow =>
  ({ id, work: 'GY-1', role: 'worker', account: model === 'claude-fable-5-2' ? 'claude-a' : 'codex-a', runtime: 'stub', model, reported, input, output, cacheRead: 0, cacheWrite: 0, at });
// Fable at $8/$40 on the bundled sheet: $8.00 + $4.00. Astra and mystery-1 have no price.
const costs = costSummary([row('w', 'claude-fable-5-2', 1_000_000, 100_000), row('a', 'gpt-6-astra', 200_000, 10_000), row('m', 'mystery-1', 100_000, 5_000), row('n', 'claude-fable-5-2', 0, 0, false)], registry, new Set(['GY-1']), now);

const status = (role: string) => ({ ...boardStatus(role),
  cpu: { avg60: 8, steal: 0, celsius: 79, testBudget: 24, trialCap: { now: 6, full: 6 }, waiting: false },
  sessions: [{ session: 'graphyard-run-6f1c2d3e-0000-4000-8000-000000000001.scope', cpu: 1.2, cpuShare: 6, memory: 2 ** 30, memoryShare: 16 * 2 ** 30, overSince: null },
    { session: 'graphyard-run-6f1c2d3e-0000-4000-8000-000000000002.scope', cpu: 0.4, cpuShare: 6, memory: 2 ** 29, memoryShare: 16 * 2 ** 30, overSince: null }],
  hosts: [{ host: 'yard', local: true, away: false, cores: 24, celsius: 79, steal: 0, runs: 2 }, { host: 'gy-compute@spare', away: false, cores: 16, celsius: 60, steal: 1, runs: 1 }],
});
const cell = (result: 'pass' | 'fail') => ({ result, at, link: null, detail: null });
const testCase = (id: string, title: string, matrix: object) => ({ id, title, purpose: `${title}.`, testPath: `e2e/cases/${id}.json`, environment: 'local', revision: 1, changed: null, links: [],
  latest: null, staleRevision: false, runs: 0, failures: 0, lastFailure: null, flaky: false, flakyReason: null, history: [], onMain: true, category: 'dashboard',
  e2e: { tags: ['dashboard'], target: 'any', required: true }, matrix });
const tests = { window: 20, manual: [], cases: [testCase('board-loads', 'The board loads', { trial: cell('pass') }), testCase('board-filters', 'The board filters', { trial: cell('fail') }), testCase('board-sorts', 'The board sorts', {})],
  environments: [{ name: 'local', where: 'On this host, inside the trial', when: 'Every merge trial and batch gate', lifecycle: null, limit: null, inUse: 0, last: null }] };

async function open(page: Page, role = 'admin') {
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/status') return route.fulfill({ json: status(role) });
    if (url.pathname === '/api/costs') return route.fulfill({ json: costs });
    if (url.pathname === '/api/tests') return route.fulfill({ json: tests });
    if (url.pathname === '/api/scenarios') return route.fulfill({ json: [] });
    return route.fulfill({ json: boardApi(url.pathname.slice(1) + url.search, role) });
  });
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
}
async function go(page: Page, section: string, sub?: string) {
  const menu = page.getByRole('button', { name: 'Menu' });
  if (page.viewportSize()!.width <= 650 && await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: section, exact: true }).click();
  if (sub) await page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button', { name: sub, exact: true }).click();
}

/** The text a person sees in the main pane: rendered, and outside the body of a closed fold. Titles are attributes, never text. */
const visibleText = (page: Page) => page.evaluate(() => {
  const out: string[] = [];
  const walker = document.createTreeWalker(document.querySelector('main')!, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement!;
    const fold = parent.closest('details:not([open])');
    if (fold && !fold.querySelector(':scope > summary')!.contains(parent)) continue;
    if (!parent.checkVisibility({ visibilityProperty: true })) continue;
    out.push(node.textContent!);
  }
  return out.join(' ');
});
async function plain(page: Page) {
  const text = await visibleText(page);
  for (const internal of ['.scope', 'master registry', 'not run here', 'builder']) expect(text, `'${internal}' shows outside a fold`).not.toContain(internal);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
  test(`e2e:workers-tests-plain — Workers, Costs and Tests show one fact line and their table, the rest folded, at ${viewport.name} width`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    await open(page);
    const main = page.getByRole('main');

    // Workers: the machine in one line; sessions' scopes and the hosts fold into Machine details.
    await go(page, 'Workers');
    await expect(main.getByRole('heading', { name: 'Workers', level: 1 })).toBeVisible();
    await expect(page.locator('.host-cpu')).toHaveText('Machine: 8% busy · 79°C');
    await expect(main).not.toContainText('Building means an agent is writing the change');
    await expect(main).not.toContainText('Merge trials send test shards to added hosts too');
    const machine = main.locator('details', { has: page.locator('summary', { hasText: 'Machine details' }) });
    await expect(machine).toHaveCount(1);
    await expect(machine).not.toHaveAttribute('open', /.*/);
    await expect(machine.getByRole('table', { name: 'Session usage', includeHidden: true })).toBeHidden();
    await expect(machine.getByRole('table', { name: 'Hosts', includeHidden: true })).toBeHidden();
    await plain(page);
    await machine.locator('summary').click();
    await expect(machine.getByRole('table', { name: 'Hosts' })).toBeVisible();
    await expect(machine.getByRole('table', { name: 'Session usage' })).toContainText('graphyard-run-6f1c2d3e-0000-4000-8000-000000000001.scope');

    // Costs: dollars this week and how many models have no price, named in its title; the breakdowns but By role fold away.
    await go(page, 'Workers', 'Costs');
    await expect(main.getByRole('heading', { name: 'Costs', level: 1 })).toBeVisible();
    const fact = main.locator('.page-fact');
    await expect(fact).toHaveText('$12.00 this week · 2 models have no price');
    await expect(fact.locator('[title]')).toHaveAttribute('title', /gpt-6-astra.*mystery-1/);
    await expect(main).not.toContainText("The tokens this project's agents spent");
    await expect(main).not.toContainText('master registry');
    await expect(main.getByRole('table', { name: 'By role' })).toBeVisible();
    for (const name of ['By model', 'By account', 'Price sheet']) await expect(main.getByRole('table', { name, includeHidden: true })).toBeHidden();
    await expect(main.getByText('ran on a runtime that reported no usage')).toBeHidden();
    await plain(page);

    // Tests: only the place a case ran, no grouping of one category, an empty cell a dash; the rest in titles and folds.
    await go(page, 'Tests');
    await expect(main.getByRole('heading', { name: 'Tests', level: 1 })).toBeVisible();
    const matrix = main.getByRole('table', { name: 'Where each case runs' });
    await expect(matrix).toBeVisible();
    await expect(main).not.toContainText('Every proof an item must pass');
    await expect(main).not.toContainText('a builder cannot record one');
    await expect(main.getByRole('region', { name: 'Where tests run' })).toBeHidden();
    await expect(matrix.locator('thead tr').first().locator('th')).toHaveText(['Case', 'Trial']);
    await expect(matrix.locator('thead th[title="the latest merge trial that ran it"]')).toHaveCount(1);
    await expect(matrix.locator('.matrix-group')).toHaveCount(0);
    await expect(matrix.locator('tr[data-case="board-sorts"] td[data-column="trial"]')).toHaveText('—');
    await plain(page);

    // Test cases: an empty library is one line and one button for an admin.
    await go(page, 'Tests', 'Test cases');
    await expect(main).toContainText('No test cases yet.');
    await expect(main.locator('button:not(.top-bar button)')).toHaveCount(1);
    await expect(main.getByRole('button', { name: '＋ New test case' })).toBeVisible();
    await expect(main).not.toContainText('Versioned scenarios');
    await expect(main).not.toContainText('Definitions live here');
    await plain(page);
  });
}

test('e2e:workers-tests-plain — with an empty library the Test cases tab is hidden from a non-admin', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, 'reader');
  await go(page, 'Tests');
  await expect(page.getByRole('main').getByRole('heading', { name: 'Tests', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Test cases', exact: true })).toHaveCount(0);
});
