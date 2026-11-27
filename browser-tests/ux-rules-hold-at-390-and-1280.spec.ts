import { test, expect, type Page } from '@playwright/test';
import { NOW, at, buildDemoState, demoAnswer } from '../scripts/docs-media-demo.mjs';
import { serveXterm } from './xterm';

// GY-3962: a newcomer's four rules on Home, Work, a change and Lead, over the README's demo data
// (scripts/docs-media-demo.mjs) at 390 and 1280 px:
//   1. no internal id, commit hash, model id or agent-to-agent phrase outside a Details area;
//   2. no sideways scroll;
//   3. no counter or status line twice on one page;
//   4. every empty or waiting state says what happens next, in one sentence.
// innerText leaves out a closed Details fold and a hidden tab, which is where internals belong.
const internal: [string, RegExp][] = [
  ['an internal id', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['a task key', /\b(?!AC-)[A-Z]{2,}-\d+\b/],
  ['a commit hash', /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/],
  ['a model id', /\b(?:claude|gpt|glm|gemini|opus|sonnet)-[a-z0-9.-]*\d/i],
  ['an agent account', /\b(?:builder|reviewer|lead|master|worker)-[a-z0-9]+\b/i],
  ['a proof id', /\b(?:unit|integration|e2e|manual):[a-z0-9-]+/i],
  ['agent-to-agent words', /\b(?:lease|epoch|dispatch|worktree|gate)s?\b/i],
];
// A line naming nothing (or nothing yet) is an empty or waiting state: it says what comes next.
const empty = /^(?:no|nothing|not yet|none)\b/i;
const next = /[;:—]|\b(?:when|once|until|next|will|shows? here|starts?|picks?)\b/i;

async function read(page: Page) {
  return page.evaluate(() => ({ sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth, text: document.body.innerText }));
}

function judge(name: string, { sideways, text }: { sideways: number; text: string }, width: number) {
  const found: string[] = [];
  if (sideways > 0) found.push(`${name}: scrolls sideways by ${sideways} px at ${width} px`);
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  for (const line of lines) for (const [what, pattern] of internal) if (pattern.test(line)) found.push(`${name}: ${what} in "${line}"`);
  // A counter or status line: a line with a number and a word. A bare time or count in a table cell is not one.
  const counters = lines.filter(line => /\d/.test(line) && /[a-z]{3}/i.test(line));
  for (const line of new Set(counters)) if (counters.filter(other => other === line).length > 1) found.push(`${name}: "${line}" shows twice`);
  for (const line of lines.filter(line => empty.test(line))) {
    if (!next.test(line)) found.push(`${name}: the empty state "${line}" does not say what happens next`);
    if (line.split(/[.!?](?:\s|$)/).filter(Boolean).length > 1) found.push(`${name}: the empty state "${line}" is more than one sentence`);
  }
  return found;
}

async function open(page: Page, phase: 'static' | 'empty', width: number) {
  const state = buildDemoState(phase);
  await page.setViewportSize({ width, height: 900 });
  await page.clock.setFixedTime(new Date(NOW));
  await serveXterm(page);
  await page.routeWebSocket(/\/api\/terminal/, ws => {
    ws.send(JSON.stringify({ type: 'hello', mode: 'control', session: { account: 'lead-claude', runtime: 'claude', pane: '1', state: 'working', since: at(-6 * 60_000) } }));
  });
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    return route.fulfill({ json: demoAnswer(state, url.pathname.slice('/api/'.length), url.searchParams) });
  });
  await page.addInitScript(() => { localStorage.setItem('graphyard.theme', 'daylight'); localStorage.setItem('graphyard-token', 'demo-token'); });
  await page.goto('/#home');
}

const settle = async (page: Page) => {
  // Loading lines end in an ellipsis; the page is read once they have gone.
  await expect(page.getByRole('main')).not.toContainText(/(?:Reading|Loading)[^\n]*…/, { timeout: 15_000 });
  await page.waitForTimeout(300);
};
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name, exact: true }).click();

for (const width of [390, 1280]) {
  test(`e2e:ux-rules-hold-at-390-and-1280 — Home, Work, a change and Lead keep the four newcomer rules at ${width} px`, async ({ page }) => {
    test.setTimeout(180_000);
    const found: string[] = [];
    await open(page, 'static', width);
    await expect(page.locator('[data-status-line]')).toBeVisible({ timeout: 15_000 });
    await settle(page);
    found.push(...judge('Home', await read(page), width));

    await nav(page, 'Work');
    await expect(page.locator('[data-work-header]')).toContainText('merges/hour');
    // The demo line is healthy: at least 3 merges an hour.
    expect(Number(/([\d.]+) merges\/hour/.exec(await page.locator('[data-work-header]').innerText())![1])).toBeGreaterThanOrEqual(3);
    await settle(page);
    found.push(...judge('Work', await read(page), width));

    await page.getByRole('link', { name: /Rate-limit the login endpoint/ }).click();
    await expect(page.getByRole('heading', { name: 'Rate-limit the login endpoint', level: 1 })).toBeVisible();
    // Details is the Details area; every other tab is a primary view.
    for (const tab of ['Checks and diff', 'Live session', 'Lead']) {
      await page.getByRole('tablist', { name: 'Task evidence' }).getByRole('tab', { name: tab, exact: true }).click();
      await settle(page);
      found.push(...judge(`Change · ${tab}`, await read(page), width));
    }

    await nav(page, 'Lead');
    await expect(page.getByRole('heading', { name: 'Lead', level: 1 })).toBeVisible();
    for (const tab of ['Conversation', 'Live session', 'History']) {
      await page.getByRole('tablist', { name: 'Lead views' }).getByRole('tab', { name: tab, exact: true }).click();
      await settle(page);
      found.push(...judge(`Lead · ${tab}`, await read(page), width));
    }
    await page.evaluate(() => { location.hash = 'product'; });
    await expect(page.getByRole('heading', { name: 'Product', level: 1 })).toBeVisible();
    await settle(page);
    found.push(...judge('Lead · Product', await read(page), width));
    expect(found, `newcomer rules at ${width} px`).toEqual([]);
  });

  test(`e2e:ux-rules-hold-at-390-and-1280 — a fresh install's empty Home, Work and Lead say what happens next at ${width} px`, async ({ page }) => {
    test.setTimeout(120_000);
    const found: string[] = [];
    await open(page, 'empty', width);
    await expect(page.getByRole('main')).toContainText(/\S/, { timeout: 15_000 });
    await settle(page);
    found.push(...judge('first-run Home', await read(page), width));
    await nav(page, 'Work');
    await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible();
    await settle(page);
    found.push(...judge('empty Work', await read(page), width));
    await nav(page, 'Lead');
    for (const tab of ['Conversation', 'History']) {
      await page.getByRole('tablist', { name: 'Lead views' }).getByRole('tab', { name: tab, exact: true }).click();
      await settle(page);
      found.push(...judge(`empty Lead · ${tab}`, await read(page), width));
    }
    expect(found, `empty states at ${width} px`).toEqual([]);
  });
}
