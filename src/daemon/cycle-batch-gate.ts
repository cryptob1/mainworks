import { featureMapCaseId } from '../app-feature-check.js';
// Concern: the loop's batch gate on main (GY-3119): one gate at a time beside the cycle, the
// scheduled diagnostics beside it, both over the merge writer's trial container and git.
import type { Work } from '../model.js';
import { bootstrapGate, clearGateNote, gateLimitMs, type CatalogShard, type DiagnosePort, gateOutcomeReason, gateRecordPath, mergeFilings, readGateRecord, runDiagnostics, runGate, writeGateRecord, type GatePorts, type GateRecord } from '../batch-gate.js';
import { mainworksRepository } from '../scenarios.js';
import { releaseNotesPath, releaseNote, appendReleaseNote } from '../release-notes.js';
import { deployRecordPath, readDeployRecord } from '../deploy-watch.js';
import { notCovered, servedPreviewCases } from '../merge-writer/served-previews.js';
import { onboardingCase } from '../onboarding-time.js';
import { baseStillFails, relandItemFor, revertMergeCommit, serveLandings, serveRangeCommits, trialAndPushRevert, type ServeRevertPorts } from '../merge-writer/serve-revert.js';
import { gateTrialKey, trialStartOwner, trialStartWaiting } from '../merge-writer/trial-load.js';
import { HostDroppedError, localOnlyTestPattern, realFreeCores } from '../merge-writer/remote-shards.js';
import { heavyTrial, trialShareAllowance, type MergeWriterReads } from './cycle-merge-writer.js';
import { criterionProofs, e2eProofsOf, openFlakyItem } from '../merge-writer/executor.js';
import type { Cycle } from './cycle.js';
import { actionLine } from './run.js';
import { actionDetailMax, message, storeAction } from './state.js';
import { batchGateFlights as flights, busyTrialSlots } from './trial-slots.js';
import { fileLoopFault, gateFiledItem, readProjectCapabilities, repairedProof } from './control-plane.js';
import { currentEvidence } from '../model/evidence.js';
import { EnvironmentFault, declaredEnvironments, environmentSecretsFile, environmentStatePath, localEnvironment, loopLifecycle, trustedCheckout, type AppEnvironment } from '../app-environments.js';
import { installSecretsDirectory } from '../e2e/steps.js';
import { declarationSlot, heavyJobsDirectory, liveSlots } from '../master/verification-slots.js';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readTrialRunSpec, trialRunsDirectory, type TrialRunHandle } from '../merge-writer/trial-run.js';
import { runFiles } from '../runner/pi.js';

/** The gate's own item key in the trial (a proofless pseudo-item, like a revert's). */
const gateKey = gateTrialKey;
/** GY-3811: the full-suite diagnostics trial's input digest (build + affected over package.json), constant across commits. */
const suiteInput = createHash('sha256').update(JSON.stringify([[], ['package.json']])).digest('hex');
const isSameDiagnosticsKind = (isSuite: boolean) => (entry: { input: string }) => isSuite ? entry.input === suiteInput : entry.input !== suiteInput;

/**
 * GY-3811: adopt an existing detached diagnostics run before starting another — first from
 * `diagnosticsTrials` regardless of which verified commit started it, then by scanning
 * `.graphyard/trial-runs` for an unfinished diagnostics run (no `exit` file, spec key
 * `batch-gate`, not the gate's own `inFlight` run).
 */
async function adoptDiagnosticsTrial(
  file: string,
  root: string,
  isSuite: boolean,
  adopt: NonNullable<MergeWriterReads['adoptTrialRun']>,
): Promise<{ handle: TrialRunHandle; commit: string; fromDisk: boolean } | null> {
  const latest = readGateRecord(file);
  const earlier = latest?.diagnosticsTrials?.find(isSameDiagnosticsKind(isSuite));
  if (earlier) {
    const handle = await adopt({ key: gateKey, head: earlier.commit, mergeSha: earlier.commit, directory: earlier.directory });
    if (handle) return { handle, commit: earlier.commit, fromDisk: false };
  }
  const runsRoot = trialRunsDirectory(root);
  const exclude = latest?.inFlight?.run?.directory;
  const entries = await readdir(runsRoot).catch(() => [] as string[]);
  const candidates: { commit: string; directory: string; startedAt: string }[] = [];
  for (const entry of entries) {
    const directory = join(runsRoot, entry);
    if (directory === exclude || directory === earlier?.directory || existsSync(runFiles(directory).exit)) continue;
    const spec = await readTrialRunSpec(directory);
    if (!spec || spec.key !== gateKey) continue;
    const matches = isSuite
      ? spec.proofs.length === 0 && spec.changedFiles.length === 1 && spec.changedFiles[0] === 'package.json'
      : spec.changedFiles.length === 0 && spec.proofs.length > 0;
    if (matches) candidates.push({ commit: spec.head, directory, startedAt: spec.startedAt });
  }
  candidates.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const candidate of candidates) {
    const handle = await adopt({ key: gateKey, head: candidate.commit, mergeSha: candidate.commit, directory: candidate.directory });
    if (handle) return { handle, commit: candidate.commit, fromDisk: true };
  }
  return null;
}
/** How many lines of a failure's output its diagnostic filing carries (GY-3265). */
const outputLines = 80;
const lines = (out: string) => out.split('\n').map(line => line.trim()).filter(Boolean);

/**
 * GY-3336: the cursor key of the standing fetch-refusal line. A remote that refuses the base
 * branch's fetch — a SAML organization that has not authorised the merge writer's SSH key — is the
 * owner's to fix, so the loop raises one attention line quoting the remote's refusal and the fix
 * (an ssh configuration file ssh itself refuses is named as that host fault instead, GY-3470),
 * and retries the fetch with a growing backoff instead of failing every cycle.
 */
