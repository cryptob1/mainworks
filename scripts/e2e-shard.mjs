// GY-3874: one shard of the daily e2e catalog on a test machine. The host shim runs it in the trial
// image over the commit's checkout: it reads the case files the shard holds from LIST, runs them as a
// trial runs its bound cases, and writes one JSON line per case to RECORDS for the coordinator.
// Usage: node --import tsx scripts/e2e-shard.mjs LIST RECORDS BUDGET_MS [screenshots]
// GY-4002: a merge trial's shard passes `screenshots` to keep each case's last screenshot; a shard that
// cannot make its worktree or build marks its cases host failures, so a trial runs them on the coordinator.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { volatileFilesystem } from '../src/install/worktree-root.ts';
import { runTrialE2eCases } from '../src/merge-writer/e2e-trial.ts';
import { buildArgv, packageManager } from '../src/package-manager.ts';

const [list, records, budget, keep] = process.argv.slice(2), written = resolve(records);
const proofs = readFileSync(resolve(list), 'utf8').split('\n').map(line => line.match(/^e2e\/cases\/(.+)\.json$/)?.[1]).filter(Boolean).map(id => `e2e:${id}`);
const mergeSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
writeFileSync(written, '');
// GY-3974: a test machine runs several catalog shards over one clone at once, and a shard serves the head from
// where it works (scripts/e2e-serve.mjs writes its seed file into the checkout, GY-3666), so each works in its
// own worktree of the commit, as a trial's checkout is one: its own files and index, the clone's objects and packages.
// GY-4105: a remote shard container mounts /tmp (and HOME=/tmp) as tmpfs while <run>/repo sits on durable disk;
// a worktree on tmpfs fails verifyWorktreeRoot, so place the shard scratch beside the checkout on durable storage.
const checkout = process.cwd();
const durableScratchBase = () => {
  const current = tmpdir();
  if (!volatileFilesystem(current)) return current;
  for (const candidate of [join(dirname(checkout), 'tmp'), ...(volatileFilesystem(homedir()) ? [] : [join(homedir(), '.gy', 'tmp')])]) {
    try { mkdirSync(candidate, { recursive: true }); if (!volatileFilesystem(candidate)) return candidate; } catch { /* try next */ }
  }
  return current;
};
const scratch = mkdtempSync(join(durableScratchBase(), 'e2e-shard-')), worktree = join(scratch, 'checkout');
const git = args => execFileSync('git', args, { stdio: 'pipe' });
/** The shard ends with its worktree, as a trial does, leaving the clone as the shim made it. */
const finish = code => {
  try { git(['-C', checkout, 'worktree', 'remove', '--force', worktree]); } catch { /* never registered, or already gone */ }
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  process.exit(code);
};
/** Every case of the shard fails with one step when its worktree or build fails, so the day's filing names why. */
const refuse = (step, error) => {
  const failingStep = `${step} failed: ${String(error.stderr || error.stdout || error.message).trim().split('\n').slice(-5).join(' | ')}`;
  for (const proof of proofs) appendFileSync(written, `${JSON.stringify({ proof, case: proof.slice(4), executed: 0, failed: 1, failingStep, hostFailure: true })}\n`);
  finish(1);
};
try {
  git(['worktree', 'add', '--detach', worktree, mergeSha]);
  if (existsSync(join(checkout, 'node_modules'))) symlinkSync(join(checkout, 'node_modules'), join(worktree, 'node_modules'));
  process.chdir(worktree);
} catch (error) { refuse(`the shard's worktree of ${mergeSha.slice(0, 12)}`, error); }
// GY-3968: the shard's checkout is a fresh clone, so build it first as a trial does: a served dashboard needs dist/.
const scripts = existsSync('package.json') ? JSON.parse(readFileSync('package.json', 'utf8')).scripts : undefined;
const build = scripts?.build ? buildArgv(packageManager(worktree), null) : null;
if (build) {
  try { execFileSync(build[0], build.slice(1), { stdio: 'pipe', maxBuffer: 64 << 20 }); }
  catch (error) { refuse(`the build step ${build.join(' ')}`, error); }
}
const cases = await runTrialE2eCases({ worktree, mergeSha, proofs, env: { ...process.env }, scratch,
  budgetMs: Number(budget), holds: async path => existsSync(join(worktree, path)), log: line => console.log(line) });
for (const entry of cases) appendFileSync(written, `${JSON.stringify(keep === 'screenshots' ? entry : { ...entry, screenshot: undefined })}\n`);
finish(cases.some(entry => entry.failed > 0 || entry.missing || entry.executed === 0) ? 1 : 0);
