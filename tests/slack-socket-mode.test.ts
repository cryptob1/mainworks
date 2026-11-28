import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import type { Store } from '../src/store.js';
import { slackCommand } from '../src/cli/master/slack.js';
import { runSlackBridge, slackAlertsOn, slackSettingsFile } from '../src/master/slack.js';
import { messageCauses } from '../src/daemon/master-stalled-delivery.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { listen } from './helpers/http-server.js';
import { apiOk } from './helpers/api.js';
import { lifecycle } from './helpers/work-lifecycle.js';
import { eventually, fakeSlack } from './helpers/fake-slack.js';

// GY-4073: one Socket Mode Slack app per factory. The loop dials out to Slack (here a stand-in on
// 127.0.0.1); a message in the bound channel from an allowed person becomes a Lead message exactly
// as 'Tell the Lead' does, the Lead's reply posts back in that thread, and Needs you posts with buttons.
const closers: (() => Promise<void>)[] = [];
after(async () => { for (const close of closers.reverse()) await close(); });

const appToken = `xapp-1-${'a'.repeat(40)}`, botToken = `xoxb-1-${'b'.repeat(40)}`;
const token = (principal: Principal) => `${principal.id}-token-${'x'.repeat(32)}`;

test('integration:slack-socket-mode-instruction-round-trip — connect stores tokens 0600 silently; an allowed message becomes a Lead instruction answered in thread; a non-allowed one is ignored with one line; a reserved decision goes to Needs you with buttons only the owner may answer', async () => {
  const loop: Principal = { id: 'factory-loop', role: 'coordinator' };
  const owner: Principal = { id: 'owner', role: 'admin', sessionKind: 'human' };
  const worker: Principal = { id: 'worker', role: 'worker', sessionKind: 'ai' };
  const store: Store = await withDatabase('slack_socket_mode'); await store.init();
  const engine = new Engine(store, 120, 'owner/factory');
  engine.gitRunner = null;
  const plane = await listen(server(engine, [loop, owner, worker].map(principal => ({ ...principal, token: token(principal) }))));
  closers.push(async () => { await plane.close(); await store.close(); });
  const as = (principal: Principal) => (path: string, body?: unknown, key?: string) => apiOk(plane.url, token(principal), path, { body, key });
  const coordinator = as(loop);

  // 1. Connect: both tokens on stdin, the channel and the owner's Slack id as arguments; nothing printed.
  const directory = await temporaryDirectory('slack-install');
  const printed: unknown[] = [];
  const log = console.log;
  console.log = (...values: unknown[]) => { printed.push(values); };
  try {
    await slackCommand(['connect', 'C0FACTORY', 'UOWNER'], directory, async () => `${appToken}\n${botToken}\n`);
  } finally { console.log = log; }
  assert.deepEqual(printed, [], 'connect prints nothing');
  assert.equal((await stat(slackSettingsFile(directory))).mode & 0o777, 0o600, 'the tokens are stored with mode 0600');
  const stored = JSON.parse(await readFile(slackSettingsFile(directory), 'utf8'));
  assert.deepEqual({ ...stored, appToken: !!stored.appToken, botToken: !!stored.botToken }, { appToken: true, botToken: true, channel: 'C0FACTORY', owner: 'UOWNER', people: [] }, 'bound to one channel, allowing only the owner');
  assert.equal(slackAlertsOn(directory), true, 'the existing alerts post to the channel once Slack is connected');

  // 2. The loop's bridge holds one outbound Socket Mode connection; no port of its own is opened.
  const slack = await fakeSlack({ appToken, botToken, names: { UOWNER: 'Vish', UFRIEND: 'Ada', USTRANGER: 'Eve' } });
  closers.push(slack.close);
  const lines: string[] = [];
  const stopping = new AbortController();
  const bridge = runSlackBridge({ directory, api: slack.api, pollMs: 50, signal: stopping.signal, log: line => lines.push(line),
    mainworks: { get: path => coordinator(path), post: (path, body, key) => coordinator(path, body, key) } });
  closers.push(async () => { stopping.abort(); await bridge; });
  await slack.connected();
  assert.equal(slack.opened.length, 1, 'one Socket Mode connection per factory');

  // 3. The owner's message becomes a Lead instruction, recorded with the Slack display name as its source.
  const asked = slack.message({ channel: 'C0FACTORY', user: 'UOWNER', text: '<@UAPP> what is shipping today?', ts: '1700000000.000100' });
  const first = await eventually(async () => (await coordinator('master/messages')).messages.find((message: any) => message.text === 'what is shipping today?'), 'the instruction');
  assert.equal(first.source, 'Slack: Vish');
  assert.ok(slack.acks.includes(asked), 'the envelope is acknowledged');
  const [cause] = messageCauses([first], '/cli.mjs');
  assert.match(cause.detail, /from Slack: Vish/);
  assert.match(cause.detail, /the owner's own instruction/, 'the Lead acts on it as on the owner\'s own instruction');
  assert.match(cause.detail, /money and accounts and credentials for people stay with the owner/);
  assert.doesNotMatch(cause.detail, /no authority/);
  await coordinator(`master/messages/${first.id}/reply`, { text: 'GY-12 and GY-14 ship today.' });
  await eventually(() => slack.posts.find(post => post.text === 'GY-12 and GY-14 ship today.'), 'the reply in thread');
  assert.deepEqual(slack.posts.find(post => post.text === 'GY-12 and GY-14 ship today.'), { channel: 'C0FACTORY', thread_ts: '1700000000.000100', text: 'GY-12 and GY-14 ship today.' }, 'the Lead\'s answer posts back in that thread');

  // 4. A person not on the list is ignored with one line; the owner adds people by Slack id.
  slack.message({ channel: 'C0FACTORY', user: 'USTRANGER', text: 'delete everything', ts: '1700000000.000200' });
  await eventually(() => lines.length === 1, 'the ignored line');
  assert.match(lines[0], /USTRANGER/);
  assert.equal((await coordinator('master/messages')).messages.length, 1, 'no instruction from a person not allowed');
  await slackCommand(['allow', 'UFRIEND'], directory, async () => '');

  // 5. A reserved decision from an allowed person: the Lead says so in thread and raises it under Needs you.
  slack.message({ channel: 'C0FACTORY', user: 'UFRIEND', text: 'Rent a second server for $200 a month', ts: '1700000000.000300' });
  const spend = await eventually(async () => (await coordinator('master/messages')).messages.find((message: any) => message.source === 'Slack: Ada'), 'the friend\'s instruction');
  await coordinator(`master/messages/${spend.id}/reply`, { text: 'Spending money is the owner\'s decision; I raised it under Needs you.' });
  const item = await lifecycle(engine, owner, { type: 'chore', title: 'Rent a second server', criteria: [{ id: 'AC-1', text: 'Rented', proofs: ['manual:rented', 'e2e:fixture'] }] }, { claim: worker });
  const parked = await as(worker)(`work/${item.id}/park`, { epoch: item.epoch, kind: 'money-or-accounts', needed: 'A second server at $200 a month', reason: 'Asked from Slack by Ada', recommendation: 'Approve', why: 'Spending money is the owner\'s call.', choices: [{ id: 'approve', label: 'Rent the server', outcome: 'provided', input: 'none' }] });
  const needs = await eventually(() => slack.posts.find(post => post.blocks), 'Needs you in the channel');
  assert.equal(needs.channel, 'C0FACTORY');
  assert.match(needs.text, /Needs you/);
  const buttons = needs.blocks!.find(block => block.type === 'actions').elements;
  assert.deepEqual(buttons.map((button: any) => button.text.text), ['Rent the server', 'Decline this request'], 'one button per answer');

  // 6. Only the owner answers a reserved decision; the owner's click reaches the Lead to record.
  const before = (await coordinator('master/messages')).messages.length;
  slack.click('UFRIEND', 'C0FACTORY', '1700000001.000100', buttons[0].value);
  await eventually(() => slack.posts.find(post => post.text === 'Only the owner can answer this one.'), 'the refusal in thread');
  slack.click('UOWNER', 'C0FACTORY', '1700000001.000100', buttons[0].value);
  const answer = await eventually(async () => (await coordinator('master/messages')).messages.find((message: any) => message.text.includes(`answer ${item.key} ${parked.humanRequest.id}`)), 'the owner\'s answer to the Lead');
  assert.equal(answer.source, 'Slack: Vish');
  assert.equal((await coordinator('master/messages')).messages.length, before + 1, 'the friend\'s click sent nothing');
  assert.equal(lines.length, 1, 'still one ignored line');
});
