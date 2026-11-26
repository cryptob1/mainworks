import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { demand } from '../../model.js';
import { defineRoutes, parseJson, type RouteContext } from '../routes.js';
import { humanSignIn } from '../auth.js';
import { applyTeamChange, missingTailnetGuidance, type MachineTeam, type TeamChange } from '../../team-access.js';
import { teamRoles } from '../principals.js';
import { canViewMasterPane, terminalInputEvent } from '../terminal.js';
import { unownedFamilySql } from '../../store/tables/work.js';

/**
 * GY-3294: the operator's team access for this install. The server never reads the host's machine
 * directory: a teammate change is a `team-access.*` event the install's master loop carries to the
 * machine (master/team-access.ts), and the loop's report back is the mirror every install shows.
 * GY-3514: Invite makes one single-use link on the address the loop reports — the install's Funnel
 * address, which opens on any device — and the session it opens is the person's own.
 */
const prefix = 'team-access.';
type Row = { kind: string; payload: any };
interface HostReport { dnsName: string | null; ip: string | null; url?: string | null; public?: boolean; doing?: string | null; team?: MachineTeam | null; applied: { team?: string | null } }

const configuredIds = (context: RouteContext) => context.services.principals.map(entry => entry.actor.id);
const port = (context: RouteContext) => context.services.teamAccess?.port ?? String(context.req.socket.localPort ?? '');
const operator = (context: RouteContext) => humanSignIn(context.services).checkOperator(context.actor, configuredIds(context));
const host = (context: RouteContext) => demand(['admin', 'coordinator'].includes(context.actor.role), 'Team access is synchronized by the host\'s master loop identity', 403);
const record = (context: RouteContext, kind: string, payload: unknown) =>
  context.services.engine.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [context.actor.id, prefix + kind, JSON.stringify(payload)]);

/** The newest events fold into: the latest host report and the teammate changes the host has not applied yet. */
async function fold(context: RouteContext) {
  const rows = (await context.services.engine.store.pool.query<Row>(`SELECT kind, payload FROM events WHERE ${unownedFamilySql(prefix)} ORDER BY seq DESC LIMIT 200`)).rows;
  const report = rows.find(row => row.kind === `${prefix}host`)?.payload as HostReport | undefined;
  // GY-3486: teammate changes after the last one the host applied to the machine's roster, oldest first.
  const changes = rows.filter(row => row.kind === `${prefix}team`).map(row => row.payload as TeamChange).reverse();
  const pendingTeam = changes.slice(changes.findIndex(change => change.op === report?.applied.team) + 1);
  return { report, pendingTeam, team: pendingTeam.reduce(applyTeamChange, report?.team ?? { installs: {}, members: {} }) };
}

/** GY-3690: whether the owner turned the install's public link on, who did and when; off until they do. */
export interface PublicLinkSetting { on: boolean; by: string | null; at: string | null }
type Pool = RouteContext['services']['engine']['store']['pool'];
async function publicLinkSetting(pool: Pool): Promise<PublicLinkSetting> {
  const row = (await pool.query(`SELECT actor, created_at, payload FROM events WHERE ${unownedFamilySql(prefix)} AND kind = $1 ORDER BY seq DESC LIMIT 1`, [`${prefix}public-link`])).rows[0];
  return row ? { on: !!row.payload.on, by: row.actor, at: new Date(row.created_at).toISOString() } : { on: false, by: null, at: null };
}
/**
 * GY-3690: while the owner turned the public link on, someone is invited (an unexpired invite or a
 * teammate) and the host reports the link is not public: what the loop is doing and when the link was
 * last public. Home shows it as an incident and `master status` as one attention line; null otherwise.
 */
