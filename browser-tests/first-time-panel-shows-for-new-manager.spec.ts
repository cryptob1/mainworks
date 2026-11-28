import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { boardFromStatus } from '../src/model/board';
import { serveXterm } from './xterm';

// e2e:first-time-panel-shows-for-new-manager — GY-4066: a manager whose browser has not dismissed the day-one
// checklist sees it on Home, under the status line and the incident cards, with its exact copy; each page it
// names is a link that opens that page, and its guide line opens the owner's public guide in a new tab. It never
// shows on the first-run page. A full-page screenshot per width is kept for the product reviewer's look.

const hour = 3_600_000;
const at = (ago: number) => new Date(Date.now() - ago).toISOString();
/** The owner's public guide for new factory managers. */
const guide = 'https://claude.ai/artifact/WdyKuULnFYMx8qF5eTmFbg';
const merged = { dependencies: [], scenarioRequirements: [], id: 'fixture-GY-1', key: 'GY-1', title: 'Earlier change', description: 'Earlier change', type: 'feature', priority: 2,
  stage: 'done', stageEnteredAt: at(hour), createdAt: at(2 * hour), ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [], criteria: [], evidence: [], gates: [], sessions: [], lease: null,
  delivery: { mergedAt: at(hour), mergeSha: 'a'.repeat(40) } };
const owner = { id: 'operator', role: 'admin', sessionKind: 'human' };
const teammate = { id: 'teammate', role: 'reader', team: 'maintainer', sessionKind: 'human' };
const state: { work: unknown[]; actor: unknown } = { work: [merged], actor: owner };
// The release check wedged 28 hours is one incident card, so the checklist is read under a card.
const status = { actor: owner, repository: 'fixture/repository', jobs: [], releaseCheck: { since: at(28 * hour) } };
const shots = 'test-results/screenshots/first-time-panel';

/** The checklist's copy, exactly as GY-4066 wrote it. */
const copy = {
  heading: 'First time here?',
  intro: 'You set goals and answer what only you can. The Lead and its builders do the rest.',
  steps: [
    'Read the line at the top of Home. Moving is good; Slowed or Stopped shows a card with one button to press.',
    'Answer everything under Needs you. Press Review request; the recommended answer comes first.',
    'Open Work. The header shows merges per hour and the median time from review to live.',
    'Press the Stuck filter on Work. For any change stuck there, ask the Lead why on the Lead page.',
    'Open Lead, then Product. Check the product brief says what you want built.',
    'Type one goal with a number into Tell the Lead below, then press Send.',
    'Use your app for ten minutes and tell the Lead what felt wrong.',
  ],
  guide: `The full guide for new factory managers: ${guide}`,
};
/** Every page the copy names, in order: the link's text, where it goes, and the title of the page it opens. */
const pages: [string, string, string][] = [
  ['Home', '#home', 'Home'], ['Needs you', '#needs-you', 'Needs you'], ['Work', '#work', 'Work'], ['Work', '#work', 'Work'],
  ['Lead', '#lead', 'Lead'], ['Lead', '#lead', 'Lead'], ['Product', '#product', 'Product'],
];

const panel = (page: Page) => page.getByRole('region', { name: copy.heading, exact: true });
const home = (page: Page) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home(\s+\d+)?$/ }).click();
const homeShown = (page: Page) => expect(page.getByRole('heading', { name: 'Home', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });

/** Where the checklist sits: under the status line and every incident card, exactly as wide as the Home content, its steps in one column, the page not scrolling sideways. */
const laidOut = (page: Page) => page.evaluate(() => {
  const box = (element: Element) => element.getBoundingClientRect();
  const checklist = box(document.querySelector('[aria-label="First time here?"]')!), main = document.querySelector('main')!;
  const steps = [...document.querySelectorAll('[aria-label="First time here?"] li')].map(box);
  return {
    underStatus: checklist.top >= box(document.querySelector('[data-status-line]')!).bottom - 0.5,
    underIncidents: [...document.querySelectorAll('[data-incident]')].every(card => checklist.top >= box(card).bottom - 0.5),
    asWideAsHome: checklist.left >= box(main).left + parseFloat(getComputedStyle(main).paddingLeft) - 0.5
      && checklist.right <= box(main).right - parseFloat(getComputedStyle(main).paddingRight) + 0.5,
    oneColumn: steps.length === 7 && steps.every(step => step.left === steps[0].left && step.width === steps[0].width),
    sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});

test('e2e:first-time-panel-shows-for-new-manager — the checklist with its exact copy and working links at 1280 and 390 px, for a teammate too, and none on the first-run page', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await serveXterm(page); // the Lead page's xterm.js, served locally (GY-3357)
  await page.routeWebSocket(/\/api\/terminal/, () => {});
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url());
    const now = new Date().toISOString();
    if (pathname.endsWith('/status')) return route.fulfill({ json: { ...status, actor: state.actor, now } });
    if (pathname.endsWith('/work-snapshot')) return route.fulfill({ json: { work: state.work, now } });
    if (pathname.endsWith('/board')) return route.fulfill({ json: boardFromStatus(state.work as never, Date.parse(now), null) });
    return route.fulfill({ json: [] });
  });
  await page.goto('/?sign-in#home');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await homeShown(page);

  mkdirSync(shots, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const checklist = panel(page);
    await expect(checklist).toBeVisible();
    await expect(checklist.getByRole('heading', { level: 2 })).toHaveText(copy.heading);
    await expect(checklist.locator(':scope > p')).toHaveText([copy.intro, copy.guide]);
    await expect(checklist.getByRole('listitem')).toHaveText(copy.steps);
    await expect(checklist.getByRole('link')).toHaveText([...pages.map(([name]) => name), guide]);
    expect(await checklist.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual([...pages.map(([, href]) => href), guide]);
    // The page links stay in this tab; the guide line opens the public guide in a new one.
    expect(await checklist.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('target')))).toEqual([...pages.map(() => null), '_blank']);
    await expect(checklist.getByRole('button')).toHaveText(['Got it']);
    expect(await laidOut(page), `the checklist at ${width} px`).toEqual({ underStatus: true, underIncidents: true, asWideAsHome: true, oneColumn: true, sideways: 0 });
    const path = `${shots}/first-time-${width}.png`;
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`first-time-${width}`, { path, contentType: 'image/png' });
  }

  // Each named page is a link that opens that page.
  for (const [index, [name, href, title]] of pages.entries()) {
    await home(page);
    await panel(page).getByRole('link', { name, exact: true }).nth(pages.slice(0, index).filter(([earlier]) => earlier === name).length).click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.getByRole('heading', { name: title, level: 1, exact: true })).toBeVisible({ timeout: 15_000 });
  }

  // An install with no merged work opens on the first-run page, which shows no checklist.
  state.work = [];
  await page.goto('/#home');
  await expect(page.locator('[data-first-run-step]')).toBeVisible({ timeout: 15_000 });
  await expect(panel(page)).toHaveCount(0);

  // It shows to whoever has not dismissed it on this browser: a teammate sees the same checklist.
  state.actor = teammate; state.work = [merged];
  await page.reload();
  await homeShown(page);
  await expect(panel(page).getByRole('listitem')).toHaveText(copy.steps);

  // The owner's Home, with the Tell the Lead box step 6 names, is the page this case leaves open.
  state.actor = owner;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await homeShown(page);
  await expect(panel(page).getByRole('listitem')).toHaveText(copy.steps);
});
