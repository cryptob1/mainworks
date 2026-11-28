// Concern: Settings › Slack (GY-4073). The owner pastes the app's two tokens; the plane tests them against
// Slack and lists the channels the bot was invited to and the workspace's people. The tokens never
// land in the plane's database: they wait in memory until the loop's next pass collects them and keeps
// them in the install directory, mode 0600. The loop reports back whether its connection is up.
import { z } from 'zod';
import { demand } from '../../model.js';
import { Refusal } from '../../model/refusal.js';
import { setting } from '../../setting.js';
import { slackCall, slackManifest, type SlackSettings } from '../../master/slack.js';
import { defineRoutes, parseJson, type Services } from '../routes.js';

interface Person { id: string; name: string }
interface Checked { appToken: string; botToken: string; team: string; bot: string; channels: { id: string; name: string }[]; people: Person[] }
/** What the loop last reported about its Slack connection. */
const loopReport = z.object({ connected: z.boolean(), channel: z.string().nullable(), channelName: z.string().nullable(), lastMessageAt: z.string().nullable() }).strict();
type LoopReport = z.infer<typeof loopReport> & { at: string };

/** One plane process's Slack setup in flight, per plane (tests run several in one process). */
const states = new WeakMap<Services, { checked: Checked | null; handoff: SlackSettings | null; disconnect: boolean; loop: LoopReport | null }>();
const stateOf = (services: Services) => { if (!states.has(services)) states.set(services, { checked: null, handoff: null, disconnect: false, loop: null }); return states.get(services)!; };
const slackApi = () => setting('SLACK_API') ?? 'https://slack.com/api';
/** One line naming what the owner fixes. */
const refuse = (line: string): never => { throw new Refusal(line, 422); };
const slackError = (error: unknown) => String((error as Error).message ?? error).replace(/^Slack \S+ answered /, '');

/** Tests both tokens and reads the channels and people; each refusal is one line naming what to fix. */
async function checkTokens(appToken: string, botToken: string): Promise<Checked> {
  demand(appToken.startsWith('xapp-'), 'The app-level token starts with xapp-: find it under Basic Information › App-Level Tokens', 422);
  demand(botToken.startsWith('xoxb-'), 'The bot token starts with xoxb-: find it under OAuth & Permissions', 422);
  const api = slackApi();
  await slackCall(api, 'apps.connections.open', appToken).catch(error => {
    const code = slackError(error);
    return refuse(code === 'invalid_auth' || code === 'not_authed' ? 'Slack refused the app-level token: copy it again from Basic Information › App-Level Tokens'
      : code === 'missing_scope' ? 'The app-level token lacks connections:write: generate a new one with that scope'
      : `Slack would not open a Socket Mode connection (${code}): turn Socket Mode on under Settings › Socket Mode`);
  });
  const auth = await slackCall(api, 'auth.test', botToken).catch(() => refuse('Slack refused the bot token: copy it again from OAuth & Permissions'));
  const scoped = (error: unknown) => {
    const code = slackError(error);
    return refuse(code === 'missing_scope' ? 'The bot token lacks a scope: add the scopes from the manifest and reinstall the app' : `Slack refused to list channels or people (${code})`);
  };
  const channels = await slackCall(api, 'conversations.list', botToken, { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '1000' }).catch(scoped);
  const people = await slackCall(api, 'users.list', botToken, { limit: '1000' }).catch(scoped);
  return {
    appToken, botToken, team: auth.team ?? '', bot: auth.user ?? '',
    channels: (channels.channels ?? []).filter((channel: any) => channel.is_member).map((channel: any) => ({ id: channel.id, name: channel.name })),
    people: (people.members ?? []).filter((person: any) => !person.deleted && !person.is_bot && person.id !== 'USLACKBOT')
      .map((person: any) => ({ id: person.id, name: person.profile?.display_name || person.profile?.real_name || person.name })),
  };
}

const owner = (actor: { role?: string | null; sessionKind?: string | null }) => demand(actor.role === 'admin' && actor.sessionKind === 'human', 'Only the owner sets up Slack, signed in on the dashboard', 403);
const view = (services: Services) => {
  const { checked, handoff, loop } = stateOf(services);
  return {
    manifest: slackManifest(services.repository.split('/').pop() ?? 'Mainworks'),
    tokens: checked ? { team: checked.team, bot: checked.bot, channels: checked.channels, people: checked.people } : null,
    waiting: !!handoff, loop,
  };
};

export const slackRoutes = defineRoutes('slack', [
  { method: 'GET', path: '/api/slack', async handle({ actor, services }) { owner(actor); return view(services); } },
  { method: 'POST', path: '/api/slack/connect', async handle(context) {
    owner(context.actor);
    const { appToken, botToken } = z.object({ appToken: z.string().trim().max(500), botToken: z.string().trim().max(500) }).strict().parse(await parseJson(context, 4_000));
    stateOf(context.services).checked = await checkTokens(appToken, botToken);
    return view(context.services);
  } },
  // After /invite in Slack: read the channels again with the bot token already checked.
  { method: 'POST', path: '/api/slack/channels', async handle({ actor, services }) {
    owner(actor);
    const state = stateOf(services);
    demand(state.checked, 'Connect the tokens first', 409);
    state.checked = await checkTokens(state.checked!.appToken, state.checked!.botToken);
    return view(services);
  } },
  { method: 'POST', path: '/api/slack/channel', async handle(context) {
    owner(context.actor);
    const input = z.object({ channel: z.string().regex(/^[A-Z0-9]+$/), owner: z.string().regex(/^[A-Z0-9]+$/), people: z.array(z.string().regex(/^[A-Z0-9]+$/)).max(500) }).strict().parse(await parseJson(context, 40_000));
    const state = stateOf(context.services);
    demand(state.checked, 'Connect the tokens first', 409);
    const channel = state.checked!.channels.find(entry => entry.id === input.channel);
    demand(channel, 'Pick a channel the app was invited to', 422);
    state.handoff = { appToken: state.checked!.appToken, botToken: state.checked!.botToken, channel: input.channel, channelName: channel!.name, owner: input.owner, people: input.people.filter(id => id !== input.owner) };
    state.disconnect = false;
    return view(context.services);
  } },
  { method: 'POST', path: '/api/slack/disconnect', async handle({ actor, services }) {
    owner(actor);
    Object.assign(stateOf(services), { checked: null, handoff: null, disconnect: true, loop: null });
    return view(services);
  } },
  // The loop's pass: it reports its connection and collects a new setup or a disconnect, once.
  { method: 'POST', path: '/api/slack/loop', async handle(context) {
    demand(context.actor.role === 'coordinator', 'Only the loop collects the Slack setup', 403);
    const report = loopReport.parse(await parseJson(context, 4_000));
    const state = stateOf(context.services), settings = state.handoff, disconnect = state.disconnect;
    // The pass that collects a disconnect still reports the old connection; it is already gone to the owner.
    state.loop = disconnect ? null : { ...report, at: new Date().toISOString() };
    if (settings) state.checked = null;
    state.handoff = null; state.disconnect = false;
    return { settings, disconnect };
  } },
]);
