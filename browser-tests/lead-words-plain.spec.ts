import { test, expect, type Page } from '@playwright/test';
import { NOW, at, buildDemoState, demoAnswer } from '../scripts/docs-media-demo.mjs';
import { serveXterm } from './xterm';

// GY-3994: five docs/ux-findings.md rows on Lead and Settings at 390 and 1280 px:
//   1. Lead · Product: "Updated Nov 13 by the Lead." (not "by the master")
//   2. Lead · Decision card: agent wording in Why is folded behind a closed Why disclosure
//   3. Settings · Help: calls the planner the Lead everywhere, including inside every FAQ and Reference fold
//   4. Settings · Setup: un-onboarded repo says "<repo> is not onboarded yet" and "The Lead adds it" (no "Master fault")
//   5. Settings · Needs you: header summary is one plain sentence, not a five-sentence paragraph

const oldPlannerName = /(?<![-\w])master(?![-\w]|\.json| status)/i;

async function open(page: Page, width: number) {
  const state = buildDemoState('static');
  state.status = {
    ...state.status,
    serving: { onboarding: { onboarded: false, fault: 'The real serve or feature map is missing.' } },
  };
  await page.setViewportSize({ width, height: 900 });
  await page.clock.setFixedTime(new Date(NOW));
  await serveXterm(page);
  await page.routeWebSocket(/\/api\/terminal/, ws => {
    ws.send(JSON.stringify({ type: 'hello', mode: 'control', session: { account: 'lead-claude', runtime: 'claude', pane: '1', state: 'working', since: at(-6 * 60_000) } }));
  });
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice('/api/'.length);
    if (path === 'product-brief') {
      return route.fulfill({
        json: {
          brief: {
            markdown: '## Problem\n\nStorefront checkout needs to stay fast.\n',
            updatedAt: '2026-11-13T12:00:00Z',
            by: 'graphyard-master',
            history: [],
          },
        },
      });
    }
    return route.fulfill({ json: demoAnswer(state, path, url.searchParams) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('graphyard.theme', 'daylight');
    localStorage.setItem('graphyard-token', 'demo-token');
  });
  await page.goto('/#home');
  await expect(page.locator('[data-status-line]')).toBeVisible({ timeout: 15_000 });
}

async function noSidewaysScroll(page: Page, label: string, width: number) {
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways, `${label} has no sideways scroll at ${width} px`).toBe(0);
}

for (const width of [390, 1280]) {
  test(`e2e:lead-words-plain — the five Lead and Settings wording fixes hold at ${width} px`, async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, width);

    // 1. Lead · Product: says "by the Lead", never "by the master".
    await page.evaluate(() => { location.hash = 'product'; });
    await expect(page.getByRole('heading', { name: 'Product', level: 1 })).toBeVisible();
    await expect(page.locator('.page-fact')).toHaveText('Updated Nov 13 by the Lead.');
    await expect(page.getByRole('main')).not.toContainText(/by the master/i);
    await noSidewaysScroll(page, 'Lead · Product', width);

    // 2. Lead · Decision card: agent-wording Why is folded behind a closed disclosure by default.
    await page.evaluate(() => { location.hash = 'master'; });
    await expect(page.getByRole('heading', { name: 'Lead', level: 1 })).toBeVisible();
    const decisionCard = page.locator('article.lead-card.decision').filter({ hasText: 'Export monthly invoices as CSV' });
    await expect(decisionCard).toBeVisible();
    const whyFold = decisionCard.locator('details.lead-why');
    await expect(whyFold).toBeVisible();
    await expect(whyFold).not.toHaveAttribute('open', '');
    const primaryText = await decisionCard.innerText();
    expect(primaryText, 'agent wording stays out of the primary Decision card view').not.toContain('3 checkable criteria with bound tests');
    await whyFold.locator('summary').click();
    await expect(whyFold).toHaveAttribute('open', '');
    await expect(whyFold).toContainText('3 checkable criteria with bound tests');
    await noSidewaysScroll(page, 'Lead · Conversation', width);

    // 3. Settings · Help: calls the planner the Lead everywhere, including inside every FAQ and Reference fold.
    await page.evaluate(() => { location.hash = 'guide'; });
    await expect(page.getByRole('heading', { name: 'How Mainworks works', level: 1 })).toBeVisible();
    await page.evaluate(() => {
      document.querySelectorAll<HTMLDetailsElement>('article.guide details').forEach(fold => { fold.open = true; });
    });
    await expect(page.locator('article.guide')).toContainText('Setup prerequisites and options');
    await expect(page.locator('article.guide')).toContainText('graphyard-master-OWNER-NAME.service');
    const docsText = await page.locator('article.guide').innerText();
    expect(docsText).toContain('The Lead: keeps the brief, plans work and unsticks it.');
    const badMasterLines = docsText.split('\n').map(l => l.trim()).filter(l => oldPlannerName.test(l));
    expect(badMasterLines, `Help mentions the old planner name at ${width} px`).toEqual([]);
    await noSidewaysScroll(page, 'Settings · Help', width);

    // 4. Settings · Setup: un-onboarded repo uses plain Lead wording, never "Master fault".
    await page.evaluate(() => { location.hash = 'setup'; });
    const realApp = page.locator('[data-setup-item="real-app"]');
    await expect(realApp).toBeVisible();
    await expect(realApp).toContainText('acme/storefront is not onboarded yet');
    await expect(realApp).toContainText('The Lead adds it; nothing is needed from you.');
    await expect(realApp).not.toContainText(/Master fault|The master/i);
    await noSidewaysScroll(page, 'Settings · Setup', width);

    // 5. Settings · Needs you: header summary is one plain sentence, not a five-sentence paragraph.
    await page.evaluate(() => { location.hash = 'needs-you'; });
    await expect(page.getByRole('heading', { name: 'Needs you', level: 1 })).toBeVisible();
    const summary = page.locator('.page-heading .summary');
    await expect(summary).toHaveText('Only you decide goals and priorities, money and accounts, and sign-ins for people; the Lead decides the rest.');
    const sentences = (await summary.innerText()).split(/[.!?](?:\s|$)/).filter(part => /[a-z]{3}/i.test(part));
    expect(sentences.length, 'Needs you header summary is one sentence').toBe(1);
    await noSidewaysScroll(page, 'Settings · Needs you', width);
  });
}
