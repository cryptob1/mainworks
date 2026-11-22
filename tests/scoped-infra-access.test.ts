import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { guideText } from '../src/guide.js';
import { infraRefusal } from '../src/infra-access.js';
import { SetupView } from '../web/pages/setup.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3515: an owner-approved infra task gives the confined master a credential limited to one
// repository and one hosting project. With it the master creates and pushes the repository and
// creates the project and its environments; any other name is refused in one line; every call is
// recorded with who, what and when and listed on the dashboard; guide infra names the route.

const root = fileURLToPath(new URL('..', import.meta.url));
const githubToken = 'ghp_provider_secret_0123456789abcdefghijklmnop', railwayToken = 'railway_provider_secret_0123456789abcdef';

/** GitHub's and Railway's APIs as the control plane calls them; a created repository is a bare repository under GITROOT that git pushes to. */
async function fakeProviders(gitRoot: string) {
  const calls: { path: string; auth: string; body: any }[] = [];
  const http = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null, path = req.url ?? '';
    calls.push({ path, auth: String(req.headers.authorization ?? ''), body });
    const reply = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (path === '/orgs/acme/repos') {
      await mkdir(join(gitRoot, 'acme'), { recursive: true });
      execFileSync('git', ['init', '-q', '--bare', join(gitRoot, 'acme', `${body.name}.git`)]);
      return reply(201, { html_url: `https://github.com/acme/${body.name}` });
    }
    if (path === '/graphql' && body.query.includes('projectCreate')) return reply(200, { data: { projectCreate: { id: `prj-${body.variables.input.name}`, name: body.variables.input.name } } });
    if (path === '/graphql' && body.query.includes('environmentCreate')) return reply(200, { data: { environmentCreate: { id: `env-${body.variables.input.name}`, name: body.variables.input.name } } });
    reply(404, { message: 'Not Found' });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  return { calls, url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, close: () => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }) };
}

/** A control plane with the owner and the master, the provider fakes, and a checkout the confined master works in. */
async function infraInstall(label: string) {
  const dir = await temporaryDirectory(label), gitRoot = join(dir, 'github'), checkout = join(dir, 'checkout');
  const providers = await fakeProviders(gitRoot);
  const store = await withDatabase(label);
  await store.init();
  const engine = new Engine(store, 120, `owner/${label}`);
  engine.gitRunner = null;
  const owner = `owner-token-${label}-0123456789abcdefghijklmnopqrstuvwxyz`, master = `master-token-${label}-0123456789abcdefghijklmnopqrstuvwxyz`;
  const env = { GRAPHYARD_INFRA_GITHUB_TOKEN: githubToken, GRAPHYARD_INFRA_GITHUB_API: providers.url, GRAPHYARD_INFRA_GIT_URL: gitRoot, GRAPHYARD_INFRA_RAILWAY_TOKEN: railwayToken, GRAPHYARD_INFRA_RAILWAY_API: `${providers.url}/graphql` };
  const http = server(engine, [{ id: 'owner', role: 'admin', sessionKind: 'human', token: owner }, { id: 'master', role: 'admin', sessionKind: 'ai', token: master }], { env });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await mkdir(checkout);
  const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  await writeFile(join(checkout, '.gitignore'), '.graphyard/\n');
  await writeFile(join(checkout, 'README.md'), '# new app\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first');
  // Everything the CLI prints and the server logs, to show the credential is in none of it.
  const output: string[] = [];
  const cli = async (token: string, ...args: string[]) => {
    const env = { ...process.env, GRAPHYARD_URL: base, GRAPHYARD_TOKEN: token, GRAPHYARD_TOKEN_FILE: undefined, GRAPHYARD_REQUEST_ID: undefined, GRAPHYARD_REPOSITORY_ROOT: checkout };
    try {
      const { stdout, stderr } = await promisify(execFile)('node', ['--import', 'tsx', join(root, 'src/cli.ts'), 'infra', ...args], { cwd: root, env, encoding: 'utf8' });
      output.push(stdout, stderr);
      return { code: 0, stdout, stderr };
    } catch (error: any) { output.push(error.stdout, error.stderr); return { code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string }; }
  };
  const logged: string[] = [], original = { log: console.log, error: console.error, warn: console.warn };
  for (const method of ['log', 'error', 'warn'] as const) console[method] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); original[method](...args); };
  return {
    base, owner, master, checkout, gitRoot, providers, store, output, logged, cli, git,
    close: async () => { Object.assign(console, original); await providers.close(); await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }); await store.close(); },
  };
}

