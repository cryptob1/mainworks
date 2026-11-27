import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';

// e2e:shipped-tests-agree — GY-3559: Shipped pages its long list 50 rows at a time, Tests shows one
// failing count that matches its matrix and one row of chips, and Test cases reads each step by name
// with the JSON folded under Raw. Served as the API; read at 390 and 1280 px.
const merged = 1200;
const sha = (n: number) => n.toString(16).padStart(40, 'a');

function shipped(now: number) {
  const at = (offset: number) => new Date(now + offset).toISOString();
  const base = { description: '', type: 'feature', priority: 2, dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, policyRevision: 1, revision: 1, ready: true, epoch: 1, lease: null,
    gates: [], violations: [], workspaces: [], evidence: [], scenarioRequirements: [], sessions: [], submission: null, blocker: null, reworkRequested: false, createdAt: at(-3_600_000), updatedAt: at(-1000) };
  // Every item merged within the last two minutes, so all are today's; each went live, observed by the control plane.
  return Array.from({ length: merged }, (_, i) => {
    const when = at(-100 * (i + 1));
    return { ...base, id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, key: `GY-${i + 1}`, title: `Shipped change number ${i + 1}`, stage: 'done', stageEnteredAt: when,
      candidate: { sha: sha(i), baseSha: sha(0), pr: i + 1, branch: `graphyard/gy-${i + 1}`, author: 'worker', createdAt: at(-3_600_000) },
      observation: { source: 'control-plane', mergeSha: sha(i) },
      delivery: { mergedAt: when, mergeSha: sha(i), authorizationRevision: 1, deployment: { sha: sha(i), mergeSha: sha(i), source: 'endpoint', covers: 'exact', observedAt: when, at: when, observer: 'master' } } };
  });
}

const cell = (result: 'pass' | 'fail', ago: number) => ({ result, at: new Date(Date.now() - ago).toISOString(), link: null, detail: null });
const run = (result: 'pass' | 'fail') => ({ seq: 1, scenarioId: 'x', proof: 'e2e:x', scenarioRevision: 1, result, executed: 1, skipped: 0, sha: 'c'.repeat(40), baseSha: '', policyRevision: 0, workId: '', workKey: 'GY-1', pr: null,
  evidenceId: '', producer: 'operator', environment: 'trial', run: { kind: 'producer', id: 'r1', attempt: null, url: null }, at: new Date().toISOString() });
const link = { id: 'i1', key: 'GY-1', title: 'Shipped change number 1', stage: 'done', criteria: [] };
const tracked = (id: string, fields: Record<string, unknown>) => ({ id, title: `Case ${id}`, revision: 1, runs: 1, failures: 0, flaky: false, flakyReason: null, links: [link], history: [], latest: null, lastFailure: null,
  onMain: true, category: 'dashboard', e2e: { tags: ['dashboard'], target: 'any', required: true }, matrix: {}, ...fields });
// The three counts used to disagree: case A's latest run passed but it failed Served; case B's latest run failed but every place it
// ran since passed; case C merged without its file. The matrix counts one failing case, A, and so must the headline.
const testsRead = {
  window: 20, manual: [], environments: [],
  cases: [
    tracked('case-a', { latest: run('pass'), matrix: { trial: cell('pass', 3_600_000), served: cell('fail', 60_000) } }),
    tracked('case-b', { latest: run('fail'), matrix: { main: cell('pass', 60_000) } }),
    tracked('case-c', { onMain: false, category: 'review', e2e: { tags: ['review'], target: 'any', required: false } }),
  ],
};
const scenarios = [{
  id: 'shop-checkout', title: 'A shopper checks out', purpose: 'Checkout works end to end.', setup: ['secret SHOP_TOKEN'], environment: 'any', runner: 'graphyard-e2e', testPath: 'e2e/cases/shop-checkout.json',
  steps: [
    JSON.stringify({ kind: 'command', name: 'Build the shop', run: 'npm run build', timeoutSeconds: 300 }),
    JSON.stringify({ kind: 'http', method: 'GET', path: '/healthz', status: 200 }),
    JSON.stringify({ kind: 'browser', action: 'click', role: 'button', text: 'Pay' }),
  ],
  expected: ['Build the shop exits 0', 'GET /healthz returns 200'], revision: 1, hash: 'h', createdAt: new Date().toISOString(), createdBy: 'operator',
}];

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  const now = Date.now(), work = shipped(now);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, repository: 'fixture/repository', jobs: [] } });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work, now: new Date(now).toISOString() } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(work as never, now, null) });
    if (path.endsWith('/api/tests')) return route.fulfill({ json: testsRead });
    if (path.endsWith('/api/scenarios')) return route.fulfill({ json: scenarios });
    return route.fulfill({ json: [] });
  });
  await page.goto('/?sign-in#work');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
}
const goTo = async (page: Page, hash: string) => { await page.evaluate(next => { location.hash = next; }, hash); };
const measure = (page: Page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, height: document.documentElement.scrollHeight }));

