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

  // AC-2: Setup has no Done badge and no Coordinator; the loop step says Mainworks is handing out work.
  await openTab(page, 'Settings', 'Setup', 'Set up Mainworks');
  await expect(main.locator('[data-setup-item="master-loop"]')).toContainText('Mainworks is handing out work');
  const setup = await main.innerText();
  expect(setup).not.toMatch(/\bDone\b/);
  expect(setup).not.toContain('Coordinator');
  await fits(page, 'Setup');

  // AC-1: Delivery shows no delivery.applications text and no Mode row, and says there is no app to preview;
  // Where it runs still names the one setting to add (e2e:where-it-runs).
  await openTab(page, 'Settings', 'Delivery', 'Delivery');
  await expect(main.getByText('No app to preview yet.', { exact: true })).toBeVisible();
  const deliveryText = await main.innerText();
  expect(deliveryText).not.toContain('delivery.applications');
  await expect(main.locator('[data-app-missing]')).toContainText('graphyard.json');
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

// GY-3995: Settings clears its loading lines and shows no task keys or terminal-only steps, over an
// install whose reads come back with nothing to show: no project delivery, no stall-alert word from
// the loop, no owner, nothing to price and no test case yet; the agents read is slow.
async function openSparse(page: Page) {
  await page.clock.setFixedTime(new Date(NOW));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname.slice('/api/'.length);
    if (path === 'costs') return route.fulfill({ json: {} });
    if (path === 'tests') return route.fulfill({ json: { window: 20, cases: [] } });
    if (path === 'agent-registry') await new Promise(done => setTimeout(done, 2_000));
    const json = boardApi(url.pathname.slice(1) + url.search) as any;
    if (path !== 'status') return route.fulfill({ json });
    const { project: _project, ...status } = json;
    return route.fulfill({ json: { ...status, owner: null, setup: { ...json.setup, loop: true, alerts: null } } });
  });
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible();
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) test(`e2e:settings-read-plainly — Settings clears its loading lines and shows no task keys or terminal-only steps at ${viewport.width}px`, async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize(viewport);
  await openSparse(page);
  const main = page.getByRole('main');

  // Agents: while the read is out, one line says so, not 'Reading the agents…' and 'Loading the agents…' at once.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Settings(\s+\d+)?$/ }).click();
  await tabs(page).getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(main).toContainText('Reading the agents…');
  expect((await main.innerText()).match(/(?:Reading|Loading) the agents…/g)).toHaveLength(1);
  await expect(main).not.toContainText('Reading the agents…', { timeout: 10_000 });
  await fits(page, 'Agents');

  // Workers: each session row names its task by title, with no task key above it.
  await openTab(page, 'Settings', 'Workers', 'Workers');
  const working = main.locator('table.workers td[data-label="Working on"]');
  await expect(working.first()).toBeVisible();
  for (const cell of await working.allInnerTexts()) expect(cell).not.toMatch(/\b[A-Z]{2,}-\d+\b/);
  await fits(page, 'Workers');

  // Costs: a read with nothing to price ends the reading line and says what comes next.
  await openTab(page, 'Settings', 'Costs', 'Costs');
  await expect(main).toContainText('Nothing spent yet: costs show once a session reports its usage.');
  await expect(main).not.toContainText('Reading costs…');
  await fits(page, 'Costs');

  // Setup: the stall-alert line says when it will know, not 'not known yet'.
  await openTab(page, 'Settings', 'Setup', 'Set up Mainworks');
  await expect(main.getByRole('region', { name: 'Be told when work stops' })).toContainText('Stall alerts show here once the loop reports them.');
  await expect(main.locator('[data-alerts]')).not.toContainText('not known yet');
  await fits(page, 'Setup');

  // Delivery: no loading line above the settings it shows, and the owner is named here, not by a terminal command.
  await openTab(page, 'Settings', 'Delivery', 'Delivery');
  await expect(main).toContainText('Delivery settings show here once the control plane reports them.');
  await expect(main).not.toContainText('Reading the delivery settings…');
  const identity = main.getByRole('region', { name: 'Identity' });
  await expect(identity).toContainText('Commits are authored Mainworks: name the owner below.');
  await expect(identity.getByRole('form', { name: 'Name the owner' }).getByRole('button', { name: 'Name the owner' })).toBeVisible();
  await expect(main).not.toContainText('config owner');
  await fits(page, 'Delivery');

  // Tests (empty): the next step is the page's own Define test cases, with the repository commands folded away.
  await page.evaluate(() => { location.hash = 'tests'; });
  await expect(main.getByRole('heading', { name: 'Tests', level: 1 })).toBeVisible();
  await expect(main).toContainText('Add the first one with Define test cases; its runs show here.');
  await expect(main.getByRole('button', { name: 'Define test cases' })).toBeVisible();
  await expect(main.getByText('mainworks e2e sync')).toBeHidden();
  await fits(page, 'Tests');
});