export const fetchRefusalKey = 'fetch-refusal';
/** How long the loop waits before refetching after the refusal's `attempts`-th failure: one minute doubling, capped at fifteen. */
export const fetchRetryBackoffMs = (attempts: number) => Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
/** git's generic trailer for every refused remote read; the remote's own words come above it. */
const genericFetchFailure = /^fatal: (?:Could not read from remote repository|could not read from remote repository)/;
/** The remote's refusal, as one line quoting it: the first non-generic line of git's stderr, else the error's own words. */
export function fetchRefusalLine(repository: string, baseBranch: string, error: unknown): string {
  const failed = error as { stderr?: unknown };
  const quoted = `${typeof failed?.stderr === 'string' ? failed.stderr : ''}\n${message(error)}`.split('\n')
    .map(line => line.trim()).filter(line => line && !genericFetchFailure.test(line));
  const refusal = (quoted[0] ?? message(error).split('\n')[0] ?? 'the fetch failed').slice(0, 300);
  // GY-3470: ssh refusing one of its own configuration files never reached the remote — a host fault, not the owner's authorization.
  const sshConfig = /Bad owner or permissions on (\S+)/.exec(refusal);
  if (sshConfig) return `The fetch of ${baseBranch} for ${repository} never reached the remote: ssh refuses its configuration file ${sshConfig[1]} ("${refusal}"). This is the host's SSH configuration, not the repository's authorization: make that file owned by root or by the loop's user and writable only by its owner, and the loop retries with backoff until then.`.slice(0, actionDetailMax);
  // GY-3464: only GitHub's SAML SSO refusal earns the authorisation advice; any other failure is reported in its own words.
  if (!/SAML SSO/i.test(refusal)) return `The fetch of ${baseBranch} for ${repository} fails: "${refusal}". Fix what it names, and the loop retries with backoff until then.`.slice(0, actionDetailMax);
  return `The remote refuses the fetch of ${baseBranch} for ${repository}: "${refusal}". The owner must authorise the merge writer's access — authorise the SSH key for the SAML organization on GitHub (Settings → SSH and GPG keys → Configure SSO → Authorize), or reinstall with --push-auth gh so the merge writer fetches over https with the gh login — and the loop retries with backoff until then.`.slice(0, actionDetailMax);
}

/**
 * What one trial run of `checks` on `commit` failed, as gate check ids, with each failing case's
 * failing-step text as the trial supplied it (GY-3264) and the last lines of its output (GY-3265:
 * the failing step's for a case, the trial log's for the build or a test file); the trial is bounded
 * by `timeoutMs`, the gate's own clock, never the merge-trial deadline (GY-3142).
 */
async function trialFailures(reads: MergeWriterReads, commit: string, checks: readonly string[], files: readonly string[], timeoutMs: number, trusted: () => string | null = () => null, skipFaults = false, signal?: AbortSignal, onStep?: (step: string) => void): Promise<{ failed: string[]; details: Record<string, string>; outputs: Record<string, string[]>; assertions: Record<string, string>; flaked: string[] }> {
  const cases = checks.filter(check => check.startsWith('e2e:'));
  const tests = checks.includes('affected') ? files : checks.filter(check => check.startsWith('test:')).map(check => check.slice(5));
  const environments = await gateEnvironments(reads, commit, cases, trusted());
  const runCases = cases.filter(proof => !(proof in environments.unknown) && !environments.untrusted.includes(proof));
  const trial = (origins: Record<string, string>, skipped: readonly string[]) => {
    const proofs = runCases.filter(proof => !skipped.includes(proof));
    return reads.trial(commit, tests, { key: gateKey, criteria: proofs.length ? [{ id: 'AC-1', text: 'The batch gate cases pass', proofs }] as Work['criteria'] : [], ...(Object.keys(origins).length ? { environments: origins } : {}) }, trusted() ?? undefined, onStep, undefined, undefined, undefined, signal, timeoutMs);
  };
  // GY-3296: each named environment is provisioned around the one trial, its URL handed to its cases.
  // An environment wait or fault throws for the gate, which retries; the diagnostics (`skipFaults`)
  // leave that environment's cases out and run the rest, so an outage never reruns the whole suite.
  const named = [...environments.named];
  const nest = async (index: number, origins: Record<string, string>, skipped: readonly string[]): ReturnType<typeof trial> => {
    if (index === named.length) return trial(origins, skipped);
    const [name, proofs] = named[index]!;
    try {
      return await environments.lifecycle!.use(name, environments.definitions[name]!, commit, environments.cwd!,
        url => nest(index + 1, { ...origins, ...Object.fromEntries(proofs.map(proof => [proof.slice(4), url])) }, skipped),
        run => !(run.e2e ?? []).some(entry => proofs.includes(entry.proof) && (entry.failed > 0 || entry.executed === 0)));
    } catch (error) {
      if (!skipFaults || !(error instanceof EnvironmentFault) || error.environment !== name) throw error;
      return nest(index + 1, origins, [...skipped, ...proofs]);
    }
  };
  const run = await nest(0, {}, []);
  const failed = [...Object.keys(environments.unknown), ...(run.build === 'fail' ? ['build'] : []),
    ...(run.e2e ?? []).filter(entry => entry.failed > 0 || entry.missing || entry.executed === 0).map(entry => entry.proof),
    ...run.tests.failed.map(file => `test:${file}`)];
  // GY-3305: a failing test check keeps its own identity in the record's detail — the browser
  // suite's failing spec, test and error from the trial's verdict — and one whose run named no
  // failing test says so explicitly: teardown warnings can neither crowd it out of the tail nor
  // pass for a diagnosis that was never made.
  const testDetail = run.failingCase ?? (run.tests.failed.length ? 'the run named no failing test or error: nothing in its output establishes a cause' : null);
  const details = Object.fromEntries([
    ...Object.entries(environments.unknown),
    ...(run.e2e ?? []).filter(entry => entry.failingStep).map(entry => [entry.proof, entry.failingStep!]),
    ...(testDetail ? run.tests.failed.slice(0, 1).map(file => [`test:${file}`, testDetail]) : []),
  ]);
  const logTail = (run.logTail ?? '').split('\n').filter(line => line.trim()).slice(-outputLines);
  const outputs = Object.fromEntries([...(run.e2e ?? []).filter(entry => entry.output?.length).map(entry => [entry.proof, entry.output!.slice(-outputLines)]),
    ...failed.filter(check => !check.startsWith('e2e:') && logTail.length).map(check => [check, logTail])]);
  return { failed: failed.filter(check => checks.includes(check) || (check.startsWith('test:') && checks.includes('affected'))), details, outputs,
    assertions: run.assertions ?? {}, flaked: run.flaked?.files ?? [] };
}

type CatalogRun = { failed: string[]; details: Record<string, string>; outputs: Record<string, string[]> };

/**
 * GY-3874: the daily catalog's cases split into shards, one per ready test machine and one for this
 * machine, as a merge trial splits its test files; the cases a remote shard cannot run (Docker,
 * nested confinement, a named environment) stay in this machine's shard. Each remote shard goes to the
 * host with the most free CPU first and, when that host drops it, to the next; this machine's shard
 * is one ordinary trial. Every shard ends by `deadline`, the 45-minute limit.
 */
