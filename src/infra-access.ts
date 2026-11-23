// GY-3515: scoped infra access. The owner approves one repository and one hosting project; the
// confined master holds a credential that names them and nothing else. The control plane does each
// repository or hosting call itself with the install's provider tokens (the install's .env), so the
// session never holds a provider token, and every call is recorded as an `infra.action` event.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const infraActions = ['repo.create', 'repo.push', 'project.create', 'environment.create'] as const;
export type InfraAction = typeof infraActions[number];
/** What an infra credential covers: one repository (OWNER/NAME) and one hosting project. */
export interface InfraScope { repository: string; project: string }

/** The one line a request outside the credential's names reads. */
export const infraRefusal = (scope: InfraScope) => `Refused: this credential covers repository ${scope.repository} and hosting project ${scope.project} only; ask the owner to approve another.`;

/** The provider endpoints and tokens, from the server's environment. */
export interface InfraProviders { githubToken?: string; githubApi: string; gitUrl: string; railwayToken?: string; railwayApi: string; railwayTeam?: string }
export const infraProviders = (env: NodeJS.ProcessEnv): InfraProviders => ({
  githubToken: env.GRAPHYARD_INFRA_GITHUB_TOKEN || undefined,
  githubApi: (env.GRAPHYARD_INFRA_GITHUB_API || 'https://api.github.com').replace(/\/+$/, ''),
  gitUrl: (env.GRAPHYARD_INFRA_GIT_URL || 'https://github.com').replace(/\/+$/, ''),
  railwayToken: env.GRAPHYARD_INFRA_RAILWAY_TOKEN || undefined,
  railwayApi: env.GRAPHYARD_INFRA_RAILWAY_API || 'https://backboard.railway.com/graphql/v2',
  railwayTeam: env.GRAPHYARD_INFRA_RAILWAY_TEAM || undefined,
});

const missing = (name: string) => new Error(`Set ${name} in the install's .env and restart the server.`);
const github = async (providers: InfraProviders, path: string, body: unknown) => {
  if (!providers.githubToken) throw missing('GRAPHYARD_INFRA_GITHUB_TOKEN');
  return fetch(`${providers.githubApi}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${providers.githubToken}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
};

/** Create the private repository OWNER/NAME: in the organization OWNER, else under the token's own user. */
export async function createRepository(providers: InfraProviders, repository: string) {
  const [owner, name] = repository.split('/');
  let response = await github(providers, `/orgs/${owner}/repos`, { name, private: true });
  if (response.status === 404) response = await github(providers, '/user/repos', { name, private: true });
  if (!response.ok) throw new Error(`GitHub refused to create ${repository}: ${(await response.json().catch(() => ({})) as { message?: string }).message ?? response.status}`);
  return { url: (await response.json() as { html_url?: string }).html_url ?? `${providers.gitUrl}/${repository}` };
}

/** Push every branch and tag in BUNDLE to OWNER/NAME; the token rides in git's environment, never in a URL, an argument or a file. */
export async function pushRepository(providers: InfraProviders, repository: string, bundle: Buffer) {
  if (!providers.githubToken) throw missing('GRAPHYARD_INFRA_GITHUB_TOKEN');
  const dir = await mkdtemp(join(tmpdir(), 'mainworks-infra-push-'));
  try {
    const file = join(dir, 'push.bundle'), bare = join(dir, 'repo.git');
    await writeFile(file, bundle);
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${providers.githubToken}`).toString('base64')}` };
    const git = (...args: string[]) => promisify(execFile)('git', args, { env, timeout: 300_000, maxBuffer: 10_000_000 });
    await git('init', '-q', '--bare', bare);
    await git('-C', bare, 'fetch', '-q', file, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*');
    try { await git('-C', bare, 'push', '-q', `${providers.gitUrl}/${repository}.git`, 'refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*'); } catch (error: any) {
      throw new Error(`The push to ${repository} failed: ${String(error.stderr ?? '').trim().split('\n').pop() || 'git exited with an error'}`);
    }
    const { stdout } = await git('-C', bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
    return { branches: stdout.trim().split('\n').filter(Boolean) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const railway = async (providers: InfraProviders, query: string, variables: Record<string, unknown>) => {
  if (!providers.railwayToken) throw missing('GRAPHYARD_INFRA_RAILWAY_TOKEN');
  const response = await fetch(providers.railwayApi, { method: 'POST', headers: { Authorization: `Bearer ${providers.railwayToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => ({})) as { data?: any; errors?: { message: string }[] };
  if (!response.ok || body.errors?.length || !body.data) throw new Error(`Railway refused: ${body.errors?.[0]?.message ?? response.status}`);
  return body.data;
};

/** Create the hosting project NAME on Railway. */
export async function createProject(providers: InfraProviders, name: string) {
  const data = await railway(providers, 'mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { id name } }', { input: { name, ...(providers.railwayTeam ? { teamId: providers.railwayTeam } : {}) } });
  return { id: String(data.projectCreate.id) };
}

/** Create the environment NAME in the hosting project PROJECTID. */
export async function createEnvironment(providers: InfraProviders, projectId: string, name: string) {
  const data = await railway(providers, 'mutation($input: EnvironmentCreateInput!) { environmentCreate(input: $input) { id name } }', { input: { projectId, name } });
  return { id: String(data.environmentCreate.id) };
}
