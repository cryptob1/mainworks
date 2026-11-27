import { test, expect, type Page } from '@playwright/test';
import { NOW, boardApi } from './ui-board';

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
