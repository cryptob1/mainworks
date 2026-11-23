import { test, expect, type Page } from '@playwright/test';
import { NOW, boardApi } from './ui-board';

// GY-3560: Settings, Invite and the Product brief read plainly: no config instructions, no
// highlighter badges, rendered Markdown, and nothing scrolls sideways at 1280px or 390px.

const brief = { markdown: '# Mainworks\n\n## Problem\n\nShipping needs a coordinator.\n\n- a bullet\n- another bullet\n\n## Users\n\nThe owner.', updatedAt: new Date(NOW).toISOString(), history: [] };
const delivery = { previews: 'local', candidateMaxChanges: null, productionVerification: false, mode: 'local-compose', applications: [], cases: {} };
const app = { url: null, refused: null, missing: 'No app address set: add "app": { "url": "https://..." } to graphyard.json with the tailnet or public address teammates open', machine: 'vishrog', commit: null, deployedAt: null };
const guidance = 'Turn on Tailscale Funnel so the link opens outside your tailnet.';

async function open(page: Page) {
  await page.clock.setFixedTime(new Date(NOW));
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url()), path = url.pathname.slice('/api/'.length);
    if (path === 'product-brief') return route.fulfill({ json: { brief } });
    if (path === 'team-access') return route.fulfill({ json: { installUrl: null, public: false, hostSynced: false, publicLink: { on: true }, guidance, teammates: [] } });
    const json = boardApi(url.pathname.slice(1) + url.search) as any;
    return route.fulfill({ json: path === 'status' ? { ...json, app, project: { delivery }, setup: { ...json.setup, loop: true } } : json });
  });
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible();
}

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Pages in this section' });
async function openTab(page: Page, place: string, tab: string, heading: string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: new RegExp(`^${place}(\\s+\\d+)?$`) }).click();
  await tabs(page).getByRole('button', { name: tab, exact: true }).click();
  await expect(page.getByRole('main').getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}
async function fits(page: Page, label: string) {
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways, `${label} scrolls sideways`).toBe(0);
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) test(`e2e:settings-read-plainly — Settings, Invite and Product read plainly at ${viewport.width}px`, async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize(viewport);
  await open(page);
  const main = page.getByRole('main');

  // AC-3: Agents has one fold named Advanced and no link to the first-run checklist.
  await openTab(page, 'Settings', 'Agents', 'Agents');
  await expect(main.locator('summary').filter({ hasText: /^Advanced$/ })).toHaveCount(1);
  await expect(main.getByText('Open the first-run Setup checklist')).toHaveCount(0);
  await fits(page, 'Agents');

  // AC-2: Setup has no Done badge and no Coordinator; the loop step says Graphyard is handing out work.
  await openTab(page, 'Settings', 'Setup', 'Set up Mainworks');
  await expect(main.locator('[data-setup-item="master-loop"]')).toContainText('Graphyard is handing out work');
  const setup = await main.innerText();
  expect(setup).not.toMatch(/\bDone\b/);
  expect(setup).not.toContain('Coordinator');
  await fits(page, 'Setup');

  // AC-1: Delivery names no config file, no Mode row, and says there is no app to preview.
  await openTab(page, 'Settings', 'Delivery', 'Delivery');
  await expect(main.getByText('No app to preview yet.', { exact: true })).toBeVisible();
  const deliveryText = await main.innerText();
  for (const word of ['graphyard.json', 'delivery.applications']) expect(deliveryText).not.toContain(word);
  await expect(main.locator('dt', { hasText: /^Mode$/ })).toHaveCount(0);
  await fits(page, 'Delivery');

  for (const tab of ['Workers', 'Costs', 'Help']) {
    await tabs(page).getByRole('button', { name: tab, exact: true }).click();
    await expect(tabs(page).getByRole('button', { name: tab, exact: true })).toHaveAttribute('aria-current', 'page');
    await fits(page, tab);
  }

  // AC-4: Invite's first field is Name or email, and no Funnel or Tailscale text shows before Invite.
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite' });
  await expect(dialog.getByRole('heading', { name: 'Teammates' })).toBeVisible();
  await expect(dialog.locator('label').first()).toHaveText('Name or email');
  await expect(dialog.getByRole('textbox').first()).toHaveAccessibleName('Name or email');
  const invite = await dialog.innerText();
  expect(invite).not.toMatch(/funnel|tailscale/i);
  await fits(page, 'Invite');
  await dialog.getByRole('button', { name: 'Close Invite' }).click();

  // AC-5: the brief renders headings and list items; no visible line starts with '#' or '- '.
  await openTab(page, 'Lead', 'Product', 'Product');
  const article = main.locator('.product-brief');
  await expect(article.getByRole('heading', { name: 'Problem' })).toBeVisible();
  await expect(article.getByRole('listitem').filter({ hasText: 'a bullet' }).first()).toBeVisible();
  const lines = (await main.innerText()).split('\n').map(line => line.trim());
  expect(lines.filter(line => line.startsWith('#') || line.startsWith('- '))).toEqual([]);
  await fits(page, 'Product');
});
