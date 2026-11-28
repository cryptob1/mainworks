// Concern: the factory's Slack app (GY-4073). One Socket Mode app per factory, run by the loop on the
// Lead's machine: it dials out to Slack, so nothing on the factory's private network becomes reachable.
// A message in the bound channel from an allowed person becomes a Lead message exactly as 'Tell the
// Lead' sends one; the Lead's reply posts back in that thread; Needs you and the alerts post there too.
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { atomicPrivateWrite, privateFile } from '../private-file.js';

const slackSettingsSchema = z.object({
  appToken: z.string().startsWith('xapp-'), botToken: z.string().startsWith('xoxb-'),
  /** The one channel the factory is bound to. */
  channel: z.string().regex(/^[A-Z0-9]+$/),
  /** The owner's Slack user id: always allowed, and the only one who answers a reserved decision. */
  owner: z.string().regex(/^[A-Z0-9]+$/),
  /** The other people the owner allows, by Slack user id. */
  people: z.array(z.string().regex(/^[A-Z0-9]+$/)).default([]),
}).strict();
export type SlackSettings = z.infer<typeof slackSettingsSchema>;

/** Where the tokens live: the install directory, never Git. */
export const slackSettingsFile = (directory: string) => join(directory, 'slack.json');
const slackPostedFile = (directory: string) => join(directory, 'slack-posted.json');
/** Whether the existing alerts also post to the channel. */
export const slackAlertsOn = (directory: string) => existsSync(slackSettingsFile(directory));

export async function readSlackSettings(directory: string): Promise<SlackSettings | null> {
  try { await privateFile(slackSettingsFile(directory)); }
  catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; }
  return slackSettingsSchema.parse(JSON.parse(await readFile(slackSettingsFile(directory), 'utf8')));
}
export async function saveSlackSettings(directory: string, settings: SlackSettings) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicPrivateWrite(slackSettingsFile(directory), slackSettingsSchema.parse(settings));
}

