import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { withDatabase } from '../tests/helpers/postgres';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { boardFromStatus } from '../src/model/board';
import { VERIFY_TIMEOUT_MS } from '../web/pages/login';

// e2e:home-since-last-visit — GY-3671: Home counts what changed since this person's own last visit,
// shows active goals and what is being built, and sends the box's text to the Lead. The visit and the
// message go to a real control plane; the status and work snapshots are seeded.

const token = 'test-human-operator';
const minute = 60_000, hour = 60 * minute;
const at = (ago: number) => new Date(Date.now() - ago).toISOString();
const item = (key: string, title: string, extra: Record<string, unknown> = {}) => ({ dependencies: [], scenarioRequirements: [], id: `fixture-${key}`, key, title, description: title, type: 'feature', priority: 2,
  stage: 'build', stageEnteredAt: at(10 * minute), createdAt: at(hour), ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, violations: [], workspaces: [], criteria: [], evidence: [], gates: [], sessions: [], lease: null, ...extra });
const merged = (key: string, title: string, mergedAt: string) => item(key, title, { stage: 'done', delivery: { mergedAt, mergeSha: key.replace(/\D/g, '').padStart(40, 'a') } });
const status = { actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, repository: 'fixture/repository', jobs: [], live: { commit: 'c'.repeat(40), waiting: ['GY-5'] } };
const spendRequest = (id: string, outcome: 'provided' | 'declined', answeredAt: string) => ({
  id, kind: 'money-or-accounts', reason: 'Spend check', needed: 'Approve spend', requestedBy: 'graphyard-claude-1', epoch: 1, at: answeredAt,
  answer: { by: 'operator', at: answeredAt, outcome, text: outcome === 'provided' ? 'Approved' : 'Declined', waitedMs: 1000 },
});

async function plane(page: Page, state: { work: unknown[]; actor?: unknown }) {
  const store = await withDatabase(`home_since_${randomUUID().slice(0, 8)}`);
  await store.init();
  const engine = new Engine(store, 120, 'fixture/repository');
  engine.gitRunner = null;
  const http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await page.route('**/api/**', async route => {
    const { pathname, search } = new URL(route.request().url());
    const now = new Date().toISOString();
    if (pathname.endsWith('/home-visit') || pathname.endsWith('/master/messages')) return route.fetch({ url: url + pathname + search }).then(response => route.fulfill({ response }));
    if (pathname.endsWith('/status')) return route.fulfill({ json: { ...status, actor: state.actor ?? status.actor, now } });
    if (pathname.endsWith('/work-snapshot')) return route.fulfill({ json: { work: state.work, now } });
    if (pathname.endsWith('/board')) return route.fulfill({ json: boardFromStatus(state.work as never, Date.parse(now), null) });
    return route.fulfill({ json: [] });
  });
  const messages = async () => (await (await fetch(`${url}/api/master/messages`, { headers: { authorization: `Bearer ${token}` } })).json()).messages as { text: string }[];
  return { messages, close: async () => { await page.unrouteAll(); await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); } };
}

async function visit(page: Page, first = false) {
  if (first) {
    await page.goto('/?sign-in#work');
    await page.getByLabel('Access token').fill(token);
    await page.getByRole('button', { name: 'Open control plane' }).click();
    // GY-3797: sign-in, reload, and /api/home-visit cross the 5 s expect default on a loaded gate host; allow what the page allows.
    await expect(page.locator('header.main-top-bar')).toBeVisible({ timeout: VERIFY_TIMEOUT_MS });
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home(\s+\d+)?$/ }).click();
  } else await page.reload();
  await expect(page).toHaveURL(/#home$/);
  await expect(page.getByRole('region', { name: 'Since you last looked' })).toBeVisible({ timeout: VERIFY_TIMEOUT_MS });
}
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('e2e:home-since-last-visit — the second visit counts exactly the merge in between, and the box tells the Lead', async ({ page }) => {
  test.setTimeout(120_000);
  const goal = 'Six merges an hour', other = item('GY-4', 'Batch trials', { stage: 'backlog', goal });
  const state: { work: unknown[]; actor?: unknown } = { work: [{ ...merged('GY-1', 'Earlier change', at(hour)), goal }, item('GY-2', 'Rows are one line', { goal, lease: { owner: 'graphyard-claude-1', epoch: 1, expiresAt: at(-hour) } }), other] as unknown[] };
  const { messages, close } = await plane(page, state);
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await visit(page, true);
    await expect(page.locator('[data-since="first"]')).toContainText('This is your first look.');

    // One live merge, one merge waiting on release, one Lead decision, and one approved + one declined spend request land between visits.
    const [earlier, building] = state.work as Record<string, unknown>[];
    const between = new Date().toISOString();
    state.work = [
      earlier,
      { ...building, lastRework: { reason: 'its trial failed on main', binding: null, at: between }, humanRequests: [spendRequest('req-1', 'provided', between), spendRequest('req-2', 'declined', between)] },
      other,
      merged('GY-3', 'Needs you leads with the question', between),
      merged('GY-5', 'Release check waits on live', between),
    ];
    await visit(page);
    const brief = page.getByRole('region', { name: 'Since you last looked' });
    await expect(brief.locator('[data-since-counts]')).toHaveText('1 went live · 1 in release · 1 Lead decision · 1 spend approval');
    await expect(brief).toContainText('Live: Needs you leads with the question.');
    await expect(brief).not.toContainText('Earlier change');
    const decision = brief.getByRole('listitem').filter({ hasText: 'The Lead sent “Rows are one line” back: its trial failed on main' });
    await expect(decision.getByRole('button', { name: 'Do it differently' })).toBeVisible();
    await decision.getByRole('button', { name: 'Ask why' }).click();
    const box = page.getByRole('textbox', { name: 'Tell the Lead' });
    await expect(box).toHaveValue('Why did you send “Rows are one line” back?');

    // Active goals with progress, what is being built now, and the box that sends its text to the Lead.
    await expect(page.getByRole('region', { name: 'Active goals' }).locator('[data-goal="Six merges an hour"]')).toHaveText('Six merges an hour 1 of 3 tasks shipped');
    await expect(page.locator('[data-building-now]')).toHaveText('Now: Rows are one line');
    for (const width of [390, 1280]) { await page.setViewportSize({ width, height: 900 }); expect(await noSideScroll(page)).toBe(true); }
    await box.fill('Prioritise the release check.');
    await page.getByRole('form', { name: 'Tell the Lead' }).getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('status')).toHaveText('Sent to the Lead.', { timeout: VERIFY_TIMEOUT_MS });
    expect((await messages()).map(m => m.text)).toEqual(['Prioritise the release check.']);

    // A signed-in teammate, whom the message route refuses, is offered no box and no decision buttons.
    state.actor = { id: 'teammate', role: 'reader', team: 'maintainer', sessionKind: 'human' };
    await visit(page);
    await expect(page.getByRole('form', { name: 'Tell the Lead' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ask why' })).toHaveCount(0);
  } finally {
    await close();
  }
});
