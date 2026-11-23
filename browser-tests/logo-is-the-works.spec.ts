import { test, expect } from '@playwright/test';

// GY-3595: the Mainworks logo is the works — a factory roof with one window lit, one file for every mark.

const roof = 'M12 50V24L26 34V24L40 34V24L54 34V50Z';

test('e2e:logo-is-the-works — sign-in shows the Mainworks mark from /favicon.svg', async ({ page }) => {
  await page.goto('/?sign-in');
  const svg = await (await page.request.get('/favicon.svg')).text();
  expect(svg).toContain(roof);
  expect(svg).toContain('<title>Mainworks</title>');
  const mark = page.locator('.login .brand img');
  await expect(mark).toHaveAttribute('src', '/favicon.svg');
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(mark).toBeVisible();
    const box = await mark.evaluate(node => { const r = node.getBoundingClientRect(); return { w: r.width, h: r.height, loaded: (node as HTMLImageElement).naturalWidth }; });
    expect(box.w, `mark width at ${width}px`).toBeGreaterThan(0);
    expect(box.h, `mark height at ${width}px`).toBeGreaterThan(0);
    expect(box.loaded, `mark image loaded at ${width}px`).toBeGreaterThan(0);
  }
});
