import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';

// GY-3600: Work is one list of real tasks, grouped by goal, with Needs you pinned on top. Two goals of three
// tasks each and one task with no goal, served as the API; the page is read at 1280 and 390 px.
const minute = 60_000, hour = 60 * minute;
const speed = 'Six merges an hour', plain = 'A dashboard anyone understands';
const seats = 'Add two Claude seats so more Builders can work';

function tasks(now: number, { request = true } = {}) {
  const at = (offset: number) => new Date(now + offset).toISOString();
  // The shipped task merged today, even for a run just after local midnight, and went live 1h 40m after its review began.
  const merged = -Math.min(30 * minute, (now - new Date(now).setHours(0, 0, 0, 0)) / 2), live = merged / 2;
  const sha = (seed: string) => seed.repeat(40).slice(0, 40);
  const base = { description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'It works', proofs: ['unit:it-works'] }], policy: { checks: ['test'], review: true },
    policyRevision: 1, revision: 1, ready: true, epoch: 1, lease: null, gates: [], violations: [], workspaces: [], evidence: [], scenarioRequirements: [], sessions: [],
    candidate: null, submission: null, observation: null, blocker: null, reworkRequested: false, createdAt: at(-10 * hour), updatedAt: at(-minute) };
  const builder = (owner: string, displayName: string, runtime: string) => ({ lease: { owner, epoch: 1, expiresAt: at(hour) }, lastAssignment: { owner, epoch: 1, displayName, runtime } });
  const pr = (n: number, opened: number) => ({ candidate: { sha: sha(String(n % 10)), baseSha: sha('b'), pr: n, branch: `graphyard/gy-${n}`, author: 'worker', createdAt: at(opened) }, submission: { epoch: 1, pr: n } });
  const item = (n: number, title: string, fields: Record<string, unknown>) => ({ ...base, id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, key: `GY-${n}`, title, ...fields });
  const decision = request ? {
    humanRequest: { id: '11111111-2222-4333-8444-555555555555', kind: 'money-or-accounts', reason: 'More builders need more seats.', needed: seats, requestedBy: 'worker-3', epoch: 1, at: at(-2 * hour) },
    blocker: `Waiting on a human-only decision (spending money or opening third-party accounts): ${seats}` } : {};
  return [
    item(101, 'Reuse a passed verification of the same head', { goal: speed, stage: 'review', stageEnteredAt: at(-12 * minute), ...builder('worker-a', 'Juniper', 'Claude'), ...pr(401, -15 * minute),
      gates: [{ name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }] }),
    item(102, 'Trials stop running one test group at a time when hot', { goal: speed, stage: 'build', stageEnteredAt: at(-41 * minute), ...builder('worker-b', 'Milo', 'Codex'), ...pr(402, -45 * minute),
      blocker: 'The merge trial failed three times on remote-shards.test.ts' }),
    item(103, 'Build each base commit once per trial', { goal: speed, stage: 'done', stageEnteredAt: at(merged), ...pr(403, live - 100 * minute), lastAssignment: { owner: 'worker-c', epoch: 1, displayName: 'Wren', runtime: 'Claude' },
      delivery: { mergedAt: at(merged), mergeSha: sha('3'), authorizationRevision: 1, deployment: { sha: sha('3'), mergeSha: sha('3'), source: 'endpoint', covers: 'exact', observedAt: at(live), at: at(live), observer: 'master' } } }),
    item(104, 'Lead page: History and Messages are their own tabs', { goal: plain, stage: 'build', stageEnteredAt: at(-5 * minute) }),
    item(105, seats, { goal: plain, stage: 'build', stageEnteredAt: at(-2 * hour), ...decision }),
    item(106, 'The product is called Mainworks everywhere', { goal: plain, stage: 'build', stageEnteredAt: at(-9 * minute), ...builder('worker-c', 'Wren', 'Claude') }),
    item(107, 'Tidy the release notes', { stage: 'build', stageEnteredAt: at(-3 * minute), ...builder('worker-d', 'Otis', 'Claude') }),
  ];
}

