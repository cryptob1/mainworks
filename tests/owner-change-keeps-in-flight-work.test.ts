import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { dispatchWork, setupMaster, type WorkerProfile } from '../src/master.js';
import { recordLoopOwner } from '../src/check-in-author.js';
import { mergeSubject, trialMerge } from '../src/merge-writer/trial.js';
import { completePreflight } from '../src/cli/complete.js';
import type { Work } from '../src/model.js';
import { workFixture } from './helpers/work-fixture.js';
import { withDatabase } from './helpers/postgres.js';
import { recordedRuns } from './helpers/headless-runs.js';
import { registryFixture } from './helpers/registry-fixture.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { lifecycle } from './helpers/work-lifecycle.js';

// GY-3912: changing the owner while an attempt is in flight never strands its work. complete accepts
// commits authored with the current owner, the owner recorded on the attempt at its claim, or the
// install default; a running local session's next commit is authored with the new owner.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const ada = { name: 'Ada Lovelace', email: 'ada@example.com' }, grace = { name: 'Grace Hopper', email: 'grace@example.com' };
const form = (owner: { name: string; email: string }) => ({ GIT_AUTHOR_NAME: `${owner.name} (Mainworks)`, GIT_AUTHOR_EMAIL: owner.email });
const agent = 'graphyard-codex-9';
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/.test(name))) as Record<string, string>;

async function repository(label: string) {
  const root = await temporaryDirectory(label);
  const git = (args: string[], env: Record<string, string> = {}) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...clean(), ...env } }).trim();
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', agent]); git(['config', 'user.email', `${agent}@users.noreply.invalid`]); git(['config', 'commit.gpgsign', 'false']);
  await writeFile(join(root, 'a.txt'), 'base\n'); git(['add', '-A']); git(['commit', '-qm', 'base']);
  return { root, git };
}

test('integration:owner-change-keeps-in-flight-work-completable — the claim records the owner; after a change, old, new, mixed and default authors complete, a third is refused, the merge carries the current owner', { timeout: 120_000 }, async () => {
  const store = await withDatabase('owner-change-in-flight');
  await store.init();
  try {
    const engine = new Engine(store, 120, 'owner/project');
    const operator = { id: 'operator', role: 'admin', sessionKind: 'human' } as const, worker = { id: 'worker-a', role: 'worker', sessionKind: 'ai' } as const;
    const setOwner = (owner: { name: string; email: string }) => store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', ['operator', 'owner.set', JSON.stringify(owner)]);
    await setOwner(ada);
    let item = await lifecycle(engine, operator, { title: 'Keep work', type: 'chore', criteria: [{ id: 'AC-1', text: 'Keep it', proofs: ['e2e:keep'] }] }, { claim: worker });
    assert.deepEqual(item.lastAssignment?.checkInOwner, ada, 'the claim records the owner in force');
    await setOwner(grace);
    const claimOwner = item.lastAssignment!.checkInOwner;

    const { root, git } = await repository('owner-change-in-flight');
    const base = git(['rev-parse', 'HEAD']);
    git(['update-ref', 'refs/remotes/origin/main', base]);
    let n = 0;
    const commit = async (from: string, env: Record<string, string>) => {
      git(['checkout', '-q', '--detach', from]);
      await writeFile(join(root, `f${++n}.txt`), `${n}\n`); git(['add', '-A']); git(['commit', '-qm', `change ${n}`], env);
      return git(['rev-parse', 'HEAD']);
    };
    const complete = (head: string) => completePreflight(root, { key: 'GY-90' }, head, { owner: grace, claimOwner });

    await complete(await commit(base, form(ada)));
    await complete(await commit(base, form(grace)));
    // Mixed: old form, new form, the install default, and the merge a sync made under the old form.
    const first = await commit(base, form(ada)), second = await commit(first, form(grace)), third = await commit(second, { GIT_AUTHOR_NAME: 'Mainworks', GIT_AUTHOR_EMAIL: 'mainworks@localhost' });
    git(['checkout', '-q', 'main']); await writeFile(join(root, 'main.txt'), 'moved\n'); git(['add', '-A']); git(['commit', '-qm', 'main moves'], form(ada));
    const moved = git(['rev-parse', 'HEAD']);
    git(['update-ref', 'refs/remotes/origin/main', moved]);
    git(['checkout', '-q', '--detach', third]); git(['merge', '-q', '--no-edit', moved], form(ada));
    await complete(git(['rev-parse', 'HEAD']));

    // A third name, or the right name with another email, is refused in the existing one line.
    for (const env of [{ GIT_AUTHOR_NAME: 'Someone Else', GIT_AUTHOR_EMAIL: 'else@example.com' }, { ...form(ada), GIT_AUTHOR_EMAIL: 'other@example.com' }]) {
      const foreign = await commit(git(['rev-parse', 'refs/remotes/origin/main']), env);
      await assert.rejects(complete(foreign), (error: Error) => {
        assert.equal(error.message.split('\n').length, 1);
        assert.match(error.message, new RegExp(`^complete refused: commit ${foreign.slice(0, 12)} is authored '${env.GIT_AUTHOR_NAME.replace(/[()]/g, '\\$&')}'; every commit must be authored 'Grace Hopper \\(Mainworks\\) <grace@example.com>'`));
        return true;
      });
    }

    // The merge writer's merge commit carries the current owner.
    recordLoopOwner(grace);
    const head = await commit(base, form(ada));
    const merged = await trialMerge(async (args, env) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...clean(), ...env } }), { head, baseTip: git(['rev-parse', 'refs/remotes/origin/main']), subject: mergeSubject({ key: 'GY-90', title: 'Keep work' } as Work) });
    assert.ok('mergeSha' in merged);
    assert.equal(git(['show', '-s', '--format=%an <%ae>', merged.mergeSha]), 'Grace Hopper (Mainworks) <grace@example.com>');
  } finally { recordLoopOwner(null); await store.close(); }
});