async function shardedCatalog(reads: MergeWriterReads & { git: NonNullable<MergeWriterReads['git']> }, commit: string, cases: readonly string[], deadline: number,
  survive: (run: Promise<CatalogRun>) => Promise<CatalogRun>, trusted: () => string | null): Promise<CatalogRun & { shards: CatalogShard[] }> {
  const remote = await reads.gate?.catalogHosts?.(commit, deadline).catch(() => undefined);
  try {
    const hosts = [...remote?.hosts ?? []].sort((a, b) => realFreeCores(b) - realFreeCores(a));
    const shards: string[][] = Array.from({ length: hosts.length + 1 }, () => []);
    const roaming: string[] = [];
    // A case bound to a Compose application needs Docker, which only this machine gives it.
    let compose = new Set<string>();
    try {
      const delivery = JSON.parse(await reads.git(['show', `${commit}:graphyard.json`])).delivery ?? {};
      const kinds = new Map<string, string>((delivery.applications ?? []).map((application: { id: string; kind: string }) => [application.id, application.kind]));
      compose = new Set(Object.entries<string>(delivery.cases ?? {}).filter(([, app]) => kinds.get(app) === 'compose').map(([id]) => `e2e:${id}`));
    } catch { /* no graphyard.json binds a case */ }
    for (const proof of hosts.length ? cases : []) {
      const text = await reads.git(['show', `${commit}:e2e/cases/${proof.slice(4)}.json`]).catch(() => '');
      const tests = await Promise.all([...new Set(text.match(/tests\/[\w./-]+\.[cm]?[jt]s/g) ?? [])].map(file => reads.git(['show', `${commit}:${file}`]).catch(() => '')));
      (compose.has(proof) || localOnlyTestPattern.test([text, ...tests].join('\n')) || /"environment"/.test(text) ? shards[0]! : roaming).push(proof);
    }
    // Each case any machine may run goes to the shard holding the fewest, so this machine's local-only cases count against its share.
    if (!hosts.length) shards[0]!.push(...cases);
    for (const proof of roaming) shards.reduce((fewest, shard) => shard.length < fewest.length ? shard : fewest).push(proof);
    const failure = (detail: string): CatalogRun => ({ failed: ['e2e-catalog'], details: { 'e2e-catalog': detail }, outputs: {} });
    const dropped = new Set<string>();
    const onHost = async (index: number): Promise<CatalogRun & CatalogShard> => {
      const group = shards[index]!, reasons: string[] = [];
      for (const host of [hosts[index - 1]!, ...hosts.filter((_, other) => other !== index - 1)].filter(host => !dropped.has(host.name))) {
        try {
          const ran = await remote!.run(host.name, index, group);
          // A case the trial leaves out (a Compose preview or the fixture's own application) returns no
          // result, here as on this machine; the daily served run proves it.
          const failing = ran.filter(entry => entry.failed > 0 || entry.missing || entry.executed === 0);
          return { host: host.name, cases: group.length, failed: failing.map(entry => entry.proof),
            details: Object.fromEntries(failing.filter(entry => entry.failingStep).map(entry => [entry.proof, entry.failingStep!])),
            outputs: Object.fromEntries(failing.filter(entry => entry.output?.length).map(entry => [entry.proof, entry.output!.slice(-outputLines)])) };
        } catch (error) {
          if (!(error instanceof HostDroppedError)) return { host: host.name, cases: group.length, ...failure(`shard ${index + 1} on ${host.name}: ${message(error)}`) };
          dropped.add(host.name);
          reasons.push(error.message);
        }
      }
      return { host: 'none', cases: group.length, ...failure(`no test machine took shard ${index + 1} of ${group.length} cases: ${reasons.join('; ')}`) };
    };
    const ran = await Promise.all(shards.map(async (group, index): Promise<CatalogRun & CatalogShard> => index > 0 ? group.length ? onHost(index) : { host: 'none', cases: 0, failed: [], details: {}, outputs: {} }
      : { host: 'local', cases: group.length, ...group.length ? await survive(trialFailures(reads, commit, group, [], gateLimitMs, trusted, true)) : { failed: [], details: {}, outputs: {} } }));
    return { failed: [...new Set(ran.flatMap(shard => shard.failed))], outputs: Object.assign({}, ...ran.map(shard => shard.outputs)),
      details: ran.reduce<Record<string, string>>((all, shard) => {
        for (const [check, detail] of Object.entries(shard.details)) all[check] = all[check] ? `${all[check]}; ${detail}` : detail;
        return all;
      }, {}),
      shards: ran.filter(shard => shard.cases).map(({ host, cases }) => ({ host, cases })) };
  } finally { await remote?.close().catch(() => undefined); }
}

/**
 * GY-3296: the named environments the gate's `cases` need at `commit`, defined by graphyard.json at
 * the trusted base — the last verified commit — and run from its checkout. A case naming an
 * environment the commit declares but the base does not yet waits for that declaration to be
 * verified; one naming an environment neither declares fails with the configuration to fix.
 */
async function gateEnvironments(reads: MergeWriterReads, commit: string, cases: readonly string[], base: string | null) {
  const none = { named: new Map<string, string[]>(), unknown: {} as Record<string, string>, untrusted: [] as string[], definitions: {} as Record<string, AppEnvironment>, cwd: null as string | null, lifecycle: null as ReturnType<typeof loopLifecycle> | null };
  const git = reads.git, gate = reads.gate;
  if (!git || !gate || !cases.length) return none;
  // One grep names the few case files that declare any environment; only those are read.
  const declaring = lines(await git(['grep', '-l', '"environment"', commit, '--', 'e2e/cases/']).catch(() => ''))
    .map(line => line.slice(line.indexOf(':') + 1)).filter(path => cases.includes(`e2e:${path.slice('e2e/cases/'.length, -'.json'.length)}`));
  const wanted = new Map<string, string[]>();
  for (const path of declaring) {
    let name = localEnvironment;
    try { name = JSON.parse(await git(['show', `${commit}:${path}`])).environment ?? localEnvironment; } catch { /* the trial names a case that does not parse */ }
    if (name !== localEnvironment) wanted.set(name, [...wanted.get(name) ?? [], `e2e:${path.slice('e2e/cases/'.length, -'.json'.length)}`]);
  }
  if (!wanted.size) return none;
  const show = (at: string) => git(['show', `${at}:graphyard.json`]).catch(() => null);
  const definitions = base ? declaredEnvironments(await show(base)) : {};
  const atCommit = declaredEnvironments(await show(commit));
  const result = { ...none, named: new Map<string, string[]>(), definitions };
  for (const [name, proofs] of wanted) {
    if (definitions[name]) result.named.set(name, proofs);
    else if (atCommit[name]) result.untrusted.push(...proofs);
    else for (const proof of proofs) result.unknown[proof] = `case ${proof.slice(4)} names environment "${name}", which graphyard.json e2e.environments does not declare: declare it with up and down commands, or remove "environment" to run on local`;
  }
  if (result.named.size) {
    result.cwd = await trustedCheckout(git, gate.root, base!);
    result.lifecycle = gate.environments ?? loopLifecycle(environmentStatePath(gate.root), () => join(installSecretsDirectory(gate.root), environmentSecretsFile));
  }
  return result;
}

