import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';

// e2e:item-status-plain — GY-3558: a Work row and the item page say the state and one next step in
// plain words: a declined block, a task waiting for a worker, one waiting on another's files and one
// the master holds. No principal id, resource path or 'Nothing is happening' reaches the page.
const minute = 60_000, hour = 60 * minute;
const master = 'graphyard-master-graphyard-operator';
const file = 'src/model/board.ts';

function tasks(now: number) {
  const at = (offset: number) => new Date(now + offset).toISOString();
  const base = { description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'It works', proofs: ['unit:it-works'] }], policy: { checks: ['test'], review: true },
    policyRevision: 1, revision: 1, ready: true, epoch: 1, lease: null, gates: [], violations: [], workspaces: [], evidence: [], scenarioRequirements: [], sessions: [],
    candidate: null, submission: null, observation: null, blocker: null, reworkRequested: false, createdAt: at(-10 * hour), updatedAt: at(-minute) };
  const item = (n: number, title: string, fields: Record<string, unknown>) => ({ ...base, id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, key: `GY-${n}`, title, ...fields });
  return [
    item(201, 'Add two Claude seats', { stage: 'build', stageEnteredAt: at(-2 * hour), blockedAt: at(-2 * hour),
      blocker: 'A human declined spending money or opening third-party accounts for this item: not this month' }),
    item(202, 'Tidy the release notes', { stage: 'build', stageEnteredAt: at(-7 * minute) }),
    item(203, 'Board rows name their builder', { stage: 'build', stageEnteredAt: at(-4 * minute), exclusiveResources: [file] }),
    item(204, 'Board groups sort by age', { stage: 'build', stageEnteredAt: at(-20 * minute), exclusiveResources: [file],
      lease: { owner: 'worker-a', epoch: 1, expiresAt: at(hour) }, lastAssignment: { owner: 'worker-a', epoch: 1, displayName: 'Juniper', runtime: 'Claude' } }),
    item(205, 'Rename the Lead page', { stage: 'build', stageEnteredAt: at(-30 * minute), hold: true, heldBy: master,
      holdReason: 'Waits for the GY-3600 redesign to land. Then release it with mainworks ready GY-205.' }),
  ];
}

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  const now = Date.now(), work = tasks(now);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, repository: 'fixture/repository', jobs: [] } });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work, now: new Date(now).toISOString() } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(work as never, now, null) });
    if (/\/work\/[^/]+$/.test(path)) return route.fulfill({ json: work.find(item => path.endsWith(item.id) || path.endsWith(item.key)) });
    return route.fulfill({ json: [] });
  });
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
}

const fits = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
const bodyText = (page: Page) => page.locator('body').innerText();

for (const width of [1280, 390]) {
  test(`e2e:item-status-plain — at ${width}px: Work rows and the item page say state plus one next step, with no principal id`, async ({ page }) => {
    await open(page, width);
    // Every group expanded.
    for (const fold of await page.locator('details.goal-group:not([open]) > summary').all()) await fold.click();
    const now = (key: string) => page.locator(`[data-row="${key}"] [data-col="now"]`);
    await expect(now('GY-201')).toHaveText(/^Blocked \d+[mhd][^:]*: you declined; the master picks the next step\.$/);
    await expect(now('GY-202')).toHaveText(/^Waiting for a worker · \d+m$/);
    await expect(now('GY-203')).toHaveText('Starts after GY-204 (same files)');
    await expect(now('GY-205')).toHaveText('On hold by the master: Waits for the GY-3600 redesign to land.');

    const rows = await page.locator('[data-row]').allInnerTexts();
    expect(rows.length).toBe(5);
    for (const row of rows) for (const banned of ['Nothing is happening', 'exclusive resource', file, master]) expect(row, row).not.toContain(banned);
    expect(await bodyText(page)).not.toContain(master);

    // Every Work row's cells lie inside the row, and the page never scrolls sideways.
    const outside = await page.locator('[data-row]').evaluateAll(list => list.flatMap(row => {
      const outer = row.getBoundingClientRect();
      return [...row.querySelectorAll('[data-col]')].filter(cell => { const box = cell.getBoundingClientRect(); return box.width > 0 && (box.left < outer.left - 1 || box.right > outer.right + 1 || box.top < outer.top - 1 || box.bottom > outer.bottom + 1); })
        .map(cell => `${row.getAttribute('data-row')} ${cell.getAttribute('data-col')}`);
    }));
    expect(outside).toEqual([]);
    await fits(page);

    // The item page: its title is the h1, the hold reads the same, no principal id and no empty Details panel.
    await page.locator('[data-row="GY-205"] [data-col="task"] a').click();
    const article = page.locator('article.item-page');
    await expect(article.getByRole('heading', { level: 1 })).toHaveText('Rename the Lead page');
    await expect(article).toContainText('On hold by the master: Waits for the GY-3600 redesign to land.');
    // Said once: the Next line never repeats the status sentence.
    expect((await article.innerText()).split('On hold by the master').length - 1).toBe(1);
    expect(await bodyText(page)).not.toContain(master);
    await fits(page);
    const details = article.getByRole('tab', { name: 'Details' });
    if (await details.count()) {
      await details.click();
      const panel = article.getByRole('tabpanel', { name: 'Details' });
      expect((await panel.innerText()).trim()).not.toBe('');
      expect(await bodyText(page)).not.toContain(master);
      await fits(page);
    }

    // The item waiting on another's files says so once too.
    await article.getByRole('button', { name: '← Back' }).click();
    await page.locator('[data-row="GY-203"] [data-col="task"] a').click();
    await expect(article.getByRole('heading', { level: 1 })).toHaveText('Board rows name their builder');
    expect((await article.innerText()).split('Starts after GY-204').length - 1).toBe(1);
  });
}
