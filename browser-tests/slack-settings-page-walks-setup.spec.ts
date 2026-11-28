import { test, expect } from '@playwright/test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { stat, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { withDatabase } from '../tests/helpers/postgres';
import { temporaryDirectory } from '../tests/helpers/temp-dirs';
import { eventually, fakeSlack } from '../tests/helpers/fake-slack';
import { runSlackBridge, slackSettingsFile, syncSlackSetup } from '../src/master/slack';

const settled = { timeout: 15_000 };
const appToken = `xapp-1-${'a'.repeat(40)}`, botToken = `xoxb-1-${'b'.repeat(40)}`;

// GY-4073: Settings › Slack walks the owner from token entry to Connected against a stand-in Slack
// (Web API and Socket Mode) on 127.0.0.1: one wrong-token error line, the channel the bot was invited
// to, the people by name, the loop collecting the setup into the install directory and connecting,
// then the status line with the last message — at 1280 px and 390 px with no horizontal scroll.
test('e2e:slack-settings-page-walks-setup — Settings › Slack walks the owner from the manifest and tokens to Connected, with one wrong-token line, at 1280 and 390 px', async ({ browser }) => {
  test.setTimeout(120_000);
  const slack = await fakeSlack({ appToken, botToken, names: { UOWNER: 'Vish', UFRIEND: 'Ada' },
    channels: [{ id: 'C0FACTORY', name: 'factory', is_member: true }, { id: 'C0RANDOM', name: 'random', is_member: false }] });
  const site = await temporaryDirectory('slack-settings');
  await symlink(process.env.GRAPHYARD_BROWSER_DIST!, join(site, 'dist'));
  const directory = await temporaryDirectory('install', site);
  const database = await withDatabase('slack_settings_page'); await database.init();
  const child = fork(resolve('tests/helpers/terminal-server.ts'), [(database.pool.options as { connectionString: string }).connectionString, site], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, PATH: join(site, 'empty'), HOME: site, MAINWORKS_SLACK_API: slack.api },
  });
  const [{ url }] = await once(child, 'message') as [{ url: string }];
  const post = async (bearer: string, path: string, body: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<any>;
  };
  // The loop's pass, as master run makes it every 15 seconds, under the coordinator credential.
  const loopPass = () => syncSlackSetup(directory, (path, body) => post('test-coordinator', path, body));
  const stopping = new AbortController();
  let bridge: Promise<void> | null = null;
  try {
    const { code } = await post('test-human-operator', 'sign-in-links', {});
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${url}/#sign-in=${code}&slack`);
    const step = (name: string) => page.getByRole('listitem', { name });
    await expect(step('Create the Slack app')).toContainText('Not done', settled);
    await expect(step('Create the Slack app').getByRole('link', { name: 'api.slack.com/apps' })).toHaveAttribute('href', /api\.slack\.com\/apps/);
    await expect(step('Create the Slack app').getByRole('button', { name: 'Copy manifest' })).toBeVisible();

    // A bot token pasted where the app-level token goes: one line says exactly what to fix.
    await page.getByLabel(/App-level token/).fill(botToken);
    await page.getByLabel(/Bot token/).fill(botToken);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByRole('alert')).toHaveText('The app-level token starts with xapp-: find it under Basic Information › App-Level Tokens', settled);
    await expect(page.getByLabel(/App-level token/)).toHaveAttribute('type', 'password');

    await page.getByLabel(/App-level token/).fill(appToken);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByRole('status', { name: 'Slack result' })).toHaveText('Connected to Factory Team as @mainworks.', settled);
    await expect(page.getByLabel(/App-level token/)).toHaveValue('', { timeout: 1_000 });
    await expect(step('Paste the two tokens')).toContainText('Done');

    // Only the channel the bot was invited to is offered; people by name, the owner first.
    const channel = page.getByRole('combobox', { name: 'Channel', exact: true });
    await expect(channel.locator('option')).toHaveText(['Choose a channel', '#factory']);
    await channel.selectOption({ label: '#factory' });
    await page.getByRole('combobox', { name: 'You, the owner' }).selectOption({ label: 'Vish' });
    await page.getByRole('checkbox', { name: 'Ada' }).check();
    await page.getByRole('button', { name: 'Save and connect' }).click();
    await expect(page.getByRole('status', { name: 'Slack status' })).toHaveText('Waiting for the loop to connect…', settled);

    // The loop collects the setup into the install directory (mode 0600) and connects.
    await loopPass();
    expect((await stat(slackSettingsFile(directory))).mode & 0o777).toBe(0o600);
    bridge = runSlackBridge({ directory, api: slack.api, pollMs: 50, signal: stopping.signal, log: () => {}, mainworks: { get: async () => ({}), post: async () => ({}) } });
    await slack.connected();
    await eventually(async () => { await loopPass(); return (await fetch(`${url}/api/slack`, { headers: { Authorization: 'Bearer test-human-operator' } }).then(response => response.json())).loop?.connected; }, 'the loop reporting the connection');
    await expect(page.getByRole('status', { name: 'Slack status' })).toContainText('Connected to #factory, no message yet', settled);
    slack.message({ channel: 'C0FACTORY', user: 'UOWNER', text: 'hello Lead', ts: '1700000200.000100' });
    await eventually(async () => { await loopPass(); return (await fetch(`${url}/api/slack`, { headers: { Authorization: 'Bearer test-human-operator' } }).then(response => response.json())).loop?.lastMessageAt; }, 'the last message');
    await expect(page.getByRole('status', { name: 'Slack status' })).toContainText('Connected to #factory, last message 0 min ago', settled);
    for (const name of ['Create the Slack app', 'Paste the two tokens', 'Pick the channel', 'Choose who may talk to the Lead', 'Connected']) await expect(step(name)).toContainText('Done');
    await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth), 'no horizontal page scroll at 1280 px').toBe(true);
    await page.screenshot({ path: 'test-results/screenshots/after/slack-settings-1280.png', fullPage: true });
    await context.close();

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const small = await phone.newPage();
    await small.goto(`${url}/#sign-in=${(await post('test-human-operator', 'sign-in-links', {})).code}&slack`);
    await expect(small.getByRole('status', { name: 'Slack status' })).toContainText('Connected to #factory', settled);
    expect(await small.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth), 'no horizontal page scroll at 390 px').toBe(true);
    await small.screenshot({ path: 'test-results/screenshots/after/slack-settings-390.png', fullPage: true });
    await phone.close();
  } finally {
    stopping.abort(); await bridge;
    const ended = once(child, 'exit'); child.send('stop'); await ended; await database.close(); await slack.close();
  }
});