export { fileFlakyCheck, gateFiledItem, pinningProof, repairedProof } from './control-plane.js';

/**
 * GY-3443: while the gate's last outcome is verified, every open item owing `manual:batch-gate-repaired`
 * whose candidate head has no current evidence for it gets a trusted pass citing the verified tip.
 * A held, reverted or failed last outcome records nothing; a head already recorded is skipped, so a
 * cycle writes at most once per item head.
 */
async function recordRepaired(record: GateRecord, work: readonly Work[], attest: NonNullable<MergeWriterReads['attest']>, now: number, note: (key: string, state: 'done' | 'failed', detail: string) => void) {
  const last = record.lastOutcome;
  if (last?.outcome !== 'verified' || !last.tip) return;
  const owing = work.filter(item => item.stage !== 'done' && item.candidate && item.criteria?.some(criterion => criterion.proofs.includes(repairedProof))
    && !currentEvidence(item, repairedProof, new Date(now)));
  for (const item of owing) {
    const head = item.candidate!.sha;
    try {
      await attest(item, repairedProof, `The batch gate verified ${last.tip} at ${last.finishedAt}`, `batch-gate-repaired:${item.id}:${head}:${item.policyRevision}:${last.tip}`);
      note(`batch-gate-repaired:${item.key}`, 'done', `Recorded ${repairedProof} on ${item.key} head ${head.slice(0, 12)}: the batch gate verified ${last.tip.slice(0, 12)}`);
    } catch (error) { note(`batch-gate-repaired:${item.key}`, 'failed', `Could not record ${repairedProof} on ${item.key}: ${message(error)}`); }
  }
}