for (const width of [390, 1280]) {
  test(`e2e:shipped-tests-agree — at ${width}px: Shipped pages by 50, Tests counts once, Test cases read as steps`, async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, width);

    // AC-1: Shipped shows 50 rows of the 1200, its headline counts all 1200, and Show 50 more adds 50.
    await goTo(page, 'shipped');
    const rows = page.locator('main [data-row]');
    await expect(rows).toHaveCount(50);
    await expect(page.locator('[data-filter="shipped-today"]')).toHaveText(`Shipped today ${merged}`);
    const texts = await rows.allInnerTexts();
    expect(texts.filter(text => /\b[0-9a-f]{7}\b/.test(text)), 'no row shows a 7-character SHA').toEqual([]);
    // AC-4: no sideways scroll, and the page at 390 px stays short.
    const shippedSize = await measure(page);
    expect(shippedSize.scrollWidth, 'Shipped is no wider than the window').toBe(shippedSize.clientWidth);
    if (width === 390) expect(shippedSize.height, 'Shipped at 390 px is under 15000 px tall').toBeLessThan(15000);
    await page.getByRole('button', { name: 'Show 50 more' }).click();
    await expect(rows).toHaveCount(100);

    // AC-2: the headline's failing count is the matrix summary's, and there is one row of chips.
    await goTo(page, 'tests');
    const summary = page.locator('.matrix-summary');
    await expect(summary).toBeVisible();
    const failing = Number(/(\d+) failing/.exec(await summary.innerText())![1]);
    expect(failing).toBe(1);
    await expect(page.locator('.page-fact').first()).toContainText(`${failing} failing`);
    await expect(page.locator('.tests-page .case-filters')).toHaveCount(1);
    const tops = await page.locator('.tests-page .case-filters > *').evaluateAll(chips => [...new Set(chips.map(chip => Math.round(chip.getBoundingClientRect().top)))]);
    expect(tops.length, 'every chip sits on one row').toBe(1);
    const testsSize = await measure(page);
    expect(testsSize.scrollWidth, 'Tests is no wider than the window').toBe(testsSize.clientWidth);

    // AC-3: Test cases shows each step as one plain line, the JSON only inside a closed Raw fold.
    await goTo(page, 'scenarios');
    const steps = page.locator('.scenario-card ol li');
    await expect(steps).toHaveText(['Build the shop', 'GET /healthz', 'click button Pay']);
    const lines = await steps.evaluateAll(items => items.map(item => { const range = document.createRange(); range.selectNodeContents(item); return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size; }));
    expect(lines, 'each step is one line').toEqual([1, 1, 1]);
    const loose = await page.evaluate(() => [...document.querySelectorAll('main *')].filter(node => [...node.childNodes].some(child => child.nodeType === 3 && child.textContent!.trimStart().startsWith('{"kind"')))
      .filter(node => { const fold = node.closest('details'); return !fold || fold.open || fold.querySelector('summary')?.textContent !== 'Raw'; }).map(node => node.textContent));
    expect(loose, 'no JSON step outside a closed Raw fold').toEqual([]);
    await expect(page.locator('.scenario-card details', { hasText: 'Raw' }).first()).not.toHaveAttribute('open', '');
    const casesSize = await measure(page);
    expect(casesSize.scrollWidth, 'Test cases is no wider than the window').toBe(casesSize.clientWidth);
  });
}
