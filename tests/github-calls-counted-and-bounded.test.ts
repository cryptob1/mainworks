import './helpers/temp-dirs.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { mergeWriterReads, mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState, writeDaemonState, type DaemonState } from '../src/daemon/state.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { defaultChildRun } from '../src/child-runner.js';
import { writeMergeToken } from '../src/install/merge-token.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';
import { serveGitHttp } from './helpers/git-http-remote.js';

// GY-4070 AC-1, AC-2: the loop counts the GitHub API calls it makes on its cursor, by source; it reads
// the limit remaining from GitHub's response headers; and observation polling slows once the calls in
// the hour reach the install's share of the hourly limit. The stand-in GitHub is a scratch bare
// repository served over token-authenticated git smart HTTP on loopback, whose `GET /rate_limit`
// answer carries GitHub's headers: a low limit, with little of it left.

const TOKEN = 'github_pat_stand_in_token';
const RESET = '2030-01-01T01:00:00.000Z';

/** The stand-in GitHub: git over smart HTTP beside its rate-limit answer. `asked` holds each rate-limit request's authorization. */
async function standInGithub(projectRoot: string) {
  const log: string[] = [], asked: string[] = [];
  const server = await serveGitHttp(projectRoot, TOKEN, log, (request, response) => {
    if (!request.url!.endsWith('/rate_limit')) return false;
    asked.push(String(request.headers.authorization ?? 'none'));
    response.writeHead(200, { 'content-type': 'application/json', 'x-ratelimit-limit': '8', 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': String(Date.parse(RESET) / 1000), 'x-ratelimit-resource': 'core' })
      .end(JSON.stringify({ resources: { core: { limit: 8, remaining: 3 } } }));
    return true;
  });
  return { url: server.url, asked, close: server.close };
}

/** A coordinator checkout whose origin reaches nothing: only the explicit token URL, or an origin a test resets, can. */
async function fixture(label: string, credential: 'token' | 'deploy key', run: Record<string, unknown> = {}) {
  const directory = await temporaryDirectory(label), origin = join(directory, 'repo.git');
  const { root: checkout, head: baseTip } = await gitRepo({ root: join(directory, 'checkout'), files: { 'a.txt': 'base\n' } });
  git(directory, 'init', '-q', '--bare', '-b', 'main', origin); git(origin, 'config', 'http.receivepack', 'true');
  git(checkout, 'remote', 'add', 'origin', origin); git(checkout, 'push', '-q', '-u', 'origin', 'main');
  await writeFile(join(checkout, 'b.txt'), 'merge\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'merge');
  const mergeSha = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'reset', '-q', '--hard', baseTip);
  git(checkout, 'remote', 'set-url', 'origin', 'git@127.0.0.1:0/unreachable.git');
  await mkdir(join(directory, 'credentials'));
  const tokenFile = await writeMergeToken(join(directory, 'config', 'owner-project'), TOKEN);
  const config = masterConfigSchema.parse({ version: 1, repository: 'owner/project', baseBranch: 'main', url: 'https://graphyard.example', credentialFile: join(directory, 'credentials', 'coordinator.token'),
    cliPath: '/unused', githubAppId: 1, hostId: 'fixture', masterAgentName: 'fixture', workers: [], run: { ...run, mergeWriter: credential === 'token' ? { tokenFile } : { deployKeyFile: join(directory, 'unused-deploy-key') } } });
  return { directory, origin, checkout, baseTip, mergeSha, config };
}

/**
 * The loop's reads, counting their GitHub calls on `state`. A slowed poll's wait is recorded in `waits`
 * in full and slept for its first 300 ms, so the slowdown is both read and felt.
 */
function countedReads(f: Awaited<ReturnType<typeof fixture>>, state: DaemonState, url: string, waits: number[], run: typeof defaultChildRun = defaultChildRun,
  environment: Record<string, string | undefined> = { PATH: process.env.PATH!, GRAPHYARD_MERGE_WRITER_GIT_URL: url }) {
  return mergeWriterReads(f.config, f.checkout, run, { base: join(f.directory, 'managed'), record: async () => {}, environment,
    github: { state, sleep: async ms => { waits.push(ms); await delay(Math.min(ms, 300)); } }, githubApi: url });
}

/** One merge-writer step of a cycle with nothing on the board: the step that refreshes the limit reading. */
const step = (state: DaemonState, reads: MergeWriterReads) => mergeWriterStep({ state, effects: { mergeWriter: reads, persist: async () => {}, rework: async () => {} }, now: Date.now,
  snapshot: { work: [], now: new Date().toISOString() }, performed: [], log: () => {} } as unknown as Cycle);

/** `lead status` over the cursor `state` is persisted to. */
const status = (f: Awaited<ReturnType<typeof fixture>>, state: DaemonState) =>
  writeDaemonState(f.config, state).then(() => masterStatusReport(f.checkout, f.config, async () => ({ work: [], now: new Date().toISOString() }),
    (command, args, options) => command === 'git' ? defaultChildRun(command, args, options) : ''));

test('integration:github-calls-counted-and-bounded — observation polling slows once the calls in the hour reach the share, and not below it', { timeout: 120_000 }, async () => {
  const f = await fixture('github-calls-share', 'token', { githubCallSharePercent: 1 }), github = await standInGithub(f.directory), waits: number[] = [];
  try {
    // GitHub has answered nothing yet, so the share is of the 5,000 a user token allows an hour: one percent is 50 calls.
    const state = emptyDaemonState(f.config), reads = countedReads(f, state, github.url, waits);
    for (let call = 0; call < 50; call++) assert.equal(await reads.fetch(), f.baseTip);
    assert.deepEqual(waits, [], 'under the share every observation poll reaches GitHub at once');
    const before = performance.now();
    assert.equal(await reads.fetch(), f.baseTip, 'a slowed poll still answers the base tip');
    const elapsed = performance.now() - before;
    assert.equal(waits.length, 1, "polling slows once core's calls in the hour reach its share");
    assert.ok(waits[0]! > 0 && waits[0]! <= 10_000, `a slowed poll waits for the hour to drain, at most ten seconds: ${waits[0]}`);
    assert.ok(elapsed >= 300, `the slowed poll waited before it reached GitHub: ${Math.round(elapsed)} ms`);
  } finally { await github.close(); }
});

test("integration:github-calls-counted-and-bounded — status shows the hour's calls by source and the remaining limit from GitHub's headers, and says polling is slowed", { timeout: 60_000 }, async () => {
  const f = await fixture('github-calls-status', 'token'), github = await standInGithub(f.directory), waits: number[] = [];
  try {
    const state = emptyDaemonState(f.config), reads = countedReads(f, state, github.url, waits);
    await step(state, reads);
    assert.deepEqual(github.asked, [`Bearer ${TOKEN}`], "the loop reads the limit with the token its git calls carry, from GitHub's response headers");
    for (let call = 0; call < 4; call++) assert.equal(await reads.fetch(), f.baseTip);
    assert.deepEqual(waits, [], 'the first four polls go straight to GitHub: the default half of the 8 GitHub reports is 4');
    assert.equal(await reads.fetch(), f.baseTip);
    assert.equal(waits.length, 1, "the fifth poll waits: the hour's calls reached the share");
    await step(state, reads);
    assert.equal(github.asked.length, 1, 'the reading is refreshed at most once a minute');
    assert.equal(await reads.push(f.mergeSha, f.baseTip), 'pushed');
    await reads.pushVerified!(f.mergeSha);
    assert.match((await reads.pushReleaseTag!(f.mergeSha))!, /^v\d{4}\.\d+\.\d+-[0-9a-f]{12}$/);
    const report = await status(f, state), shown = report.github!;
    assert.deepEqual(shown.hour, { observation: 5, releasePublish: 2, other: 1, total: 8 }, "the last hour's calls by source");
    assert.deepEqual([shown.sharePercent, shown.budget], [50, 4], 'the default share is half of the limit GitHub reported');
    const { at, ...rateLimit } = shown.rateLimit!;
    assert.deepEqual(rateLimit, { limit: 8, remaining: 3, reset: RESET });
    assert.match(at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(shown.slowed!.since, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(shown.slowed!.waited, 1);
    assert.equal(shown.detail, "Observation polling is slowed: 8 GitHub API calls this hour (observation 5, release publish 2, other 1) reach this install's 50% share of 8.");
    assert.ok(report.attention.some(line => line.subject === 'GitHub API' && line.text === shown.detail), 'status says so where the owner looks');
  } finally { await github.close(); }
});

test("integration:github-calls-counted-and-bounded — a deploy key's pushes carry no token and are not counted; its fetch counts only when origin is GitHub over https", { timeout: 60_000 }, async () => {
  const f = await fixture('github-calls-deploy-key', 'deploy key'), state = emptyDaemonState(f.config), waits: number[] = [];
  // A repository beside the checkout, over a local path: no GitHub, no token; and no GitHub login answers on this host.
  git(f.checkout, 'remote', 'set-url', 'origin', f.origin);
  const noLogin: typeof defaultChildRun = (command, args, options) => command === 'gh' ? Promise.reject(new Error('not logged in')) : defaultChildRun(command, args, options);
  const local = countedReads(f, state, 'http://127.0.0.1:1/unused', waits, noLogin, { PATH: process.env.PATH! });
  assert.equal(await local.fetch(), f.baseTip); assert.equal(await local.fetch(), f.baseTip);
  assert.equal(await local.push(f.mergeSha, f.baseTip), 'pushed');
  await local.pushVerified!(f.mergeSha); await local.pushReleaseTag!(f.mergeSha);
  await step(state, local);
  let shown = (await status(f, state)).github!;
  assert.deepEqual(shown.hour, { observation: 0, releasePublish: 0, other: 0, total: 0 }, 'nothing of it reached GitHub');
  assert.deepEqual([shown.rateLimit, shown.slowed, shown.detail], [null, null, null], 'a GitHub login that answers nothing reads as no reading, never as a limit');
  assert.equal(shown.budget, 2500, 'with no reading from GitHub, the share is of the 5,000 a user token allows an hour');
  // GitHub over https: the fetch carries the host's token and counts, even when GitHub does not answer.
  git(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/owner/project.git');
  const offline: typeof defaultChildRun = (command, args, options) => args.includes('fetch') ? Promise.reject(new Error('offline: this test never reaches GitHub')) : defaultChildRun(command, args, options);
  await assert.rejects(countedReads(f, state, 'http://127.0.0.1:1/unused', waits, offline, { PATH: process.env.PATH! }).fetch(), /offline/);
  shown = (await status(f, state)).github!;
  assert.deepEqual(shown.hour, { observation: 1, releasePublish: 0, other: 0, total: 1 }, "a fetch over GitHub's https spends the token");
  assert.deepEqual(waits, []);
});
