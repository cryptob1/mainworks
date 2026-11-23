import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { demand } from '../../model.js';
import { defineRoutes, parseJson, type RouteContext } from '../routes.js';
import { createEnvironment, createProject, createRepository, infraProviders, infraRefusal, pushRepository, type InfraAction, type InfraScope } from '../../infra-access.js';

/**
 * GY-3515: the one route a master uses to create a repository and a hosting project. The owner
 * approves a grant naming one repository and one hosting project (`infra.grant`); the master takes a
 * credential for it (`infra.credential`, its digest only); each call with that credential is checked
 * against the two names, done here with the install's provider tokens and recorded (`infra.action`).
 */
const prefix = 'infra.';
type Grant = InfraScope & { id: string; from: string | null; approvedBy: string };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const credentialPrefix = 'gyi_';

const record = (context: RouteContext, actor: string, kind: string, payload: unknown) =>
  context.services.engine.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor, prefix + kind, JSON.stringify(payload)]);
const rows = async (context: RouteContext, kind: string) =>
  (await context.services.engine.store.pool.query<{ actor: string; at: Date; payload: any }>('SELECT actor, created_at AS at, payload FROM events WHERE work_id IS NULL AND kind=$1 ORDER BY seq DESC LIMIT 500', [prefix + kind])).rows;

const name = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/);
const grantSchema = z.object({ repository: z.string().trim().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'Name the repository as OWNER/NAME'), project: name, from: z.string().trim().max(200).optional() }).strict();
const actSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('repo.create'), repository: z.string().max(200) }).strict(),
  z.object({ action: z.literal('repo.push'), repository: z.string().max(200), bundle: z.string().max(140_000_000) }).strict(),
  z.object({ action: z.literal('project.create'), project: z.string().max(200) }).strict(),
  z.object({ action: z.literal('environment.create'), project: z.string().max(200), environment: name }).strict(),
]);

/** The grant and holder the bearer credential names, or null. */
async function holder(context: RouteContext) {
  const token = String(context.req.headers.authorization ?? '').replace(/^Bearer\s*/, '');
  if (!token.startsWith(credentialPrefix)) return null;
  const credential = (await rows(context, 'credential')).find(row => row.payload.tokenHash === digest(token));
  const grant = credential && (await rows(context, 'grant')).find(row => row.payload.id === credential.payload.grant);
  return grant ? { who: credential.actor, grant: grant.payload as Grant } : null;
}

async function act(context: RouteContext) {
  const found = await holder(context);
  demand(found, 'This infra credential is not valid; run graphyard infra take for a new one.', 401);
  const { who, grant } = found!;
  const request = actSchema.parse(await parseJson(context, 150_000_000));
  const target = 'repository' in request ? request.repository : request.action === 'environment.create' ? `${request.project}/${request.environment}` : request.project;
  const log = (outcome: string, detail: string) => record(context, who, 'action', { grant: grant.id, action: request.action, target, outcome, detail });
  const inScope = 'repository' in request ? request.repository === grant.repository : request.project === grant.project;
  if (!inScope) {
    await log('refused', 'outside the approved names');
    demand(false, infraRefusal(grant), 403);
  }
  const providers = context.services.infra ?? infraProviders(process.env);
  try {
    const result = await run(context, providers, grant, request);
    await log('done', result);
    return { done: request.action, target, detail: result };
  } catch (error: any) {
    const message = String(error?.message ?? error).split('\n')[0];
    await log('failed', message);
    demand(false, message, 502);
  }
}

async function run(context: RouteContext, providers: ReturnType<typeof infraProviders>, grant: Grant, request: z.infer<typeof actSchema>): Promise<string> {
  switch (request.action as InfraAction) {
    case 'repo.create': return `created ${(await createRepository(providers, grant.repository)).url}`;
    case 'repo.push': return `pushed ${(await pushRepository(providers, grant.repository, Buffer.from((request as { bundle: string }).bundle, 'base64'))).branches.join(', ')}`;
    case 'project.create': return `created project ${(await createProject(providers, grant.project)).id}`;
    case 'environment.create': {
      const created = (await rows(context, 'action')).find(row => row.payload.grant === grant.id && row.payload.action === 'project.create' && row.payload.outcome === 'done');
      if (!created) throw new Error(`Create the hosting project first: graphyard infra project create ${grant.project}`);
      const environment = (request as { environment: string }).environment;
      return `created environment ${environment} ${(await createEnvironment(providers, String(created.payload.detail).split(' ').pop()!, environment)).id}`;
    }
  }
  throw new Error('Unknown infra action');
}

/** What was done with infra credentials, newest first: who, what and when. */
async function infraLog(context: RouteContext) {
  return (await rows(context, 'action')).map(row => ({ who: row.actor, at: new Date(row.at).toISOString(), action: row.payload.action as string, target: row.payload.target as string, outcome: row.payload.outcome as string, detail: row.payload.detail as string }));
}

/** The credential route answers before authentication: its bearer is the infra credential itself. */
export const infraActRoutes = defineRoutes('infra-act', [{ method: 'POST', path: '/api/infra/act', handle: act }]);

export const infraRoutes = defineRoutes('infra', [
  // The owner approves one repository and one hosting project.
  { method: 'POST', path: '/api/infra/approvals', handle: async context => {
    demand(context.actor.role === 'admin' && context.actor.sessionKind === 'human', 'Only the owner approves infra access.', 403);
    const input = grantSchema.parse(await parseJson(context));
    const grant: Grant = { id: randomUUID(), repository: input.repository, project: input.project, from: input.from ?? null, approvedBy: context.actor.id };
    await record(context, context.actor.id, 'grant', grant);
    return { approved: grant, next: 'The master runs graphyard infra take, then the infra commands.' };
  } },
  // The master takes a credential for the newest grant; it is shown once and only its digest is kept.
  { method: 'POST', path: '/api/infra/credential', handle: async context => {
    demand(['admin', 'coordinator', 'operator-agent'].includes(context.actor.role), 'Only the master takes infra access.', 403);
    const grant = (await rows(context, 'grant'))[0]?.payload as Grant | undefined;
    demand(grant, 'The owner has approved no infra task yet.', 404);
    const token = credentialPrefix + randomBytes(32).toString('base64url');
    await record(context, context.actor.id, 'credential', { grant: grant!.id, tokenHash: digest(token) });
    return { token, repository: grant!.repository, project: grant!.project };
  } },
  { method: 'GET', path: '/api/infra/actions', handle: async context => ({ actions: await infraLog(context) }) },
]);