async function open(page: Page, width: number, options?: { request?: boolean }) {
  await page.setViewportSize({ width, height: 900 });
  const now = Date.now(), work = tasks(now, options);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, repository: 'fixture/repository', jobs: [] } });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work, now: new Date(now).toISOString() } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(work as never, now, null) });
    if (/\/work\/[^/]+$/.test(path)) return route.fulfill({ json: work.find(item => path.endsWith(item.id) || path.endsWith(item.key)) });
    return route.fulfill({ json: [] });
  });
  await page.goto('/?sign-in#work');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
}
const noSideScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
const rowKeys = (page: Page, scope = page.locator('main')) => scope.locator('[data-row]').evaluateAll(rows => rows.map(row => row.getAttribute('data-row')));

for (const width of [1280, 390]) {
  test(`e2e:work-list — at ${width}px: header, Needs you, goal groups, columns, filters with counts and search by PR`, async ({ page }) => {
    await open(page, width);
    // The header line: merges an hour over 6 hours, median review-to-live; the counts are the filter chips', shown once (GY-3987).
    await expect(page.locator('[data-work-header]')).toHaveText('0.2 merges/hour (6h) · 1h 40m median review to live');

    // Needs you sits above the filters: the question, how long it waited, one verb-and-object button.
    const needs = page.getByRole('region', { name: 'Needs you' });
    await expect(needs.locator('[data-need]')).toHaveCount(1);
    await expect(needs.locator('[data-need]')).toContainText(seats);
    await expect(needs.locator('[data-need]')).toContainText('waiting 2h');
    const filters = page.getByRole('group', { name: 'Filter work' });
    expect((await needs.boundingBox())!.y).toBeLessThan((await filters.boundingBox())!.y);

    // Each filter with its count.
    for (const [filter, count] of [['In flight', 5], ['Stuck', 1], ['Up next', 1], ['Shipped today', 1]] as const)
      await expect(filters.getByRole('button', { name: `${filter} ${count}`, exact: true })).toBeVisible();

    // Rows grouped under their goal, shipped/total with a bar; the stuck row tinted and first in its group.
    const speedGroup = page.locator('[data-goal="Six merges an hour"]'), plainGroup = page.locator('[data-goal="A dashboard anyone understands"]');
    await expect(speedGroup.getByRole('heading', { name: speed })).toBeVisible();
    await expect(speedGroup.locator('[data-goal-progress]')).toHaveText('1/3 shipped');
    await expect(speedGroup.locator('progress')).toHaveAttribute('value', '1');
    await expect(plainGroup.locator('[data-goal-progress]')).toHaveText('0/3 shipped');
    expect(await rowKeys(page, speedGroup)).toEqual(['GY-102', 'GY-101', 'GY-103']);
    expect(await rowKeys(page, plainGroup)).toEqual(['GY-105', 'GY-106', 'GY-104']);
    await expect(speedGroup.locator('[data-row="GY-102"]')).toHaveAttribute('data-stuck', 'true');
    await expect(speedGroup.locator('[data-row="GY-101"]')).not.toHaveAttribute('data-stuck', 'true');
    expect(await speedGroup.locator('[data-row="GY-102"]').evaluate(row => getComputedStyle(row).backgroundColor))
      .not.toBe(await speedGroup.locator('[data-row="GY-101"]').evaluate(row => getComputedStyle(row).backgroundColor));

    // Each column of a row: state, title linking to the Task page on one line, what it is doing now, Builder and model, PR, time in state.
    const row = speedGroup.locator('[data-row="GY-101"]');
    await expect(row.locator('[data-col="state"]')).toHaveText('In review');
    const title = row.locator('[data-col="task"] a');
    await expect(title).toHaveText('Reuse a passed verification of the same head');
    await expect(title).toHaveAttribute('href', '#GY-101');
    expect(await title.evaluate(link => getComputedStyle(link).whiteSpace)).toBe('nowrap');
    await expect(row.locator('[data-col="now"]')).toHaveText('Waiting for the reviewer');
    await expect(row.locator('[data-col="builder"]')).toHaveText('Juniper · Claude');
    await expect(row.locator('[data-col="pr"] a')).toHaveAttribute('href', 'https://github.com/fixture/repository/pull/401');
    await expect(row.locator('[data-col="time"]')).toHaveText('12m');
    await expect(speedGroup.locator('[data-row="GY-102"] [data-col="state"]')).toHaveText('Stuck');
    await expect(speedGroup.locator('[data-row="GY-102"] [data-col="now"]')).toHaveText('Blocked 41m: a fault blocks it; the master agent clears it.');
    await expect(speedGroup.locator('[data-row="GY-103"] [data-col="state"]')).toHaveText('Shipped');
    // At 390 px a row is a compact three-line grid, not a stack of six cells; the search box shows its whole placeholder.
    expect(await row.evaluate(r => getComputedStyle(r).display)).toBe(width === 390 ? 'grid' : 'table-row');
    expect(await page.getByLabel('Search work').evaluate((input: HTMLInputElement) => input.clientWidth >= 240)).toBe(true);

    // The task with no goal sits in a collapsed 'No goal' group.
    const none = page.locator('details[data-goal="none"]');
    await expect(none).not.toHaveAttribute('open', /.*/);
    await expect(none.locator('summary')).toContainText('No goal');
    await expect(none.locator('[data-row="GY-107"]')).toBeHidden();
    await none.locator('summary').click();
    await expect(none.locator('[data-row="GY-107"]')).toBeVisible();
    await noSideScroll(page);

    // Each filter narrows the list to exactly its count, and is a query parameter.
    const shown = async () => (await rowKeys(page)).sort();
    await filters.getByRole('button', { name: 'Stuck 1', exact: true }).click();
    await expect(page).toHaveURL(/[?&]filter=stuck/);
    expect(await shown()).toEqual(['GY-102']);
    await filters.getByRole('button', { name: 'Up next 1', exact: true }).click();
    await expect(page).toHaveURL(/[?&]filter=up-next/);
    expect(await shown()).toEqual(['GY-104']);
    await filters.getByRole('button', { name: 'Shipped today 1', exact: true }).click();
    expect(await shown()).toEqual(['GY-103']);
    await filters.getByRole('button', { name: 'In flight 5', exact: true }).click();
    await expect(page).toHaveURL(/[?&]filter=in-flight/);
    expect(await shown()).toEqual(['GY-101', 'GY-102', 'GY-105', 'GY-106', 'GY-107']);
    await noSideScroll(page);

    // Search matches title, key and PR number.
    const search = page.getByRole('searchbox', { name: 'Search work' });
    await search.fill('402');
    expect(await shown()).toEqual(['GY-102']);
    await search.fill('#401');
    expect(await shown()).toEqual(['GY-101']);
    await search.fill('gy-104');
    expect(await shown()).toEqual(['GY-104']);
    await search.fill('release notes');
    expect(await shown()).toEqual(['GY-107']);
    await search.fill('');
    await noSideScroll(page);

    // The Needs you button opens the decision.
    await needs.getByRole('button', { name: 'Review request' }).click();
    await expect(page.getByRole('button', { name: '← Back' })).toBeVisible();
  });

  test(`e2e:work-list — at ${width}px with no open request the Needs you strip is absent`, async ({ page }) => {
    await open(page, width, { request: false });
    await expect(page.locator('[data-goal="A dashboard anyone understands"] [data-row="GY-105"]')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Needs you' })).toHaveCount(0);
    await expect(page.locator('[data-need]')).toHaveCount(0);
    await expect(page.locator('[data-work-header]')).toHaveText('0.2 merges/hour (6h) · 1h 40m median review to live');
    await expect(page.getByRole('group', { name: 'Filter work' }).getByRole('button', { name: 'In flight 4', exact: true })).toBeVisible();
    await noSideScroll(page);
  });
}