/** The owner approves acme/new-app and the hosting project new-app, moved from acme/old-app; the master takes its credential. */
async function approvedAndTaken(install: Awaited<ReturnType<typeof infraInstall>>) {
  const approved = await install.cli(install.owner, 'approve', 'acme/new-app', '--project', 'new-app', '--from', 'acme/old-app');
  assert.equal(approved.code, 0, approved.stderr);
  assert.equal((await install.cli(install.master, 'approve', 'acme/other', '--project', 'other')).stderr.trim().endsWith('Only the owner approves infra access."}'), true, 'the master cannot approve its own task');
  const taken = await install.cli(install.master, 'take');
  assert.equal(taken.code, 0, taken.stderr);
  const file = join(install.checkout, '.graphyard', 'infra-credential');
  const credential = JSON.parse(await readFile(file, 'utf8'));
  return { credential, file, taken };
}

test('integration:scoped-infra-access — the confined master creates and pushes the approved repository and creates the approved hosting project and its environments; the credential is in no Git object, log or output', async () => {
  const install = await infraInstall('scoped_infra_ac1');
  try {
    const { credential, file } = await approvedAndTaken(install);
    assert.equal((await stat(file)).mode & 0o777, 0o600, 'the credential is the session\'s alone');
    assert.deepEqual({ repository: credential.repository, project: credential.project }, { repository: 'acme/new-app', project: 'new-app' });
    assert.ok(!JSON.stringify(credential).includes(githubToken) && !JSON.stringify(credential).includes(railwayToken), 'the session never holds a provider token');

    for (const args of [['repo', 'create', 'acme/new-app'], ['repo', 'push', 'acme/new-app', install.checkout], ['project', 'create', 'new-app'], ['env', 'create', 'new-app', 'staging'], ['env', 'create', 'new-app', 'production']]) {
      const done = await install.cli(install.master, ...args);
      assert.equal(done.code, 0, `${args.join(' ')}: ${done.stderr}`);
    }
    // GitHub received the repository, and the push carried the checkout's main branch.
    assert.deepEqual(install.providers.calls.filter(call => call.path === '/orgs/acme/repos').map(call => [call.body.name, call.body.private, call.auth]), [['new-app', true, `Bearer ${githubToken}`]]);
    const pushed = join(install.gitRoot, 'acme', 'new-app.git');
    assert.equal(execFileSync('git', ['-C', pushed, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), install.git('rev-parse', 'main').trim());
    // Railway received the project and its two environments, on the project it created.
    const graph = install.providers.calls.filter(call => call.path === '/graphql');
    assert.deepEqual(graph.map(call => call.body.variables.input), [{ name: 'new-app' }, { projectId: 'prj-new-app', name: 'staging' }, { projectId: 'prj-new-app', name: 'production' }]);
    assert.ok(graph.every(call => call.auth === `Bearer ${railwayToken}`));

    // The credential is never written to Git or logs: not in the pushed or working repository's history, the ignored
    // credential file stays out of Git (here and in Graphyard's own checkout), and no output, server log or ledger row carries it.
    const secret = credential.token as string;
    for (const repo of [pushed, install.checkout]) assert.ok(!execFileSync('git', ['-C', repo, 'log', '--all', '-p'], { encoding: 'utf8' }).includes(secret));
    assert.equal(install.git('status', '--porcelain').trim(), '', 'nothing to commit: .graphyard is ignored');
    execFileSync('git', ['-C', root, 'check-ignore', '-q', '.graphyard/infra-credential']);
    const ledger = (await install.store.pool.query<{ row: string }>("SELECT actor || kind || payload::text AS row FROM events WHERE kind LIKE 'infra.%'")).rows.map(row => row.row).join('\n');
    for (const text of [install.output.join('\n'), install.logged.join('\n'), ledger]) {
      assert.ok(!text.includes(secret), 'the infra credential appears nowhere');
      assert.ok(!text.includes(githubToken) && !text.includes(railwayToken), 'no provider token appears either');
    }
  } finally { await install.close(); }
});

test('integration:scoped-infra-access — the credential is refused for any other repository or hosting project, including the one the task moved from, in one plain line', async () => {
  const install = await infraInstall('scoped_infra_ac2');
  try {
    await approvedAndTaken(install);
    const refusal = infraRefusal({ repository: 'acme/new-app', project: 'new-app' });
    assert.match(refusal, /^[^\n]+$/, 'one line');
    for (const args of [['repo', 'create', 'acme/old-app'], ['repo', 'push', 'acme/old-app', install.checkout], ['repo', 'create', 'acme/other'], ['project', 'create', 'old-app'], ['env', 'create', 'old-app', 'production']]) {
      const refused = await install.cli(install.master, ...args);
      assert.equal(refused.code, 1, args.join(' '));
      assert.equal(refused.stderr.trim(), refusal, `${args.join(' ')} reads the one refusal line`);
    }
    assert.equal(install.providers.calls.length, 0, 'no provider was called for a name outside the credential');
    // A credential not issued here is refused as well, and a credential is no Graphyard identity.
    const forged = await fetch(`${install.base}/api/infra/act`, { method: 'POST', headers: { Authorization: 'Bearer gyi_forged', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'repo.create', repository: 'acme/new-app' }) });
    assert.equal(forged.status, 401);
    const credential = JSON.parse(await readFile(join(install.checkout, '.graphyard', 'infra-credential'), 'utf8')).token;
    assert.equal((await fetch(`${install.base}/api/work-snapshot`, { headers: { Authorization: `Bearer ${credential}` } })).status, 401);
  } finally { await install.close(); }
});

