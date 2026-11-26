import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { evaluate } from '../src/model-boundary/gates.js';
import { attestationExercise } from '../src/master/autonomy.js';
import { evaluateLandability } from '../src/model-boundary/landability.js';
import { landabilityRefusals } from '../src/model/landability.js';
import { proofPreview } from '../src/model/coordination.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';
import { lifecycle } from './helpers/work-lifecycle.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3716: a docs sign-off judges the documentation the candidate changes, so it stands for a
// later head of the same item whose documentation files are byte-identical; any other manual
// proof keeps binding to the exact head.

const repository = 'owner/docs-attestation-follows-content';
const DOCS = 'manual:docs-updated/guide', OTHER = 'manual:onboarding-files', E2E = 'e2e:fixture';
const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const master = { id: 'graphyard-master-docs-operator', role: 'operator-agent', sessionKind: 'ai', capabilities: [],
  scope: { repositories: [repository], workItems: ['*'] } } as unknown as Principal;

const id = () => randomUUID();
let store: Store, engine: Engine, fixtureRoot: string, checkout: string;

async function commit(cwd: string, files: Record<string, string>, message: string) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(cwd, path, '..'), { recursive: true });
    await writeFile(join(cwd, path), text); git(cwd, 'add', '--', path);
  }
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

before(async () => {
  fixtureRoot = await realpath(await temporaryDirectory('docs-attestation-follows-content'));
  ({ root: checkout } = await gitRepo({ root: join(fixtureRoot, 'checkout'), files: { 'src/feature.ts': 'export const feature = 1;\n', 'docs/guide.md': '# Guide\n' }, origin: true }));
  store = await withDatabase('docs-attestation-follows-content'); await store.init();
  engine = new Engine(store, 120, repository);
  engine.operatorAuthorizer = async (_db, _now, actor) => actor;
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
});
after(async () => { if (store) await store.close(); if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

/** A worktree on its own branch off main, holding one change to the feature and the guide. */
async function branch(name: string, guide: string) {
  const worktree = join(fixtureRoot, name.replaceAll('/', '-'));
  git(checkout, 'worktree', 'add', '-q', '-b', name, worktree, 'refs/remotes/origin/main');
  const head = await commit(worktree, { 'src/feature.ts': `export const feature = ${id().length};\n`, 'docs/guide.md': guide }, 'the change');
  return { worktree, head };
}
/** An item submitted on HEAD with both proofs attested by the master on it. */
async function submitted(name: string, head: string, attest: string[]): Promise<Work> {
  let work = await lifecycle(engine, admin, { type: 'bug', title: 'Docs signed off', criteria: [{ id: 'AC-1', text: 'The guide says what changed', proofs: [DOCS, OTHER] }, { id: 'AC-2', text: 'The fixture case passes', proofs: [E2E] }] }, { claim: worker, pull: true, workspace: { host: 'test', branch: name }, submit: { head } });
  for (const proof of attest) work = await engine.execute(master, 'evidence', work.id, { proof, sha: head, baseSha: work.candidate!.baseSha, policyRevision: work.policyRevision, result: 'pass', executed: 1, skipped: 0, reason: 'the guide matches the change', ...attestationExercise(work, proof) }, id());
  return work;
}
/** The merge writer's trial of the current head, with the fixture case passing. */
const tried = (work: Work): Work => ({ ...work, mergeLedger: { ...work.mergeLedger, trial: { head: work.candidate!.sha, mergeSha: work.candidate!.sha, proofs: { [E2E]: { executed: 1, failed: 0, skipped: 0 } } } } as unknown as Work['mergeLedger'] });
/** The item goes back to its worker, who submits HEAD as its next attempt. */
async function resubmit(work: Work, head: string): Promise<Work> {
  work = await engine.execute(admin, 'rework', work.id, { reason: 'take main', previousWorkerStopped: true }, id());
  const pulled = await engine.pullAssignment(worker, { work: work.id }, id());
  work = await engine.execute(worker, 'workspace', pulled.assigned!.id, { epoch: pulled.assigned!.epoch, host: 'test', path: `/tmp/docs-attest/${work.key}`, branch: work.candidate!.branch }, id());
  return engine.execute(worker, 'submit', work.id, { epoch: work.epoch, head }, id());
}
const acceptance = (work: Work) => landabilityRefusals(evaluateLandability(work, [work], new Date()), 'acceptance');
const owes = (work: Work, proof: string) => acceptance(work).some(reason => reason.includes(`${proof} needs trusted passing evidence`));

test('unit:docs-attestation-follows-content — a docs attestation stores the digest of the candidate\'s documentation files; a later head of the same item with identical docs inherits it, one changed character does not, another item never does; other manual proofs bind the exact head', { timeout: 300_000 }, async () => {
  const { worktree, head } = await branch('graphyard/gy-1-1', '# Guide\n\nThe feature is on.\n');
  let work = await submitted('graphyard/gy-1-1', head, [DOCS, OTHER]);
  const attestation = work.evidence.find(entry => entry.proof === DOCS)!;
  assert.match(attestation.docsDigest ?? '', /^[0-9a-f]{64}$/, 'the attestation records the docs digest');
  assert.equal(attestation.docsDigest, work.observation!.docsDigest);
  assert.equal(work.evidence.find(entry => entry.proof === OTHER)!.docsDigest, undefined, 'only a docs proof records it');
  assert.deepEqual(acceptance(tried(work)), []);

  // Same docs, new head: the docs sign-off inherits; the other manual proof does not.
  const same = await commit(worktree, { 'src/feature.ts': 'export const feature = 42;\n' }, 'code only');
  work = await resubmit(work, same);
  assert.equal(work.candidate!.sha, same);
  assert.equal(owes(work, DOCS), false, 'identical docs: the sign-off stands');
  assert.equal(owes(work, OTHER), true, 'any other manual proof binds the exact head');
  const shown = proofPreview(work, [work], new Date()).find(entry => entry.proof === DOCS)!;
  assert.equal(shown.stands, `stands from ${head.slice(0, 12)}`);

  // One changed character in the docs: a new attestation is needed.
  const changed = await commit(worktree, { 'docs/guide.md': '# Guide\n\nThe feature is On.\n' }, 'docs edit');
  work = await resubmit(work, changed);
  assert.equal(owes(work, DOCS), true, 'a docs byte changed: the sign-off no longer stands');

  // Another item with byte-identical docs never inherits the first item's sign-off.
  const other = await branch('graphyard/gy-2-1', '# Guide\n\nThe feature is on.\n');
  const second = await submitted('graphyard/gy-2-1', other.head, []);
  assert.equal(second.observation!.docsDigest, attestation.docsDigest, 'the same docs content');
  assert.equal(owes(second, DOCS), true, 'another item never inherits');
});

test('e2e:docs-signoff-survives-rebase — the master attests a docs proof, main moves with an unrelated change, the merged head is resubmitted and the acceptance gate passes without a second attestation', { timeout: 300_000 }, async () => {
  const { worktree, head } = await branch('graphyard/gy-3-1', '# Guide\n\nRebased docs.\n');
  let work = await lifecycle(engine, admin, { type: 'bug', title: 'Docs survive a rebase', criteria: [{ id: 'AC-1', text: 'The guide says what changed', proofs: [DOCS] }, { id: 'AC-2', text: 'The fixture case passes', proofs: [E2E] }] }, { claim: worker, pull: true, workspace: { host: 'test', branch: 'graphyard/gy-3-1' }, submit: { head } });
  work = await engine.execute(master, 'evidence', work.id, { proof: DOCS, sha: head, baseSha: work.candidate!.baseSha, policyRevision: work.policyRevision, result: 'pass', executed: 1, skipped: 0, reason: 'the guide matches the change', ...attestationExercise(work, DOCS) }, id());
  assert.deepEqual(acceptance(tried(work)), []);

  // Main moves with an unrelated change; the worker merges it and resubmits the merged head.
  await commit(checkout, { [`src/unrelated-${id()}.ts`]: 'export {};\n' }, 'another item');
  git(checkout, 'push', '-q', 'origin', 'main');
  git(worktree, 'merge', '-q', '--no-edit', 'refs/remotes/origin/main');
  const merged = git(worktree, 'rev-parse', 'HEAD');
  work = await resubmit(work, merged);
  assert.equal(work.candidate!.sha, merged);
  assert.notEqual(work.candidate!.baseSha, work.evidence[0]!.baseSha, 'main moved');
  assert.equal(work.evidence.filter(entry => entry.proof === DOCS).length, 1, 'one attestation only');
  work = tried(work);
  const gate = evaluate(work, [work], new Date()).gates.find(entry => entry.name === 'acceptance')!;
  assert.deepEqual(gate.reasons, [], 'the acceptance gate passes on the merged head');
  assert.equal(gate.passed, true);
});
