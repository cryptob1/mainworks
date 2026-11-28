import { test, expect } from '@playwright/test';
import { fixture } from '../../browser-tests/human-decisions-fixture';

// GY-4088: the sign-in page's install-name read (GET /api/sign-in, GY-4072) and the link's redemption
// (POST /api/sign-in) race. Hold the redemption until the read is routed, so the read lands first;
// the fixture must still record only the redemption.
test('the install-name read is not taken for the sign-in redemption', async ({ page }) => {
  const posted = await fixture(page);
  let installRead!: () => void;
  const read = new Promise<void>(resolve => { installRead = resolve; });
  await page.route('**/api/sign-in', async route => { if (route.request().method() === 'GET') installRead(); else await read; return route.fallback(); });
  await page.goto('/#sign-in=one-time-code-from-mainworks-login&work');
  await expect(page.getByRole('button', { name: 'Every request and answer →' })).toBeVisible();
  expect(posted).toEqual([{ path: '/api/sign-in', body: { code: 'one-time-code-from-mainworks-login' } }]);
});
