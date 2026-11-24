import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';
import { flowAttention, flowNumbers, flowWindows, type FlowItem } from '../src/flow-numbers';

// GY-3624: the Work page's header shows merges an hour; the flow line under it shows attempts an hour and first-pass yield, and its
// fold opens each station's median and slowest-tenth wait and the rework causes; a station whose
// slowest tenth passes an hour is one warning line naming it and its oldest item.
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const attempt = (claimed: number, ended: number) => ({ claimedAt: at(claimed), endedAt: at(ended), end: 'submitted' });
const seeded: FlowItem[] = [
  ...[30, 60, 90].map((merged, index) => ({ key: `GY-${index + 1}`, title: `Change ${index + 1}`, stage: 'done', stageEnteredAt: at(merged), mergedAt: at(merged),
    attempts: [attempt(merged + 60, merged + 30)], events: [{ kind: 'submit', at: at(merged + 30), stage: 'review' }, { kind: 'submit', at: at(merged + 20), stage: 'merge' }] })),
  { key: 'GY-4', title: 'Sent back', stage: 'ready', stageEnteredAt: at(100), mergedAt: null, attempts: [attempt(200, 150)],
    events: [{ kind: 'rework', at: at(100), reason: "GY-4: the merge writer's trial of candidate b failed: trial failed", binding: 'b:merge-writer-trial-failed' }] },
  { key: 'GY-5', title: 'Waiting in review', stage: 'review', stageEnteredAt: at(120), mergedAt: null, attempts: [attempt(180, 120)], events: [] },
];
const now = Date.now();
const windows = Object.fromEntries(Object.entries(flowWindows).map(([name, hours]) => [name, flowNumbers(seeded, hours, now)]));
const flow = { ...windows, attention: flowAttention(windows['24h'] as ReturnType<typeof flowNumbers>), asOf: new Date(now - 12_000).toISOString(), ageSeconds: 12 };
const work = seeded.map(item => ({ dependencies: [], scenarioRequirements: [], id: `fixture-${item.key}`, key: item.key, title: item.title, description: item.key, type: 'feature', priority: 2,
  stage: item.stage, stageEnteredAt: item.stageEnteredAt, ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [], criteria: [], evidence: [], gates: [], sessions: [],
  ...(item.mergedAt ? { delivery: { mergedAt: item.mergedAt, mergeSha: 'a'.repeat(40), authorizationRevision: 1 } } : {}) }));

async function serve(page: Page) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const stamp = new Date().toISOString();
    if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, repository: 'fixture/repository', jobs: [], live: { commit: 'c'.repeat(40), waiting: [] }, checksRunning: 0,
      pipelineTime: { merged24h: 0, median: null, p90: null, samples: 0, lastMergeAt: null, oldest: null } } });
    if (path.endsWith('/flow')) return route.fulfill({ json: flow });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work, now: stamp } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(work as never, Date.parse(stamp), null) });
    return route.fulfill({ json: [] });
  });
  await page.goto('/?sign-in#work');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
}
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const width of [390, 1280]) {
  test(`e2e:flow-numbers-shown — at ${width}px the header shows merges and attempts an hour and 75% first pass, the review wait and the slow-station line`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await serve(page);
    await expect(page.locator('[data-work-header]')).toContainText('0.5 merges/hour (6h)');
    await expect(page.locator('[data-flow-attempts]')).toHaveText('0.2 attempts an hour');
    await expect(page.locator('[data-flow-yield]')).toHaveText('75% first pass');
    await expect(page.locator('[data-flow-age]')).toHaveText('as of 12 s ago');
    await expect(page.locator('[data-flow-attention]')).toHaveText('Review is slow: the slowest tenth waited 2 h over the last 24 hours. Oldest: GY-5 Waiting in review, 2 h.');
    await page.getByText('Flow details →').click();
    const review = page.locator('[data-station="review"]');
    await expect(review).toBeVisible();
    await expect(review.locator('td').nth(1)).toHaveText('2 h');
    await expect(review.locator('td').nth(2)).toHaveText('GY-5 · 2 h');
    // Every wait keeps its label at either width: the table's header at 1280 px, each value's own at 390 px.
    const label = await review.locator('td').nth(1).evaluate(cell => getComputedStyle(cell, '::before').content);
    if (width < 650) expect(label).toBe('"Slowest tenth"');
    else await expect(page.getByRole('columnheader', { name: 'Slowest tenth' })).toBeVisible();
    await expect(page.locator('[data-cause="merge trial"] td')).toHaveText('1');
    expect(await noSideScroll(page)).toBe(true);
  });
}
