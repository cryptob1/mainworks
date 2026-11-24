import { test, expect } from '@playwright/test';

// GY-3595: the Mainworks logo is the works — a factory roof with one window lit, one file for every mark.

const roof = 'M12 50V24L26 34V24L40 34V24L54 34V50Z';
// GY-3707: a loaded trial host can take seconds to deliver the image; the mark is laid out (width/height set) before it loads.
const settled = { timeout: 15_000 };

test('e2e:logo-is-the-works — sign-in shows the Mainworks mark from /favicon.svg', async ({ page }) => {
  await page.goto('/?sign-in#work');
  const svg = await (await page.request.get('/favicon.svg')).text();
  expect(svg).toContain(roof);
  expect(svg).toContain('<title>Mainworks</title>');
  const mark = page.locator('.login .brand img');
  await expect(mark).toHaveAttribute('src', '/favicon.svg', settled);
  await expect.poll(() => mark.evaluate(node => (node as HTMLImageElement).naturalWidth), settled).toBeGreaterThan(0);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(mark).toBeVisible(settled);
    const box = await mark.evaluate(node => { const r = node.getBoundingClientRect(); return { w: r.width, h: r.height }; });
    expect(box.w, `mark width at ${width}px`).toBeGreaterThan(0);
    expect(box.h, `mark height at ${width}px`).toBeGreaterThan(0);
  }
});