/** The gate's ports over the merge writer's reads. */
export function batchGatePorts(reads: MergeWriterReads & { git: NonNullable<MergeWriterReads['git']> }, work: readonly Work[], trusted: () => string | null = () => null): GatePorts & { diagnose: DiagnosePort } {
  const git = reads.git;
  // GY-3973: the work a run holds predates its own filings, so an item these ports filed is open to them until a later cycle's work says otherwise.
  const filed = new Set<string>();
  const file = async ({ refile, ...input }: { title: string; description: string; key: string; refile?: string }) => {
    const ref = trusted() ?? `refs/remotes/origin/${reads.baseBranch}`;
    const capabilities = await readProjectCapabilities(git, ref).catch(() => undefined);
    const result = await fileLoopFault(
      { work, now: reads.now(), createWork: reads.createWork, note: reads.note },
      gateFiledItem(input, reads.baseBranch, reads.gate?.repository ?? '', capabilities),
      input.description,
      // A recurrence after a done item goes under a key naming that item: the store holds the bare key for it.
      refile ? `${input.key}:${refile}` : input.key,
      !!refile,
    );
    if (result.action === 'filed' && result.item) filed.add(result.item);
    return { item: result.action === 'unwired' ? null : result.item };
  };
  const seen = { assertions: {} as Record<string, string>, flaked: new Set<string>() };
  const catalog = async (commit: string) => {
    // GY-3336: a repository with no e2e/cases directory — a fresh install of a repository Mainworks
    // has never gated — answers an empty catalog, not a failing gate: `ls-tree COMMIT:e2e/cases`
    // errors "Not a valid object name" on a path the commit does not hold.
    try { return lines(await git(['ls-tree', '--name-only', `${commit}:e2e/cases`])).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)); }
    catch { return []; }
  };
  const countNonBlankLines = async (commit: string, directory: string) => {
    try {
      const out = await git(['grep', '-I', '-c', '[^[:space:]]', commit, '--', directory]);
      let total = 0;
      for (const line of lines(out)) {
        const count = Number(line.slice(line.lastIndexOf(':') + 1));
        if (Number.isFinite(count)) total += count;
      }
      return total;
    } catch (error) {
      if ((error as { status?: unknown })?.status === 1) return 0;
      throw error;
    }
  };
  return {
    now: reads.now,
    fetch: reads.fetch,
    // GY-3199: only the install gating Mainworks itself publishes the verified ref; every other install's gate verifies another repository, whose verified commits no control plane follows.
    ...(reads.gate?.repository.toLowerCase() === mainworksRepository && reads.pushVerified ? { publish: (commit: string) => reads.pushVerified!(commit) } : {}),
    codeSize: async commit => {
      const source = await countNonBlankLines(commit, 'src');
      const tests = await countNonBlankLines(commit, 'tests');
      return source === 0 && tests === 0 ? null : { source, tests };
    },
    landings: async (from, to) => serveLandings(await serveRangeCommits(git, from, to), work),
    files: async (from, to) => lines(await git(['diff', '--name-only', from, to])),
    catalog,
    core: async commit => {
      try { return [...new Set([featureMapCaseId, ...(JSON.parse(await git(['show', `${commit}:graphyard.json`])).gate?.core ?? [])])]; } catch { return [featureMapCaseId]; }
    },
    seen,
    run: async (commit, checks, files, timeoutMs, signal, onStep) => {
      const ran = await trialFailures(reads, commit, checks, files, timeoutMs, trusted, false, signal, onStep);
      Object.assign(seen.assertions, ran.assertions);
      for (const file of ran.flaked) seen.flaked.add(file);
      return ran.failed;
    },
    without: async (commit, reverted) => {
      let current = commit;
      for (const entry of reverted) {
        const applied = await revertMergeCommit(git, { mergeSha: entry.sha, before: entry.before, baseTip: current, subject: entry.subject });
        if ('conflict' in applied) return null;
        current = applied.revertSha;
      }
      return current;
    },
    revert: async (landing, gated, check, prior = [], onStep) => {
      // Merges may have landed while the gate ran: the revert goes onto main as it stands now.
      const tip = (await reads.fetch()).toLowerCase();
      let current = tip;
      const all = [...prior, landing];
      for (const entry of all) {
        const revert = await revertMergeCommit(git, { mergeSha: entry.sha, before: entry.before, baseTip: current, subject: entry.subject });
        if ('conflict' in revert) return { held: `the revert of ${entry.item.key}'s merge ${entry.sha.slice(0, 12)} does not apply cleanly on ${current.slice(0, 12)}: ${revert.conflict.slice(0, 20).join(', ')}` };
        current = revert.revertSha;
      }
      const files = lines(await git(['diff', '--name-only', tip, current]));
      const trial: ServeRevertPorts['trial'] = (sha, changed, item, options) => reads.trial(sha, changed, item, undefined, options?.onStep, undefined, undefined, undefined, options?.signal);
      const pushed = await trialAndPushRevert({ trial, push: reads.push }, { revertSha: current, files, baseTip: tip, culpritKey: landing.item.key, mergeSha: landing.sha, onStep, startMs: reads.revertStartMs });
      if ('held' in pushed) return { held: pushed.held };
      if ('retry' in pushed) return { retry: pushed.retry, ...(pushed.retry === baseStillFails ? { revertSha: current } : {}) };
      const failingCase = check.startsWith('e2e:') ? check.slice(4) : null;
      for (const entry of all) {
        const reland = relandItemFor(entry.item, { serve: gated, failingCase: failingCase ?? check, failingStep: null, failingReason: `the batch gate's check ${check} failed`, mergeSha: entry.sha, baseBranch: reads.baseBranch });
        // A build or test failure names no case: the re-land carries the original criteria alone.
        await reads.createWork?.(failingCase ? reland : { ...reland, criteria: entry.item.criteria.map(({ id, text, proofs }) => ({ id, text, proofs: [...proofs] })) }, `gate-reland:${entry.sha}`).catch(() => null);
      }
      return { revertSha: current };
    },
    file,
    faultDedup: key => work.some(item => item.faultKey === key),
    // GY-3973: an item the cycle's work lists is open until it is done; a closed one is not listed at all.
    open: item => filed.has(item) || work.some(entry => entry.key === item && entry.stage !== 'done'),
    flaky: check => openFlakyItem(work, check)?.key ?? null,
    // The full suite (a package.json change selects every test) and the whole catalog, each its own trial so the catalog's time is its own; then the preview cases, in a repository that holds them.
    diagnose: async commit => {
      // GY-3779: a trial that crashes or times out is that check's failure, not the run's end: the
      // catalog and onboarding still run and the day's run is recorded.
      const survive = (check: string, run: Promise<CatalogRun>): Promise<CatalogRun> =>
        run.catch((error: unknown) => ({ failed: [check], details: { [check]: message(error) } as Record<string, string>, outputs: {} as Record<string, string[]> }));
      const suite = await survive('full-suite', trialFailures(reads, commit, ['build', 'affected'], ['package.json'], gateLimitMs, trusted));
      const held = await catalog(commit), cases = held.map(id => `e2e:${id}`), started = reads.now();
      // GY-3874: the whole catalog, sharded across the ready test machines and this one, within the 45-minute limit.
      const { failed, details, outputs, shards } = cases.length ? await shardedCatalog(reads, commit, cases, started + gateLimitMs, run => survive('e2e-catalog', run), trusted) : { failed: [], details: {}, outputs: {}, shards: [] }, catalogMs = reads.now() - started;
      const previews = reads.gate?.previews;
      const previewCases = !servedPreviewCases.some(id => held.includes(id)) ? []
        : previews ? await previews(commit) : notCovered(commit, new Date(reads.now()).toISOString(), 'this loop runs no served preview cases');
      // GY-3747: a repository holding the onboarding case times a fresh repository to its first merge.
      const onboarding = held.includes(onboardingCase) ? await reads.gate?.onboarding?.(commit) : undefined;
      // GY-3305: the suite trial's details ride with the catalog's — a failing test check (the browser
      // suite among them) keeps its identity whichever trial named it.
      return { failed: [...new Set([...suite.failed, ...failed])], catalogMs, shards, previewCases, ...(onboarding ? { onboarding } : {}), details: { ...suite.details, ...details }, outputs: { ...suite.outputs, ...outputs } };
    },
  };
}

const stopped = new WeakSet<object>(), gateRuns = new WeakMap<object, AbortController>(), tagPushes = new WeakMap<object, Promise<void>>();
/** GY-3450: when the gate flight began and whether one of its checks has started (holds its host heavy-job slot). */
const gateStarts = new WeakMap<object, { since: number; started: boolean }>();
/** GY-3450: a gate in flight this long with no check started raises the stall alarm, naming the slot holders. */
export const gateStartStallMs = 5 * 60_000;
export const gateStallKey = 'batch-gate:stalled';
/** Who holds the host's heavy-job slots, as the alarm names them. */
const slotHolders = async () => (await liveSlots(heavyJobsDirectory())).filter(entry => entry.slot < declarationSlot)
  .map(entry => entry.owner ? `${entry.owner.label}${entry.owner.project ? ` (${entry.owner.project})` : ''} [pid ${entry.owner.pid}]` : `slot-${entry.slot}`).join('; ') || 'nothing';

/** GY-3450: raise the stall alarm while the gate in flight has started no check for five minutes; clear it otherwise. */
async function gateStartAlarm(cycle: Pick<Cycle, 'state' | 'effects' | 'now' | 'log'>, file: string) {
  const watch = gateStarts.get(cycle.state), standing = cycle.state.actions[gateStallKey];
  if (watch && !watch.started && cycle.now() - watch.since >= gateStartStallMs) {
    if (standing?.state === 'failed') return;
    const tip = readGateRecord(file)?.inFlight?.tip;
    const entry = storeAction(cycle.state, gateStallKey, { kind: 'attention', work: null, principal: null, state: 'failed', attempts: 1, epoch: null, cycle: cycle.state.cycle, at: new Date(cycle.now()).toISOString(),
      detail: `The batch gate${tip ? ` on ${tip.slice(0, 12)}` : ''} has started no check in ${Math.round((cycle.now() - watch.since) / 60_000)} minutes; the host heavy-job slots are held by ${await slotHolders()}`.slice(0, actionDetailMax) });
    cycle.log(actionLine(cycle.state.cycle, entry));
    await cycle.effects.persist?.(cycle.state);
  } else if (standing) {
    delete cycle.state.actions[gateStallKey];
    await cycle.effects.persist?.(cycle.state);
  }
}
/**
 * The loop is stopping: a gate that fails from here on was interrupted, and its record stays as last
 * checkpointed for the next loop (GY-3161). Its host heavy-job slot is freed now (GY-3449); its
 * detached run keeps going for the next loop to adopt.
 */
