import { test, expect, type Browser, type Page } from '@playwright/test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
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
 * holds two typed messages, an open spend approval, a priority decision, a role pause, a filed item
 * and an open deployment incident, plus a Watch-role viewer and a Steer-role maintainer.
 */
test('e2e:lead-conversation — the Lead is a conversation of messages and cards you can act on, at 1280 and 390 px, for the operator, a Watch viewer and a Steer maintainer', async ({ browser }) => {
  test.setTimeout(420_000);
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
  const noPageScroll = async (page: Page, width: number) => {
    const scroll = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, client: document.documentElement.clientHeight, documentWidth: document.documentElement.scrollWidth, inner: innerWidth }));
    expect(scroll.height, `${width}px: the page does not scroll`).toBe(scroll.client);
    expect(scroll.documentWidth, `${width}px: the page does not scroll sideways`).toBe(scroll.inner);
  };

  let context: import('@playwright/test').BrowserContext | undefined;
  try {
    const { code } = await call('test-human-operator', 'sign-in-links', {});
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await serveXterm(context);
    const page = await context.newPage();
    await page.goto(`${url}/#sign-in=${code}&master`);
    const tablist = page.getByRole('tablist', { name: 'Lead views' });
    const conversation = page.getByRole('region', { name: 'Conversation with the Lead' });
    const rail = page.getByRole('complementary', { name: 'Lead context' });
    const entries = conversation.locator('.lead-entry');

    // AC-1: the page opens on the conversation; the four tabs, Conversation selected.
    await expect(page.getByRole('heading', { name: 'Lead', exact: true, level: 1 })).toBeVisible(settled);
    await expect(conversation).toBeVisible(settled);
    await expect(tablist.getByRole('tab', { name: 'Conversation' })).toHaveAttribute('aria-selected', 'true', settled);
    for (const name of ['Live session', 'History', 'Messages']) await expect(tablist.getByRole('tab', { name })).toBeVisible();

    // The seeded feed, in time order, newest at the bottom, with the sender's name on each message.
    await expect(entries).toHaveCount(9, settled);
    expect(await entries.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.kind))).toEqual(
      ['message', 'incident', 'task', 'task', 'approval', 'decision', 'decision', 'decision', 'message']);
    await expect(entries.nth(0)).toHaveAttribute('data-who', 'operator');
    await expect(entries.nth(0).locator('.lead-message')).toContainText(firstTyped);
    await expect(entries.nth(0).locator('.lead-name')).toHaveText('operator');
    await expect(entries.nth(8)).toHaveAttribute('data-who', 'steerer');
    await expect(entries.nth(8).locator('.lead-message')).toContainText(secondTyped);

    // The status line: what the Lead is doing, and for how long.
    await expect(page.locator('.lead-status')).toContainText('Lead is working', settled);
    await expect(page.locator('.lead-status')).toContainText(/· \d+m/, settled);

    // The side rail: goal order, what waits on you, who can steer.
    expect(await goalTitles(page)).toEqual(['Fix the flaky release check', 'Watch a worker']);
    await expect(rail.getByText('1 thing: spend approval')).toBeVisible();
    await expect(rail.locator('div').filter({ hasText: 'Who can steer' })).toContainText('You, steerer');

    // AC-2, approvals: the question, the wait in a number, the request's own verb-and-object choices.
    const approvalCard = entries.nth(4);
    await expect(approvalCard).toContainText('Needs your approval · spend');
    await expect(approvalCard).toContainText(spendAsk);
    await expect(approvalCard).toContainText(/Waiting \d+m/);
    await expect(approvalCard.getByRole('button', { name: 'Approve 2 more seats' })).toBeEnabled();
    await expect(approvalCard.getByRole('button', { name: 'Keep 9 accounts' })).toBeEnabled();

    // The Live session tab is the terminal one click away; History and Messages still work.
    await tablist.getByRole('tab', { name: 'Live session' }).click();
    await expect(page.getByRole('status')).toContainText('You can type here', settled);
    await expect(page.locator('.xterm-rows')).toContainText('screen of w1:master', settled);
    await tablist.getByRole('tab', { name: 'History' }).click();
    await expect(page.locator('.typed-input')).toContainText(firstTyped, settled);
    await tablist.getByRole('tab', { name: 'Messages' }).click();
    await expect(page.getByRole('article', { name: 'Thread with install-a' })).toContainText(crossInstall, settled);
    await tablist.getByRole('tab', { name: 'Conversation' }).click();
    await expect(conversation).toBeVisible(settled);

    // AC-3, the Watch role: the conversation and live session, no message box, disabled card buttons with the reason.
    const watcherPage = await openAs(browser, url, 'test-watch');
    await expect(watcherPage.getByRole('heading', { name: 'Lead', exact: true, level: 1 })).toBeVisible(settled);
    await expect(watcherPage.locator('#lead-message')).toHaveCount(0);
    const watcherDecision = watcherPage.locator('.lead-card.decision').first();
    await expect(watcherDecision.getByRole('button', { name: 'Ask why' })).toBeDisabled();
    await expect(watcherDecision).toContainText('You are watching: people who can steer the Lead may message and act.');
    // A Watch viewer still opens a filed task or an incident's Task, as the Goal order rail lets them.
    await expect(watcherPage.locator('.lead-card.incident').getByRole('button', { name: 'Open the Task' })).toBeEnabled();
    await expect(watcherPage.locator('.lead-card.task').first().locator('.lead-what').getByRole('button')).toBeEnabled();
    await watcherPage.getByRole('tab', { name: 'Live session' }).click();
    await expect(watcherPage.getByRole('status')).toContainText('View only', settled);
    await expect(watcherPage.locator('.xterm-rows')).toBeVisible(settled);
    await watcherPage.close();

    // AC-3, the Steer role: can message, cannot approve spend.
    const steerPage = await openAs(browser, url, 'test-steer');
    await expect(steerPage.locator('#lead-message')).toBeVisible(settled);
    await expect(steerPage.locator('.lead-card.approval').getByRole('button', { name: 'Approve 2 more seats' })).toBeDisabled();
    await expect(steerPage.locator('.lead-card.approval')).toContainText('Only the human operator answers a human-only request');
    // A Steer maintainer sees why a pause's Undo is not theirs — never the Watch note.
    const steerPause = steerPage.locator('.lead-card.decision').filter({ hasText: 'The worker role paused' });
    await expect(steerPause.getByRole('button', { name: 'Undo' })).toBeDisabled();
    await expect(steerPause).toContainText('Only the operator can undo a hold or a pause.');
    await expect(steerPause).not.toContainText('You are watching');
    await steerPage.getByRole('tab', { name: 'Live session' }).click();
    await expect(steerPage.getByRole('status')).toContainText('You can type here', settled);
    await steerPage.close();

    // AC-2: the choice answers in place as the signed-in person.
    await approvalCard.getByRole('button', { name: 'Approve 2 more seats' }).click();
    await expect(conversation.getByText(spendAsk)).toHaveCount(0, settled);
    await expect(rail.getByText('Nothing waits on you.')).toBeVisible(settled);
    const parked = await call('test-human-operator', `work/${items.watch}`);
    expect(parked.humanRequests.at(-1).answer).toMatchObject({ by: 'operator', outcome: 'provided' });
    expect(parked.humanRequests.at(-1).answer.choice.id).toBe('approve-2');

    // AC-2, decisions: reversible kinds undo through the reversing command.
    const priorityCard = conversation.locator('.lead-card.decision').filter({ hasText: 'moved to P0' });
    await expect(priorityCard).toContainText('Why: the release fix outranks new pages.');
    await priorityCard.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => goalTitles(page), { timeout: 20_000 }).toEqual(['Watch a worker', 'Fix the flaky release check']);
    expect((await call('test-human-operator', `work/${items.fix}`)).priority).toBe(2);
    await expect(conversation.locator('.lead-card.decision').filter({ hasText: 'The worker role paused' }).getByRole('button', { name: 'Undo' })).toBeEnabled(settled);
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
    await taskCard.locator('.lead-what').getByRole('button', { name: 'Fix the flaky release check' }).click();
    await expect(page.getByRole('heading', { name: /Fix the flaky release check/ })).toBeVisible(settled);
    await page.getByRole('button', { name: '← Back' }).click();
    await expect(conversation).toBeVisible(settled);

    // The message box sends by typing into the Lead pane, as people always have.
    await expect(page.getByRole('button', { name: 'Attach an image' })).toBeVisible();
    // A screenshot pasted into the message box is attached to the Lead, not dropped.
    await page.locator('#lead-message').evaluate(input => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'shot.png', { type: 'image/png' }));
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    const paneInput = async () => (await readFile(join(site, 'herdr.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(entry => JSON.parse(entry)).filter(entry => entry.command?.type === 'terminal.input').map(entry => entry.command.text as string).join('');
    await expect.poll(paneInput, settled).toMatch(/\x1b\[200~[^\x1b]*master-inbox[^\x1b]*shot\.png\x1b\[201~/);
    await page.locator('#lead-message').fill(sentLine);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => page.locator('#lead-message').inputValue(), { timeout: 15_000 }).toBe('');
    await expect.poll(async () => (await conversation.locator('.lead-entry[data-who="operator"]').allInnerTexts()).join('\n'), { timeout: 20_000 }).toContain(sentLine);
    const read = await (await fetch(`${url}/api/typed-input`, { headers: { Authorization: 'Bearer test-human-operator' } })).json() as { typed: { who: string; text: string }[] };
    expect(read.typed.some(entry => entry.who === 'operator' && entry.text === sentLine), 'the sent line was typed into the pane and recorded').toBe(true);

    // The page never scrolls; the conversation scrolls inside its panel.
    await noPageScroll(page, 1280);
    const panel = await conversation.locator('.lead-feed').evaluate(element => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
    expect(panel.scrollHeight, 'the conversation holds its own scroll').toBeGreaterThanOrEqual(panel.clientHeight);

    // The same page at 390 px: the four tabs still there, the feed still ordered, still no page scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(tablist.getByRole('tab', { name: 'Conversation' })).toHaveAttribute('aria-selected', 'true', settled);
    for (const name of ['Live session', 'History', 'Messages']) await expect(tablist.getByRole('tab', { name })).toBeVisible();
    const texts = await entries.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).innerText));
    const firstAt = texts.findIndex(text => text.includes(firstTyped)), incidentAt = texts.findIndex(text => text.includes('not live yet')),
      decisionAt = texts.findIndex(text => text.includes('moved to P0')), sentAt = texts.findLastIndex(text => text.includes(sentLine));
    expect([firstAt, incidentAt, decisionAt, sentAt].every(index => index >= 0), 'the entries the order check names are present').toBe(true);
    expect(firstAt, 'a message precedes the incident card').toBeLessThan(incidentAt);
    expect(incidentAt, 'the incident precedes the decision card').toBeLessThan(decisionAt);
    expect(decisionAt, 'the decision precedes the message just sent').toBeLessThan(sentAt);
    await expect(page.locator('.lead-status')).toContainText('Lead is working', settled);
    await expect(page.getByRole('button', { name: 'Attach an image' })).toBeVisible();
    await noPageScroll(page, 390);
    const narrow = await conversation.locator('.lead-feed').evaluate(element => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
    expect(narrow.scrollHeight, 'the conversation holds its own scroll at 390 px').toBeGreaterThanOrEqual(narrow.clientHeight);

    await context!.close();
  } finally {
    for (const open of context?.pages() ?? []) await open.close().catch(() => {});
    await context?.close().catch(() => {});
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