test('integration:running-session-picks-up-the-new-owner — a session launched before the owner changed authors its next commit with the new owner, without a restart', async () => {
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) if (/^GIT_/.test(name)) delete process.env[name];
  try {
    const { root, git } = await repository('running-session-owner');
    recordLoopOwner(ada, root);
    const credentialDirectory = await temporaryDirectory('running-session-owner-credentials');
    const credential = join(credentialDirectory, 'worker.token'); await writeFile(credential, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
    git(['remote', 'add', 'origin', 'https://github.com/owner/project.git']);
    await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory }, (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main' }))) as typeof fetch);
    const profile: WorkerProfile = { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {} };
    const at = new Date().toISOString();
    const item = workFixture({ key: 'GY-91', title: 'Pick up the owner', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:x'] }], createdAt: at, updatedAt: at, stageEnteredAt: at, systemDriven: undefined });
    const worker = recordedRuns();
    await dispatchWork(root, item, profile, { allWork: [item], prepare: async () => ({ epoch: 1, path: root, base: 'c'.repeat(40) }), release: async () => {}, observedAt: at, headless: worker.exec, probe: registryFixture(hostname(), ['codex']).probe });
    const session = worker.runs[0]!.env;
    const commit = async (name: string) => {
      await writeFile(join(root, name), `${name}\n`);
      execFileSync('git', ['-C', root, 'add', '-A'], { env: session });
      execFileSync('git', ['-C', root, 'commit', '-qm', name], { env: session });
      return git(['show', '-s', '--format=%an <%ae>|%cn']);
    };
    assert.equal(await commit('before.txt'), 'Ada Lovelace (Mainworks) <ada@example.com>|mainworks-worker-a');
    // The owner changes; the loop's next snapshot records it. The same session, not restarted, commits again.
    recordLoopOwner(grace, root);
    assert.equal(await commit('after.txt'), 'Grace Hopper (Mainworks) <grace@example.com>|mainworks-worker-a', 'the running session authors with the new owner');
  } finally {
    recordLoopOwner(null);
    for (const [name, value] of Object.entries(saved)) if (/^GIT_/.test(name)) process.env[name] = value;
  }
});