export const noteBatchGateStopping = (state: object) => { stopped.add(state); gateRuns.get(state)?.abort(); };

/**
 * One record writer at a time per file: the gate's mid-flight checkpoints and the diagnostics'
 * settled write each merge onto the latest state on disk, and two unserialized read-modify-writes
 * interleave — the later write carrying a stale snapshot erases what the earlier one recorded, a
 * batch's finished steps included. Each merge reads inside the chain, after the last write landed.
 */
const recordWrites = new Map<string, Promise<unknown>>();
function mergeGateRecord(file: string, merge: (latest: GateRecord | null) => GateRecord): Promise<void> {
  const chained = (recordWrites.get(file) ?? Promise.resolve()).then(() => writeGateRecord(file, merge(readGateRecord(file))));
  recordWrites.set(file, chained.catch(() => undefined));
  return chained;
}

/** What a gate's write keeps of the diagnostics' own fields (GY-3147, GY-3193): they recorded them meanwhile. */
const diagnosticFields = (latest: GateRecord | null, current: GateRecord) => {
  const merged = mergeFilings(latest, current, 'gate');
  const published = current.published ?? (latest?.verified === current.verified ? latest?.published : undefined);
  if (published && published === current.verified) clearGateNote(merged, 'verified-ref');
  return { releaseTagged: latest?.releaseTagged ?? current.releaseTagged, catalogMs: latest?.catalogMs ?? current.catalogMs, diagnosticsAt: latest?.diagnosticsAt ?? current.diagnosticsAt, diagnosticsRun: latest?.diagnosticsRun ?? current.diagnosticsRun, diagnosticsTrials: latest?.diagnosticsTrials, diagnosticFailures: latest?.diagnosticFailures ?? current.diagnosticFailures, previewCases: latest?.previewCases ?? current.previewCases, onboarding: latest?.onboarding ?? current.onboarding, ...(published !== undefined ? { published } : {}), ...merged };
};

/** The commit served at rollout, which becomes the first verified commit: the deploy record's when it names this repository, else main's tip. */
async function rolloutCommit(root: string, repository: string, reads: MergeWriterReads) {
  const deployed = readDeployRecord(deployRecordPath(root));
  return deployed?.tip && deployed.repository?.toLowerCase() === repository.toLowerCase() ? deployed.tip : (await reads.fetch()).toLowerCase();
}

/**
 * Cycle step beside the merge writer: with no gate in flight, one gate starts on main's tip beside
 * the cycle; the scheduled diagnostics run beside it when due. Neither blocks the cycle or a merge.
 */
