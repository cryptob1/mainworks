import { expect, type Page } from '@playwright/test';
import { NOW, at, buildDemoState, demoAnswer } from '../scripts/docs-media-demo.mjs';
import { serveXterm } from './xterm';

// GY-3962: a newcomer's four rules on Home, Work, a change and Lead (GY-3989: and Sign-in, Setup and the
// first-run steps), over the README's demo data
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
  // GY-3989: a newcomer's first screens need no terminal; a command waits in a fold.
  ['a terminal command', /\bmainworks [a-z]/],
];
// A line naming nothing (or nothing yet) is an empty or waiting state: it says what comes next.
const empty = /^(?:no|nothing|not yet|none)\b/i;
const next = /[;:—]|\b(?:when|once|until|next|will|shows? here|starts?|picks?)\b/i;

export async function read(page: Page) {
  return page.evaluate(() => ({ sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth, text: document.body.innerText }));
}

export function judge(name: string, { sideways, text }: { sideways: number; text: string }, width: number) {
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

export async function open(page: Page, phase: 'static' | 'empty' | 'setup', width: number) {
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

export const settle = async (page: Page) => {
  // Loading lines end in an ellipsis; the page is read once they have gone.
  await expect(page.getByRole('main')).not.toContainText(/(?:Reading|Loading)[^\n]*…/, { timeout: 15_000 });
  await page.waitForTimeout(300);
};
export const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name, exact: true }).click();