/** One Slack Web API call, form-encoded as every method accepts; a refusal throws with Slack's error. */
async function slackCall(api: string, method: string, token: string, params: Record<string, unknown> = {}) {
  const body = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  const response = await fetch(`${api}/${method}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10_000) });
  const result = await response.json() as any;
  if (!result.ok) throw new Error(`Slack ${method} answered ${result.error ?? response.status}`);
  return result;
}

/** Posts one line to the bound channel (the existing alerts). */
export async function postSlackText(directory: string, text: string, api = 'https://slack.com/api') {
  const settings = await readSlackSettings(directory);
  if (settings) await slackCall(api, 'chat.postMessage', settings.botToken, { channel: settings.channel, text });
}

/** A Slack thread as a Lead message thread (`[\w-]` only) and back. */
const threadOf = (channel: string, ts: string) => `slack-${channel}-${ts.replace('.', '-')}`;
const slackThread = (thread: string) => { const match = /^slack-([A-Z0-9]+)-(\d+)-(\d+)$/.exec(thread); return match ? { channel: match[1], ts: `${match[2]}.${match[3]}` } : null; };
/** The decisions that stay with the owner however the Lead is asked. */
const reservedKinds = new Set(['money-or-accounts', 'credentials-for-people']);

export interface SlackBridgeOptions {
  directory: string;
  /** The control plane, as the loop's coordinator identity. */
  mainworks: { get(path: string): Promise<any>; post(path: string, body: unknown, key: string): Promise<any> };
  signal: AbortSignal;
  api?: string; pollMs?: number; log?: (line: string) => void;
}

/**
 * The loop's Slack app: one Socket Mode connection, reopened after a drop, and a poll that posts the
 * Lead's replies into their threads and each new Needs you request with its buttons. Without a
 * connected app it waits, so `lead slack connect` takes effect without restarting the loop.
 */
export async function runSlackBridge(options: SlackBridgeOptions) {
  const { directory, mainworks, signal } = options, api = options.api ?? 'https://slack.com/api', pollMs = options.pollMs ?? 5_000;
  const log = options.log ?? ((line: string) => console.error(`[mainworks-slack] ${line}`));
  const posted = new Set<string>(JSON.parse(await readFile(slackPostedFile(directory), 'utf8').catch(() => '[]')));
  const markPosted = async (key: string) => { posted.add(key); await atomicPrivateWrite(slackPostedFile(directory), [...posted].slice(-1000)); };
  const names = new Map<string, string>();
  const displayName = async (settings: SlackSettings, user: string) => {
    if (!names.has(user)) {
      const { user: found } = await slackCall(api, 'users.info', settings.botToken, { user });
      names.set(user, found.profile?.display_name || found.profile?.real_name || found.name || user);
    }
    return names.get(user)!;
  };
  const allowed = (settings: SlackSettings, user: string) => user === settings.owner || settings.people.includes(user);
  const say = (settings: SlackSettings, channel: string, thread_ts: string | undefined, text: string) => slackCall(api, 'chat.postMessage', settings.botToken, { channel, thread_ts, text });
  const tell = async (settings: SlackSettings, user: string, text: string, channel: string, ts: string, key: string) =>
    mainworks.post('master/messages', { text: text.slice(0, 4000), thread: threadOf(channel, ts), source: `Slack: ${await displayName(settings, user)}`.slice(0, 100) }, key);

  const handle = async (envelope: any) => {
    const settings = await readSlackSettings(directory);
    if (!settings) return;
    const payload = envelope.payload ?? {};
    if (envelope.type === 'events_api') {
      const event = payload.event ?? {};
      // The bound channel's messages, and an @mention anywhere else the app is invited.
      const counted = event.type === 'message' ? event.channel === settings.channel : event.type === 'app_mention' && event.channel !== settings.channel;
      if (!counted || event.bot_id || event.subtype || !event.user || typeof event.text !== 'string') return;
      if (!allowed(settings, event.user)) return log(`Ignored a Slack message from ${event.user}: not an allowed person (lead slack allow adds people)`);
      const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
      if (text) await tell(settings, event.user, text, event.channel, event.thread_ts ?? event.ts, `slack-${event.channel}-${event.ts}`);
    } else if (envelope.type === 'interactive' && payload.type === 'block_actions') {
      const user = payload.user?.id, channel = payload.channel?.id ?? settings.channel, ts = payload.message?.ts;
      const choice = JSON.parse(payload.actions?.[0]?.value ?? '{}') as { w: string; r: string; k: string; l: string };
      if (!allowed(settings, user)) return log(`Ignored a Slack answer from ${user}: not an allowed person (lead slack allow adds people)`);
      if (reservedKinds.has(choice.k) && user !== settings.owner) { await say(settings, channel, ts, 'Only the owner can answer this one.'); return; }
      await tell(settings, user, `Chose “${choice.l}” for ${choice.w} on Needs you. Record it with answer ${choice.w} ${choice.r} --owner-said "WORDS" ANSWER.`, channel, ts, `slack-answer-${choice.r}-${user}-${choice.l}`.slice(0, 200));
    }
  };

  const poll = async () => {
    const settings = await readSlackSettings(directory);
    if (!settings) return;
    for (const message of (await mainworks.get('master/messages')).messages ?? []) {
      const where = slackThread(message.thread ?? '');
      if (where) for (const reply of message.replies ?? []) if (!posted.has(`reply:${reply.id}`)) {
        await say(settings, where.channel, where.ts, reply.text);
        await markPosted(`reply:${reply.id}`);
      }
    }
    for (const row of (await mainworks.get('human-requests')).requests ?? []) {
      if (posted.has(`request:${row.request.id}`)) continue;
      const text = `Needs you: ${row.title} — ${row.request.ask ?? row.request.needed}`;
      const buttons = (row.choices ?? []).slice(0, 5).map((choice: { label: string }, index: number) => ({ type: 'button', action_id: `answer-${index}`, text: { type: 'plain_text', text: choice.label.slice(0, 75) },
        value: JSON.stringify({ w: row.work, r: row.request.id, k: row.request.kind, l: choice.label.slice(0, 200) }) }));
      await slackCall(api, 'chat.postMessage', settings.botToken, { channel: settings.channel, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }, ...(buttons.length ? [{ type: 'actions', elements: buttons }] : [])] });
      await markPosted(`request:${row.request.id}`);
    }
  };
  const polling = (async () => {
    while (!signal.aborted) {
      await poll().catch(error => log(`Slack poll failed: ${error instanceof Error ? error.message : String(error)}`));
      await sleep(pollMs, undefined, { signal }).catch(() => {});
    }
  })();

  while (!signal.aborted) {
    const settings = await readSlackSettings(directory).catch(() => null);
    if (!settings) { await sleep(30_000, undefined, { signal }).catch(() => {}); continue; }
    try {
      const { url } = await slackCall(api, 'apps.connections.open', settings.appToken);
      const socket = new WebSocket(url);
      await new Promise<void>(resolve => {
        const stop = () => socket.close();
        signal.addEventListener('abort', stop, { once: true });
        socket.addEventListener('message', event => {
          const envelope = JSON.parse(String(event.data));
          if (envelope.envelope_id) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          if (envelope.type === 'disconnect') socket.close();
          else handle(envelope).catch(error => log(`Slack event failed: ${error instanceof Error ? error.message : String(error)}`));
        });
        socket.addEventListener('close', () => { signal.removeEventListener('abort', stop); resolve(); });
        socket.addEventListener('error', () => socket.close());
      });
    } catch (error) { log(`Slack connection failed: ${error instanceof Error ? error.message : String(error)}`); }
    await sleep(signal.aborted ? 0 : 5_000, undefined, { signal }).catch(() => {});
  }
  await polling;
}