export async function batchGateStep(cycle: Pick<Cycle, 'state' | 'effects' | 'snapshot' | 'now' | 'log'>) {
  const reads = cycle.effects.mergeWriter, gate = reads?.gate;
  // GY-3450: a drain never stops the gate — it is the deploy path; the diagnostics wait it out (GY-3304).
  if (!reads?.git || !gate) return null;
  const file = gateRecordPath(gate.root);
  const git = reads.git;
  // GY-3336: while the fetch-refusal backoff stands, neither the gate nor its bootstrap fetches —
  // the refusal is the owner's to fix, and the loop has already said so in one standing line.
  const standing = cycle.state.actions[fetchRefusalKey];
  if (standing?.state === 'failed' && cycle.now() - Date.parse(standing.at) < fetchRetryBackoffMs(standing.attempts)) return null;
  const reading: MergeWriterReads = { ...reads, fetch: async () => {
    try {
      const tip = await reads.fetch();
      if (cycle.state.actions[fetchRefusalKey]) { delete cycle.state.actions[fetchRefusalKey]; await cycle.effects.persist?.(cycle.state); }
      return tip;
    } catch (error) {
      // GY-3464: a fetch the stopping loop interrupted says nothing about the remote.
      if (stopped.has(cycle.state)) throw error;
      const entry = storeAction(cycle.state, fetchRefusalKey, { kind: 'attention', work: null, principal: null, state: 'failed',
        detail: fetchRefusalLine(gate.repository, reads.baseBranch, error), attempts: (cycle.state.actions[fetchRefusalKey]?.attempts ?? 0) + 1, epoch: null, cycle: cycle.state.cycle, at: new Date(cycle.now()).toISOString() });
      cycle.log(actionLine(cycle.state.cycle, entry));
      await cycle.effects.persist?.(cycle.state);
      throw error;
    }
  } };
  const live = flights.get(cycle.state) ?? { gate: null, diagnostics: null };
  flights.set(cycle.state, live);
  let record: GateRecord | null = readGateRecord(file);
  if (!record || record.repository?.toLowerCase() !== gate.repository.toLowerCase()) {
    record = bootstrapGate(gate.repository, await rolloutCommit(gate.root, gate.repository, reading));
    await writeGateRecord(file, record);
  }
  const gated = record;
  // GY-3444: the gate's checks run as detached trial runs, as merge trials do (GY-3159): the run's
  // directory rides the record, so a loop restart — a CLI upgrade among them — adopts the run in
  // place of orphaning it. The diagnostics, and a check with named environments, trial in process.
  // Like every trial it is one heavy job of the host (GY-3290); its wait for that slot is a wait, not its own time.
  let heavyWait = false;
  // GY-3449, GY-3606: one gate run's lifetime; its end — any outcome, a throw, or the loop stopping — frees
  // every slot its checks, reruns and verified-commit probes hold, and starts none of their tests after.
  let ended = new AbortController();
  const trial: MergeWriterReads['trial'] = async (sha, files, item, base, step, timing, heads, _share, signal, timeout) => {
    const share = Math.max(1, busyTrialSlots(cycle.state)), flight = gated.inFlight, proofs = criterionProofs(item), run = ended.signal;
    const input = createHash('sha256').update(JSON.stringify([proofs, files])).digest('hex');
    // GY-3805, GY-3811: the diagnostics trial detached too, and adopt any unfinished run across deploy restarts
    // (even after verified moves to a newer commit), starting a new one only when none is running.
    if (!signal && reads.launchTrialRun && reads.adoptTrialRun && !item.environments) {
      const isSuite = input === suiteInput, sameKind = isSameDiagnosticsKind(isSuite);
      const adopted = await adoptDiagnosticsTrial(file, gate.root, isSuite, reads.adoptTrialRun);
      if (adopted) {
        if (adopted.fromDisk) {
          await mergeGateRecord(file, latest => ({ ...(latest ?? gated), diagnosticsTrials: [...(latest?.diagnosticsTrials ?? []).filter(run => !sameKind(run)), { commit: adopted.commit, input, directory: adopted.handle.directory }] }));
        }
        return adopted.handle.trial(step, timing);
      }
      await reads.ensureTrialImage?.();
      const launched = reads.launchTrialRun({ key: gateKey, head: sha, mergeSha: sha, baseTip: base ?? null, changedFiles: [...files], proofs, e2eProofs: e2eProofsOf(item),
        reproduce: item.type !== 'chore', cores: null, ...trialShareAllowance(share, timeout, reads.cores) });
      await mergeGateRecord(file, latest => ({ ...(latest ?? gated), diagnosticsTrials: [...(latest?.diagnosticsTrials ?? []).filter(run => !sameKind(run)), { commit: sha, input, directory: launched.directory }] }));
      return launched.trial(step, timing);
    }
    // The diagnostics (no signal) trial another commit and take an ordinary slot. The gate's own check takes the reserved
    // one (GY-3450); so do its probes and bisects, which stop with its run: the step after a stopped run starts on the slot
    // that run freed instead of queueing behind merge trials (GY-3800).
    if (flight?.tip !== sha) {
      const other = () => reads.trial(sha, files, item, base, step, timing, heads, share, signal && AbortSignal.any([signal, run]), timeout);
      return signal ? heavyTrial(gateKey, step, signal, other, run, true) : other();
    }
    // GY-3474: what the check is doing now — its wait, then its run's own steps — rides the record for status.
    const progress = (line: string) => {
      step?.(line);
      if (gated.inFlight?.tip !== sha) return;
      gated.inFlight = { ...gated.inFlight, progress: line.slice(0, 200) };
      void mergeGateRecord(file, latest => ({ ...gated, ...diagnosticFields(latest, gated) })).catch(() => undefined);
    };
    // The wait is this call's own: it ends when the check starts and, however the call ends, with it.
    const heavy = <T>(job: () => Promise<T>) => heavyTrial(gateKey, line => { heavyWait = true; progress(line); }, signal, () => {
      heavyWait = false;
      const watch = gateStarts.get(cycle.state);
      if (watch) watch.started = true;
      progress('starting its check');
      return job();
    }, run, true).finally(() => { heavyWait = false; });
    if (!reads.launchTrialRun || !reads.adoptTrialRun || item.environments) return heavy(() => reads.trial(sha, files, item, base, progress, timing, heads, share, signal, timeout));
    const launch = reads.launchTrialRun, adopt = reads.adoptTrialRun;
    const earlier = flight.run?.commit === sha && flight.run.input === input ? flight.run : null;
    return heavy(async () => {
      const adopted = earlier ? await adopt({ key: gateKey, head: sha, mergeSha: sha, directory: earlier.directory }) : null;
      if (adopted) return adopted.trial(progress, timing, signal);
      await reads.ensureTrialImage?.();
      // A run that settled while the image built launches nothing.
      signal?.throwIfAborted(); run.throwIfAborted();
      const launched = launch({ key: gateKey, head: sha, mergeSha: sha, baseTip: base ?? null, changedFiles: [...files], proofs, e2eProofs: e2eProofsOf(item),
        reproduce: item.type !== 'chore', cores: null, ...trialShareAllowance(share, timeout, reads.cores) });
      gated.inFlight = { ...gated.inFlight!, run: { commit: sha, input, directory: launched.directory } };
      await mergeGateRecord(file, latest => ({ ...gated, ...diagnosticFields(latest, gated) })).catch(() => undefined);
      return launched.trial(progress, timing, signal);
    });
  };
  const ports = batchGatePorts({ ...reading, git, trial }, cycle.snapshot.work, () => readGateRecord(file)?.verified ?? null);
  // GY-3444: the gate's bound leaves out the time its checks wait for a slot. GY-3474: only its own
  // check's wait — the host heavy-job slot, or its own container start held by the cap, heat or the
  // disk floor. The loop's CPU hold on other launches and another install's gate are not its waits,
  // so a stalled check still meets its bound on a hot or busy host.
  ports.waiting = () => heavyWait || (!!gated.inFlight && trialStartWaiting('gate', gate.slots, trialStartOwner(gate.root, gated.inFlight.tip)));
  const note = (key: string, state: 'done' | 'failed', detail: string) => {
    const entry = storeAction(cycle.state, key,
      { kind: 'merge', work: null, principal: null, state, detail: detail.slice(0, 1900), attempts: 1, epoch: null, cycle: cycle.state.cycle, at: new Date(cycle.now()).toISOString() });
    // The gate settles beside the cycle, so its outcome line reaches the journal here and only here —
    // never through the cycle's own actions, whose logging already passed (GY-3141).
    cycle.log(actionLine(cycle.state.cycle, entry));
  };
  // GY-3199: a verified commit the record never published — a gate whose publish failed, or a
  // record adopted from before the ref existed — is caught up here, before the gate flight adopts
  // the record. A no-op push is one round trip; a failure is one journal line and runs again.
  if (ports.publish && record.verified && record.published !== record.verified) {
    try {
      await ports.publish(record.verified);
      record.published = record.verified;
      clearGateNote(record, 'verified-ref');
      await mergeGateRecord(file, latest => {
        const next = { ...(latest ?? record!), published: record!.published };
        clearGateNote(next, 'verified-ref');
        return next;
      });
    } catch (error) {
      note('batch-gate:verified-ref', 'failed', `Could not publish the verified commit ${record!.verified!.slice(0, 12)} at refs/graphyard/verified: ${message(error)}`);
    }
  } else if (record.verified && record.published === record.verified && record.notes?.some(line => line.startsWith('verified-ref: '))) {
    clearGateNote(record, 'verified-ref');
    await mergeGateRecord(file, latest => {
      const next = { ...(latest ?? record!) };
      clearGateNote(next, 'verified-ref');
      return next;
    });
  }
  if (reads.attest) await recordRepaired(record, cycle.snapshot.work, reads.attest, cycle.now(), note);
  // The deploy watch writes this after health, CLI publication and pinning. Re-read every cycle,
  // including after restart; a kept/failed deployment is not a successful release. The deploy
  // record retains verification even when the gate has already advanced to a newer commit.
  // Retire the standing blocker left by the former host publisher.
  delete cycle.state.actions['publish-verified:blocker'];
  const deployed = readDeployRecord(deployRecordPath(gate.root));
  if (reads.pushReleaseTag && gate.repository.toLowerCase() === mainworksRepository &&
      deployed?.repository?.toLowerCase() === mainworksRepository && (deployed.verified || deployed.tip === record.verified) &&
      deployed.tip && !deployed.reason && !deployed.failed && !deployed.restore && record.releaseTagged !== deployed.tip && !tagPushes.has(cycle.state)) {
    // GY-3957: the push runs beside the cycle — a slow remote outlasts the step's timeout — one at a time.
    const tagged = record, tip = deployed.tip, push = reads.pushReleaseTag;
    tagPushes.set(cycle.state, (async () => {
      try {
        const tag = await push(tip);
        tagged.releaseTagged = tip;
        await mergeGateRecord(file, latest => ({ ...(latest ?? tagged), releaseTagged: tip }));
        note('publish-tag', 'done', `Pushed ${tag}; GitHub Actions publishes the package and images`);
      } catch (error) { note('publish-tag', 'failed', `Could not push the release tag: ${message(error)}`); }
      finally { tagPushes.delete(cycle.state); }
    })());
  }
  // GY-3444: the gate has first claim on trial slots — it starts without waiting for a free merge
  // slot, and its trial containers start before queued merge trials (trialStartOrder).
  if (!live.gate) {
    const current = record;
    gateStarts.set(cycle.state, { since: cycle.now(), started: false });
    live.gate = (async () => {
      try {
        // A timed-out run starts again at once: runGate cleared its batch, so the retry is cut from
        // main's newest tip; a second timeout holds (GY-3383), which ends the loop.
        for (;;) {
          // Each mid-flight write keeps the diagnostics' fields and both writers' filings (GY-3147),
          // as the settled gate's own write does: the batch it carries — tip, files, checks, finished
          // steps — is what the next loop adopts after a restart (GY-3135).
          const before = current.verified;
          const write = () => mergeGateRecord(file, latest => ({ ...current, ...diagnosticFields(latest, current) }));
          ended = new AbortController();
          gateRuns.set(cycle.state, ended);
          const outcome = await runGate({ ...ports, checkpoint: write }, current).finally(() => ended.abort());
          // The diagnostics' fields and filings are theirs: a gate's write keeps what they recorded meanwhile.
          await write();
          if (outcome.outcome === 'verified') {
            if (before) {
              const landings = await ports.landings(before, outcome.tip);
              const reverted = new Set(current.merges.filter(merge => merge.reverted).map(merge => merge.sha));
              await appendReleaseNote(releaseNotesPath(gate.root), releaseNote(outcome.tip, current.verifiedAt ?? new Date(cycle.now()).toISOString(), landings, reverted));
            }
            if (gate.warmImage) {
              try { await gate.warmImage(outcome.tip); }
              catch (error) { note(`batch-gate:warm-image:${outcome.tip}`, 'failed', `Could not warm the test image for ${outcome.tip.slice(0, 12)}: ${message(error)}`); }
            }
          }
          if (outcome.outcome !== 'idle') {
            const reason = gateOutcomeReason(outcome);
            note(`batch-gate:${outcome.tip}`, outcome.outcome === 'held' ? 'failed' : 'done', `Batch gate on ${outcome.tip.slice(0, 12)}: ${outcome.outcome}${reason !== null ? `: ${reason}` : ''}${outcome.outcome === 'timeout' ? '; retrying now on the newest main' : ''}`);
          }
          if (outcome.outcome !== 'timeout' || stopped.has(cycle.state)) break;
        }
      } catch (error) {
        // The stop killed the gate's children, so the failure is no outcome: nothing is written or logged.
        if (stopped.has(cycle.state)) return;
        // The failed run's outcome is the record's last (GY-3141); its batch is settled, so the next cycle runs afresh (GY-3567).
        await mergeGateRecord(file, latest => ({ ...current, ...diagnosticFields(latest, current) })).catch(() => undefined);
        note('batch-gate', 'failed', `The batch gate failed and runs again next cycle: ${message(error)}`);
      }
      finally { live.gate = null; ended.abort(); gateRuns.delete(cycle.state); gateStarts.delete(cycle.state); }
    })();
  }
  await gateStartAlarm(cycle, file);
  // Diagnostics start without waiting for a slot — the daily check must not starve — but count as a busy
  // trial slot (trial-slots.ts): the merge flights and the gate size around them, and their own trial
  // takes its share of the lanes.
  if (!live.diagnostics && !reads.drain?.()) {
    live.diagnostics = (async () => {
      try {
        const fresh = readGateRecord(file) ?? record;
        const failed = await runDiagnostics(ports, fresh);
        if (failed) {
          // Re-read so the diagnostics' fields never overwrite what a gate recorded meanwhile; the
          // filings of both writers merge (GY-3147).
          await mergeGateRecord(file, latest => ({ ...(latest ?? fresh), catalogMs: fresh.catalogMs, diagnosticsAt: fresh.diagnosticsAt, diagnosticsRun: fresh.diagnosticsRun, diagnosticsTrials: undefined, diagnosticFailures: fresh.diagnosticFailures, previewCases: fresh.previewCases, onboarding: fresh.onboarding, ...mergeFilings(latest, fresh, 'diagnostics') }));
          note('batch-gate:diagnostics', 'done', `Diagnostics on ${fresh.verified?.slice(0, 12)}: ${failed.length} failure(s) filed`);
        }
      } catch (error) {
        // GY-3779: a thrown run is recorded with its reason, so status shows why the day's run is missing.
        const diagnosticsRun = { at: new Date(cycle.now()).toISOString(), outcome: 'threw' as const, reason: message(error).slice(0, 500) };
        await mergeGateRecord(file, latest => ({ ...(latest ?? record!), diagnosticsRun })).catch(() => undefined);
        note('batch-gate:diagnostics', 'failed', `The diagnostics failed and run again next cycle: ${message(error)}`);
      }
      finally { live.diagnostics = null; }
    })();
  }
  return { gate: live.gate, diagnostics: live.diagnostics, tag: tagPushes.get(cycle.state) ?? null };
}
