import { test, expect, type Page } from '@playwright/test';
import { at, buildDemoState } from '../scripts/docs-media-demo.mjs';

// e2e:setup-and-new-item-layout — GY-3941: the pages the README and getting-started guide show first read
// cleanly at 1280 and 390 px. On Setup, an unfinished step's action button leaves space above the next
// step's heading; in New work item, the Hold checkbox sits on its label's line, and the help names the Lead.

async function serve(page: Page, phase: 'setup' | 'before-create') {
  const state = buildDemoState(phase);
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname.slice('/api/'.length);
    if (path === 'status') return route.fulfill({ json: state.status });
    if (path === 'work-snapshot') return route.fulfill({ json: { work: state.work, jobs: [], now: at(0) } });
    if (path === 'board') return route.fulfill({ json: state.board });
    if (path === 'flow') return route.fulfill({ json: state.flow });
    if (path === 'work') return route.fulfill({ json: state.work });
    return route.fulfill({ json: [] });
  });
}

for (const width of [1280, 390]) {
  test(`e2e:setup-and-new-item-layout — Setup and New work item read cleanly at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await serve(page, 'setup');
    await page.goto('/#setup');
    const action = page.locator('.setup-checklist [data-setup-action="account:reviewer"]');
    await expect(action).toBeVisible({ timeout: 15_000 });
    const next = action.locator('xpath=ancestor::li[1]/following-sibling::li[1]/strong');
    const [button, heading] = [await action.boundingBox(), await next.boundingBox()];
    expect(heading!.y - (button!.y + button!.height), 'space between the action button and the next step').toBeGreaterThanOrEqual(12);

    await page.unrouteAll();
    await serve(page, 'before-create');
    await page.goto('/#work');
    await page.reload();
    await page.getByRole('button', { name: /New work item/ }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New work item' });
    const hold = dialog.getByRole('checkbox', { name: /Hold/ });
    // The label's own text, measured from its text node: the checkbox shares that line and comes first.
    const [box, text] = await hold.evaluate(input => {
      const range = document.createRange();
      range.selectNodeContents(input.parentElement!);
      range.setStartAfter(input);
      const rect = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
      return [rect(input.getBoundingClientRect()), rect(range.getBoundingClientRect())];
    });
    expect(Math.abs((box.y + box.height / 2) - (text.y + text.height / 2)), 'checkbox centred on its label line').toBeLessThan(6);
    expect(box.x + box.width, 'checkbox before its label').toBeLessThanOrEqual(text.x + 1);
    await expect(dialog).toContainText('The Lead writes the criteria and proofs.');
    await expect(dialog).not.toContainText(/\bmaster\b/i);
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth), 'no sideways scroll').toBe(0);
  });
}
