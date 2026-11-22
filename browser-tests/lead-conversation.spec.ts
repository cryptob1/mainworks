import { test, expect, type Browser, type Page } from '@playwright/test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { signInDatabase } from '../tests/helpers/sign-in-database';
import { serveXterm } from './xterm';

const settled = { timeout: 15_000 };
const spendAsk = 'Approve 2 more agent seats so more builders can work — same plan, 2 more seats.';
const firstTyped = 'Why has nothing gone live since this afternoon?';
const secondTyped = 'The staging deploy looks fine from here.';
const sentLine = 'Restart the release check now, please.';
const crossInstall = 'Cross-install note for the Lead conversation.';

/**
 * e2e:lead-conversation (GY-3602): the Lead page opens on a conversation — messages people typed
 * and the Lead's cards in time order, a status line, a message box, a side rail and the four tabs —
 * against the real control plane serving the built dashboard with a stub herdr Lead pane. The world
 * holds two typed messages, a spend approval, a priority decision, a role pause, a filed item and
 * an open deployment incident, plus a Watch-role viewer and a Steer-role maintainer.
 */
test('e2e:lead-conversation — the Lead is a conversation of messages and cards you can act on, at 1280 and 390 px, for the operator, a Watch viewer and a Steer maintainer', async ({ browser }) => {
  test.setTimeout(240_000);
  const database = await signInDatabase();
  const site = await mkdtemp(join(tmpdir(), 'graphyard-lead-conversation-'));
  await symlink(resolve('.graphyard/browser-dist'), join(site, 'dist'));
  const child = fork(resolve('tests/helpers/lead-conversation-server.ts'), [database.url, site], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, PATH: `${resolve('fixtures/herdr-terminal-stub')}${delimiter}${process.env.PATH}`, HERDR_STUB_LOG: join(site, 'herdr.log'), HERDR_STUB_STATE: join(site, 'master.daemon.json'), GRAPHYARD_HERDR_CONFIG_HOME: '', GRAPHYARD_HERDR_SESSION: '' } });
  const [{ url, items }] = await once(child, 'message') as [{ url: string; items: { watch: string; fix: string; fixKey: string } }];
  const call = async (bearer: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<any>;
  };
  const goalTitles = (page: Page) => page.locator('.lead-rail li').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).innerText.replace(/^GY-\d+\s*/, '').trim()));

  try {
    for (const width of [1280, 390] as const) {
      const { code } = await call('test-human-operator', 'sign-in-links', {});
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
      await serveXterm(context);
      const page = await context.newPage();
      await page.goto(`${url}/#sign-in=${code}&master`);
      await expect(page.getByRole('heading', { name: 'Lead', exact: true, level: 1 })).toBeVisible(settled);
      const tablist = page.getByRole('tablist', { name: 'Lead views' });
      const conversation = page.getByRole('region', { name: 'Conversation with the Lead' });
      const rail = page.getByRole('complementary', { name: 'Lead context' });
      await expect(conversation).toBeVisible(settled);

      // AC-1: the four tabs, Conversation first; the status line; the rail; messages with names.
      await expect(tablist.getByRole('tab', { name: 'Conversation' })).toHaveAttribute('aria-selected', 'true', settled);
      for (const name of ['Live session', 'History', 'Messages']) await expect(tablist.getByRole('tab', { name })).toBeVisible();
      const status = await page.locator('.lead-status').innerText();
      expect(status).toContain('Lead is working');
      expect(status).toMatch(/· \d+m/);
      await expect(rail.locator('div').filter({ hasText: 'Who can steer' })).toContainText('You, steerer');
      await expect(conversation.locator('.lead-entry[data-who="operator"]').first()).toContainText(firstTyped);
      await expect(conversation.locator('.lead-entry[data-who="steerer"]')).toContainText(secondTyped);
      await expect(conversation.locator('.lead-entry[data-who="operator"]').first().locator('.lead-name')).toHaveText('operator');

      // The Live session tab is the terminal one click away; History and Messages still work.
      await tablist.getByRole('tab', { name: 'Live session' }).click();
      await expect(page.getByRole('status')).toContainText('You can type here', settled);
      await expect(page.locator('.xterm-rows')).toContainText('screen of w1:master', settled);
      await tablist.getByRole('tab', { name: 'History' }).click();
      await expect(page.locator('.typed-input')).toContainText(firstTyped, settled);
      await tablist.getByRole('tab', { name: 'Messages' }).click();
      await expect(page.getByRole('article', { name: 'Thread with install-a' })).toContainText(crossInstall, settled);
      await tablist.getByRole('tab', { name: 'Conversation' }).click();

      // The page never scrolls; the conversation scrolls inside its panel.
      const scroll = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, client: document.documentElement.clientHeight, width: document.documentElement.scrollWidth, inner: innerWidth }));
      expect(scroll.height, `${width}px: the page does not scroll`).toBe(scroll.client);
      expect(scroll.width, `${width}px: the page does not scroll sideways`).toBe(scroll.inner);
      const panel = await conversation.locator('.lead-feed').evaluate(element => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
      expect(panel.scrollHeight, `${width}px: the conversation holds its own scroll`).toBeGreaterThanOrEqual(panel.clientHeight);

      if (width === 1280) {
        // The seeded order, newest last.
        const entries = conversation.locator('.lead-entry');
        await expect(entries).toHaveCount(9, settled);
        expect(await entries.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.kind))).toEqual(
          ['message', 'incident', 'task', 'task', 'approval', 'decision', 'decision', 'decision', 'message']);

        // AC-2, approvals: the question, the wait in a number, the request's own verb-and-object choices.
        const approvalCard = entries.nth(4);
        await expect(approvalCard).toContainText('Needs your approval · spend');
        await expect(approvalCard).toContainText(spendAsk);
        await expect(approvalCard).toContainText(/Waiting \d+m/);
        await expect(approvalCard.getByRole('button', { name: 'Approve 2 more seats' })).toBeEnabled();
        await expect(approvalCard.getByRole('button', { name: 'Keep 9 accounts' })).toBeEnabled();

        // AC-3, the Watch role: the conversation and live session, no message box, disabled card buttons with the reason.
        const watcherPage = await openAs(browser, url, 'test-watch');
        await expect(watcherPage.getByRole('heading', { name: 'Lead', exact: true, level: 1 })).toBeVisible(settled);
        await expect(watcherPage.locator('#lead-message')).toHaveCount(0);
        const watcherDecision = watcherPage.locator('.lead-card.decision').first();
        await expect(watcherDecision.getByRole('button', { name: 'Ask why' })).toBeDisabled();
        await expect(watcherDecision).toContainText('You are watching: people who can steer the Lead may message and act.');
        await watcherPage.getByRole('tab', { name: 'Live session' }).click();
        await expect(watcherPage.getByRole('status')).toContainText('View only', settled);
        await expect(watcherPage.locator('.xterm-rows')).toBeVisible(settled);
        await watcherPage.close();

        // AC-3, the Steer role: can message, cannot approve spend.
        const steerPage = await openAs(browser, url, 'test-steer');
        await expect(steerPage.locator('#lead-message')).toBeVisible(settled);
        await expect(steerPage.locator('.lead-card.approval').getByRole('button', { name: 'Approve 2 more seats' })).toBeDisabled();
        await expect(steerPage.locator('.lead-card.approval')).toContainText('Only the human operator answers a human-only request');
        await steerPage.getByRole('tab', { name: 'Live session' }).click();
        await expect(steerPage.getByRole('status')).toContainText('You can type here', settled);
        await steerPage.close();

        // AC-2: the choice answers in place as the signed-in person.
        await approvalCard.getByRole('button', { name: 'Approve 2 more seats' }).click();
        await expect(conversation.getByText(spendAsk)).toHaveCount(0, settled);
        await expect(rail.getByText('Nothing waits on you.')).toBeVisible(settled);
        const parked = await call('test-human-operator', `work/${items.watch}`);
        expect(parked.humanRequests.at(-1).answer).toMatchObject({ by: 'operator', outcome: 'provided' });
        expect(parked.humanRequests.at(-1).answer.choice).toBe('approve-2');

        // AC-2, decisions: reversible kinds undo through the reversing command.
        expect(await goalTitles(page)).toEqual(['Fix the flaky release check', 'Watch a worker']);
        const priorityCard = conversation.locator('.lead-card.decision').filter({ hasText: 'moved to P0' });
        await expect(priorityCard).toContainText('Why: the release fix outranks new pages.');
        await priorityCard.getByRole('button', { name: 'Undo' }).click();
        await expect.poll(() => goalTitles(page), { timeout: 10_000 }).toEqual(['Watch a worker', 'Fix the flaky release check']);
        expect((await call('test-human-operator', `work/${items.fix}`)).priority).toBe(2);
        const pauseCard = conversation.locator('.lead-card.decision').filter({ hasText: 'The worker role paused' });
        await expect(pauseCard.getByRole('button', { name: 'Undo' })).toBeEnabled();
        // AC-2: a decision that is not a priority change, a hold or a pause shows no Undo.
        const messageCard = conversation.locator('.lead-card.decision').filter({ hasText: "'s builder" });
        await expect(messageCard.getByRole('button', { name: 'Undo' })).toHaveCount(0);
        await messageCard.getByRole('button', { name: 'Ask why' }).click();
        await expect(page.locator('#lead-message')).toHaveValue(/Why: Messaged/);

        // The incident card: what broke, impact, what is being done, whether you are needed.
        const incidentCard = conversation.locator('.lead-card.incident');
        await expect(incidentCard).toContainText(`${items.fixKey} is not live yet`);
        await expect(incidentCard).toContainText('merged 2h ago and still not served');
        await expect(incidentCard).toContainText('The Lead keeps the release line moving; you are not needed.');

        // The filed task card's title links to its Task page.
        const taskCard = conversation.locator('.lead-card.task').filter({ hasText: 'Fix the flaky release check' });
        await taskCard.getByRole('button', { name: 'Open the Task' }).click();
        await expect(page.getByRole('heading', { name: /Fix the flaky release check/ })).toBeVisible(settled);
        await page.getByRole('button', { name: '← Back' }).click();
        await expect(conversation).toBeVisible(settled);

        // The message box sends by typing into the Lead pane, as people always have.
        await expect(page.getByRole('button', { name: 'Attach an image' })).toBeVisible();
        await page.locator('#lead-message').fill(sentLine);
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await expect.poll(() => page.locator('#lead-message').inputValue(), { timeout: 10_000 }).toBe('');
        await expect.poll(async () => conversation.locator('.lead-entry[data-who="operator"]').allInnerTexts(), { timeout: 20_000 }).toContain(expect.stringContaining(sentLine));
        const read = await (await fetch(`${url}/api/typed-input`, { headers: { Authorization: 'Bearer test-human-operator' } })).json() as { typed: { who: string; text: string }[] };
        expect(read.typed.some(entry => entry.who === 'operator' && entry.text === sentLine), 'the sent line was typed into the pane and recorded').toBe(true);
      } else {
        await expect(page.getByRole('button', { name: 'Attach an image' })).toBeVisible();
        await expect(page.locator('#lead-message')).toBeVisible();
      }

      await context.close();
    }
  } finally {
    const ended = once(child, 'exit'); child.send('stop'); await ended;
    await database.close(); await rm(site, { recursive: true, force: true });
  }
});

/** A page signed in as one fixed token, as an invited teammate's saved session reads. */
async function openAs(browser: Browser, url: string, token: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await serveXterm(context);
  const page = await context.newPage();
  await page.addInitScript(value => sessionStorage.setItem('graphyard-token', value), token);
  await page.goto(`${url}/#master`);
  return page;
}
