import { test, expect } from '@playwright/test';
import { priorityServer, nextPriorityDispatch } from '../tests/helpers/priority-server';

test('e2e:change-priority — the item page control persists and shows attributed audit history', async ({ page }) => {
  test.setTimeout(120_000);
  const f = await priorityServer();
  // Every assertion waits on the real server; a loaded merge trial needs longer than the default.
  const settled = { timeout: 15_000 };
  try {
    const fields = { type: 'chore', why: 'w', simplest: 's', criteria: [{ id: 'AC-1', text: 'Priority works', proofs: ['e2e:change-priority'] }] };
    const earlier = await f.ok('work', { ...fields, title: 'Earlier item', priority: 3 });
    const item = await f.ok('work', { ...fields, title: 'Change my priority', priority: 3 });
    const legacy = await f.ok('work', { ...fields, title: 'Keep existing P4', priority: 4 });
    for (const ready of [earlier, item]) await f.ok(`work/${ready.id}/ready`, { reason: 'Ready' });
    await page.route('**/api/**', async route => {
      const { pathname, search } = new URL(route.request().url());
      await route.fulfill({ response: await route.fetch({ url: f.url + pathname + search }) });
    });
    const { code } = await f.ok('sign-in-links', {});
    await page.goto('/#sign-in=' + code);
    await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible(settled);
    // GY-3600: the Work list row opens the item; the priority control is on the item page.
    await page.locator(`[data-row="${item.key}"]`).getByRole('link', { name: /open/ }).click();
    const details = page.locator('article.item-page');
    await details.getByRole('tab', { name: 'Details' }).click();
    const detailSelector = details.getByRole('combobox', { name: `Priority for ${item.key}` });
    await expect(detailSelector).toHaveValue('3', settled);
    await detailSelector.selectOption('0');
    await expect(detailSelector).toHaveValue('0', settled);
    expect(await nextPriorityDispatch(f)).toEqual([item.key]);
    await details.locator('.full-history > summary').click();
    const history = details.getByRole('region', { name: 'History entries' });
    await expect(history).toContainText('Priority changed from P3 to P0 from the dashboard', settled);
    await expect(history).toContainText('P3 → P0', settled);
    await expect(history).toContainText('operator', settled);
    await detailSelector.selectOption('2');
    await expect(detailSelector).toHaveValue('2', settled);
    await expect(history).toContainText('Priority changed from P0 to P2 from the dashboard', settled);
    await details.getByRole('button', { name: '← Back', exact: true }).click();
    await page.locator(`[data-row="${legacy.key}"]`).getByRole('link', { name: /open/ }).click();
    await page.locator('article.item-page').getByRole('tab', { name: 'Details' }).click();
    await expect(page.getByRole('combobox', { name: `Priority for ${legacy.key}` })).toHaveValue('4', settled);
    await expect(page.locator('article.item-page option:checked')).toHaveText('P4 (existing)');
    expect((await f.store.workDocument(legacy.id))!.priority).toBe(4);
    expect((await f.ok(`events?work=${legacy.id}`)).filter((event: any) => event.kind === 'priority')).toHaveLength(0);
    expect((await f.call(`work/${item.id}/priority`, { priority: 0, source: 'dashboard' }, f.tokens.worker)).status).toBe(403);
  } finally {
    // The Work page keeps polling /api while the test ends; the proxy's in-flight fetch must not
    // outlive the server it targets (GY-3555 rework: this spec alone closed the fixture server
    // under a live route, the one teardown the suite's other specs avoid — see expiry-loop-stop).
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await f.close();
  }
});