test('e2e:scoped-infra-access — every call made with the credential is recorded with who, what and when and listed on the dashboard; guide infra names the route and forbids an unconfined session', async () => {
  const install = await infraInstall('scoped_infra_ac3');
  try {
    await approvedAndTaken(install);
    const started = Date.now();
    assert.equal((await install.cli(install.master, 'repo', 'create', 'acme/new-app')).code, 0);
    assert.equal((await install.cli(install.master, 'project', 'create', 'new-app')).code, 0);
    assert.equal((await install.cli(install.master, 'env', 'create', 'new-app', 'staging')).code, 0);
    assert.equal((await install.cli(install.master, 'repo', 'create', 'acme/old-app')).code, 1);

    const response = await fetch(`${install.base}/api/infra/actions`, { headers: { Authorization: `Bearer ${install.owner}` } });
    const { actions } = await response.json() as { actions: { who: string; at: string; action: string; target: string; outcome: string }[] };
    assert.deepEqual(actions.map(entry => [entry.who, entry.action, entry.target, entry.outcome]), [
      ['master', 'repo.create', 'acme/old-app', 'refused'],
      ['master', 'environment.create', 'new-app/staging', 'done'],
      ['master', 'project.create', 'new-app', 'done'],
      ['master', 'repo.create', 'acme/new-app', 'done'],
    ], 'who and what, newest first');
    for (const entry of actions) assert.ok(Date.parse(entry.at) >= started - 1000 && Date.parse(entry.at) <= Date.now() + 1000, 'when');
    // The CLI prints the same list.
    assert.deepEqual(JSON.parse((await install.cli(install.master, 'log')).stdout).actions, actions);

    // The Setup page shows them as one short list.
    const page = renderToStaticMarkup(createElement(SetupView, { status: {}, work: [], onConnect: () => {}, infra: actions }));
    assert.match(page, /Repository and hosting changes/);
    const list = page.match(/<ol class="infra-actions"[^>]*>(.*?)<\/ol>/)?.[1] ?? '';
    assert.equal(list.match(/<li>/g)?.length, 4, 'one row per call');
    for (const text of ['<b>master</b> Create repository acme/new-app<', 'Create hosting project new-app<', 'Create environment new-app/staging<', 'Create repository acme/old-app — refused']) assert.ok(list.includes(text), `the list reads ${text}`);
    assert.ok(!renderToStaticMarkup(createElement(SetupView, { status: {}, work: [], onConnect: () => {}, infra: [] })).includes('infra-actions'), 'nothing shows before any call');

    const guide = guideText('infra');
    assert.match(guide, /Creating a repository or a hosting project is one route, and a master never starts an unconfined session to do it\./);
    for (const command of ['graphyard infra approve OWNER/NAME --project NAME', 'graphyard infra take', 'infra repo create OWNER/NAME', 'infra repo push OWNER/NAME', 'infra project create NAME', 'infra env create NAME ENV', 'graphyard infra log']) assert.ok(guide.includes(command), `guide infra names ${command}`);
  } finally { await install.close(); }
});
