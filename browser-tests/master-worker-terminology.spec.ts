import { test, expect } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';
import { boardStatus, boardWork, NOW } from './ui-board';
import { serveXterm } from './xterm';

// GY-3307, GY-3602: the dashboard names the master agent's page Lead everywhere — the navigation,
// the Lead page's heading and its accessible controls — and the agents page stays
// Workers. Chief labels fail this proof.
test('e2e:master-worker-terminology — navigation, the Lead heading and its accessible controls say Lead, and Workers stays Workers', async ({ page }) => {
  const work = boardWork();
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) return route.fulfill({ json: boardStatus('admin') });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work, now: new Date(NOW).toISOString() } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(work, NOW, null) });
    return route.fulfill({ json: [] });
  });
  await serveXterm(page); // the Lead page's xterm.js, served locally (GY-3357)
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();

  const menu = page.getByRole('navigation', { name: 'Main' }).getByRole('link');
  await expect(menu).toHaveText(['Home', 'Work', /^Lead/, 'Settings']);

  // GY-3598, GY-3602: the master lives under Lead; its heading and its conversation region say Lead.
  await menu.nth(2).click();
  await expect(page.getByRole('heading', { name: 'Lead', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Conversation with the Lead' })).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Pages in this section' }).getByRole('button');
  await expect(tabs).toHaveText(['Lead', 'Product']);

  // Workers remains Workers: its own tab under Settings and its own heading.
  await menu.nth(3).click();
  await tabs.filter({ hasText: /^Workers$/ }).click();
  await expect(page.getByRole('heading', { name: 'Workers', exact: true, level: 1 })).toBeVisible();

  // Nothing on the board says Chief.
  await expect(page.getByText(/chief/i)).toHaveCount(0);
});