export async function publicLinkOff(pool: Pool, now: Date): Promise<{ doing: string; lastPublic: string | null } | null> {
  if (!(await publicLinkSetting(pool)).on) return null;
  const report = (await pool.query(`SELECT payload FROM events WHERE ${unownedFamilySql(prefix)} AND kind = $1 ORDER BY seq DESC LIMIT 1`, [`${prefix}host`])).rows[0]?.payload as HostReport | undefined;
  if (!report || report.public) return null;
  const invited = (await pool.query('SELECT EXISTS (SELECT 1 FROM team_members) OR EXISTS (SELECT 1 FROM team_invites WHERE expires_at > $1) AS invited', [now])).rows[0]?.invited;
  if (!invited) return null;
  // Only changed reports are recorded, so the link stayed public until the first report after the latest public one.
  const last = (await pool.query(`SELECT created_at FROM events WHERE ${unownedFamilySql(prefix)} AND kind = $1 AND seq > (SELECT seq FROM events WHERE ${unownedFamilySql(prefix)} AND kind = $1 AND payload->>'public' = 'true' ORDER BY seq DESC LIMIT 1) ORDER BY seq LIMIT 1`, [`${prefix}host`])).rows[0]?.created_at as Date | undefined;
  return { doing: report.doing ?? 'The loop cannot read Tailscale on this machine. Start Tailscale there.', lastPublic: last ? new Date(last).toISOString() : null };
}

/** GY-3514: the one line Invite shows when its link opens only on the tailnet. */
const funnelOffGuidance = 'This link opens only on your tailnet: turn on Funnel for this machine in the Tailscale admin console.';
/** GY-3690: the line Invite shows while the owner keeps the public link off. */
export const tailnetOnlyGuidance = 'This link opens only on your tailnet: the public link is off. Turn it on in Settings to let people without Tailscale open it.';
const linkGuidance = (report: HostReport | undefined, setting: PublicLinkSetting, port: string) =>
  !report?.url ? missingTailnetGuidance(port) : !setting.on ? tailnetOnlyGuidance : !report.public ? funnelOffGuidance : null;
async function view(context: RouteContext) {
  operator(context);
  const state = await fold(context), url = state.report?.url ?? null, publicLink = await publicLinkSetting(context.services.engine.store.pool);
  return {
    installUrl: url, public: !!state.report?.public, hostSynced: !!state.report, publicLink,
    guidance: linkGuidance(state.report, publicLink, port(context)),
    teammates: await teammates(context, state.team, url),
  };
}

/** GY-3486: every teammate: the machine's roster, and those invited to this install alone (`mainworks invite`). */
async function teammates(context: RouteContext, team: MachineTeam, url: string | null) {
  const local = (await context.services.engine.store.pool.query<{ name: string; team: string }>('SELECT name, team FROM team_members ORDER BY name')).rows;
  const listed = Object.entries(team.members).map(([login, member]) => ({ login, role: member.role, installs: member.installs }));
  for (const row of local) if (!team.members[row.name]) listed.push({ login: row.name, role: row.team, installs: url ? [url] : [] });
  return listed.sort((x, y) => x.login.localeCompare(y.login));
}
const members = (report: HostReport | undefined) => new Map(report?.url ? Object.entries(report.team?.members ?? {}).filter(([, member]) => member.installs.includes(report.url!)).map(([login, member]) => [login, member.role]) : []);

const hostReportSchema = z.object({
  dnsName: z.string().max(300).nullable(), ip: z.string().max(100).nullable(), url: z.string().url().max(400).nullable().optional(), public: z.boolean().optional(), doing: z.string().max(400).nullable().optional(),
  team: z.object({
    installs: z.record(z.string().max(400), z.object({ name: z.string().max(300) }).strict()),
    members: z.record(z.string().max(100), z.object({ role: z.enum(teamRoles), installs: z.array(z.string().max(400)).max(50) }).strict()),
  }).strict().nullable().optional(),
  applied: z.object({ team: z.string().max(100).nullable().optional() }).strict(),
}).strict();

/** GY-3514: what the owner may pick for how long an invite stays unopened. */
const inviteDays = [1, 7, 30] as const;

export const teamAccessRoutes = defineRoutes('team-access', [
  { method: 'GET', path: '/api/team-access', handle: view },
  // GY-3690: the public link setting: anyone signed in reads it (`team-access status`); only the owner's human session changes it.
  { method: 'GET', path: '/api/team-access/public-link', handle: context => publicLinkSetting(context.services.engine.store.pool) },
  { method: 'POST', path: '/api/team-access/public-link', handle: async context => {
    const { actor } = context;
    demand(actor.role === 'admin' && actor.sessionKind === 'human' && configuredIds(context).includes(actor.id), 'Only the owner, signed in to the dashboard, turns the public link on or off', 403);
    const { on } = z.object({ on: z.boolean() }).strict().parse(await parseJson(context));
    await record(context, 'public-link', { on });
    return publicLinkSetting(context.services.engine.store.pool);
  } },
  // The host's master loop: the teammate changes it should apply to the machine, and what the machine holds.
  { method: 'GET', path: '/api/team-access/host', handle: async context => {
    host(context);
    const state = await fold(context);
    return { repository: context.services.repository, team: state.pendingTeam, applied: state.report?.applied ?? { team: null },
      // GY-3690: whether the loop may turn Funnel on, and master status's attention line.
      publicLink: (await publicLinkSetting(context.services.engine.store.pool)).on, publicLinkOff: await publicLinkOff(context.services.engine.store.pool, new Date()) };
  } },
  { method: 'POST', path: '/api/team-access/host', handle: async context => {
    host(context);
    const report = hostReportSchema.parse(await parseJson(context));
    // Every loop reports each pass; only a change is recorded, so the ledger grows with the owner's actions alone.
    const previous = (await fold(context)).report;
    if (isDeepStrictEqual(previous, report)) return { recorded: true };
    // GY-3486: the machine's roster admits and removes this install's teammates; one invited here alone is left as it is.
    const signIns = humanSignIn(context.services), before = members(previous);
    for (const [login, role] of members(report)) if (before.get(login) !== role) await signIns.admit(login, role, 'machine');
    for (const login of before.keys()) if (!members(report).has(login)) await signIns.remove(login);
    await record(context, 'host', report);
    return { recorded: true };
  } },
  /**
   * GY-3514: Invite a person: one link, single use, valid for the days the owner picks, on the
   * address the host reports (its Funnel address, open to any device), else the one this request reached.
   */
  { method: 'POST', path: '/api/invites', handle: async context => {
    const { name, role, days = 7 } = await parseJson(context) as { name: string; role: string; days?: number };
    demand((inviteDays as readonly unknown[]).includes(days), `Pick how long the invite stays valid: ${inviteDays.join(', ')} days`, 400);
    const invite = await humanSignIn(context.services).invite(context.actor, configuredIds(context), name, role, days * 86_400_000);
    const report = (await fold(context)).report, base = report?.url ?? `http://${context.req.headers.host}`;
    return { link: `${base.replace(/\/$/, '')}/#sign-in=${invite.code}`, name: invite.principal, role, expiresAt: invite.expiresAt,
      note: linkGuidance(report, await publicLinkSetting(context.services.engine.store.pool), port(context)) };
  } },
  // Revoke removes the teammate from every install on the machine and ends their sessions here at once.
  { method: 'POST', path: /^\/api\/invites\/([^/]+)\/revoke$/, handle: async (context, [encoded]) => {
    const name = decodeURIComponent(encoded);
    operator(context);
    const listed = !!(await fold(context)).team.members[name];
    if (listed) await record(context, 'team', { op: randomUUID(), login: name, remove: true });
    const local = (await context.services.engine.store.pool.query('SELECT 1 FROM team_members WHERE name=$1', [name])).rowCount;
    return listed && !local ? { revoked: name, sessionsEnded: 0 } : humanSignIn(context.services).revoke(context.actor, configuredIds(context), name);
  } },
  // GY-3514: what people typed into the master's pane, newest first, for whoever may see that pane (GY-3880).
  { method: 'GET', path: '/api/typed-input', handle: async context => {
    demand(canViewMasterPane(context.actor), 'Only the owner and invited teammates see what was typed into the Lead', 403);
    const { rows } = await context.services.engine.store.pool.query<{ actor: string; at: Date; payload: { line: string } }>(
      'SELECT actor, created_at AS at, payload FROM events WHERE work_id IS NULL AND kind=$1 ORDER BY seq DESC LIMIT 500', [terminalInputEvent]);
    return { typed: rows.map(row => ({ who: row.actor, at: new Date(row.at).toISOString(), text: row.payload.line })) };
  } },
]);
