// Concern: GY-3199, GY-3233, GY-3249, GY-3693 — the control plane's own faults, as the loop sees them. The deploy
// watch keeps .graphyard/control-plane.json; this step reads it each cycle, and the cycle hands it
// the steps that ran past their timeout; the merge writer hands it trial-host faults. A fault belongs to Mainworks, not to the managed
// repository: it is filed once to the configured upstream install (`upstream` in master.json),
// into this install only when it manages Mainworks itself (adding an observation note to any open
// or recently done item with the same faultKey instead of filing a duplicate), and otherwise raised
// as one attention line — never filed again per cycle. Once a day it reports the staleness the record shows.
import { randomUUID } from 'node:crypto';
import { controlPlaneRecordPath, controlPlaneStaleLines, readControlPlaneRecord, type ControlPlaneRecord } from '../deploy-watch.js';
import type { Work } from '../model.js';
import { readCredentialFile } from '../private-file.js';
import { serverOrigin } from '../repository-setup.js';
import { mainworksRepository } from '../scenarios.js';
import type { MasterConfig } from '../master/profiles.js';
import { actionLine, message, storeAction } from './state.js';
import type { Cycle } from './cycle.js';

/** How long a failed upstream filing waits before the loop asks again. */
const upstreamRetryMs = 3_600_000;
/** GY-3693: how long after a repair item is delivered or closed before the same fault files a new item. */
const faultCooldownMs = 24 * 60 * 60_000;

/**
 * The bug item every fault the loop files is built from (GY-3160, GY-3365, GY-3693): the batch gate's flakes,
 * known reds and diagnostics, and the control plane's own faults. AC-1 binds a new pinning test,
 * which fails on the base, so the bug trial reproduces the defect there; AC-2 binds an E2E case,
 * so the item meets the filing rule that every bug owes an e2e proof. Mainworks's own filings bind
 * create-work-item, an existing case that passes on any base; a gate filing in any other repository
 * binds that repository's own case instead (GY-3568). Every item carries a `faultKey` so repeats
 * add an observation note to the existing item instead of filing duplicates.
 */
const defaultPinText = 'The fault is fixed at its cause, not skipped or weakened; a new test pins it and fails without the fix';
/** GY-3821: flaky-check items tell their Builder how to pin a race deterministically through a test seam. */
const flakyPinText = 'The fault is fixed at its cause, not skipped or weakened; a new test pins it and reproduces the race by injecting the one condition the test waits on through a test seam, never by loading the host or lengthening a wait, timeout or poll bound, and fails on the base tip on every run';

const faultItem = (input: { faultKey: string; title: string; description: string; proof: string; reason: string; type?: 'bug' | 'chore'; ac1Text?: string; plannedFiles?: string[]; repaired?: { text: string; proof: string }; e2e?: { proof: string; clause: string } }) => {
  const e2e = input.e2e ?? { proof: 'e2e:create-work-item', clause: 'creating a work item still works' };
  return {
  faultKey: input.faultKey,
  title: input.title.slice(0, 200), type: input.type ?? ('bug' as const), priority: 1, description: input.description, dependencies: [],
  ...(input.plannedFiles?.length ? { plannedFiles: input.plannedFiles } : {}),
  why: 'A fault in Mainworks slows or stops delivery for everyone using this install until it is fixed.',
  simplest: 'Fix the one cause the description names and pin it with a test; nothing else changes.',
  criteria: [
    // AC-1 never repeats the title: a title like "… on the install for X" reads as a live-install observation the filing refuses.
    { id: 'AC-1', text: input.ac1Text ?? defaultPinText, proofs: [input.proof] },
    input.repaired
      ? { id: 'AC-2', text: `${input.repaired.text} and ${e2e.clause}`, proofs: [input.repaired.proof, e2e.proof] }
      : { id: 'AC-2', text: `${e2e.clause[0]!.toUpperCase()}${e2e.clause.slice(1)}`, proofs: [e2e.proof] },
  ],
  reason: input.reason };
};

/** The bug item a failed control-plane upgrade files: one item per failed step (GY-3693). */
export function controlPlaneUpgradeItem(record: ControlPlaneRecord) {
  const step = record.failedStep ?? 'an unknown step', verified = record.verified ?? 'an unknown commit';
  return faultItem({
    faultKey: `control-plane-upgrade:${step}`,
    title: `Control-plane upgrade stuck at ${step}`,
    description: `The daily control-plane upgrade to the verified Mainworks commit ${verified.slice(0, 12)} fails at ${step}: ${(record.failedReason ?? 'no reason recorded').slice(0, 500)}. The install keeps running ${record.commit?.slice(0, 12) ?? 'its previous version'} and retries about hourly; .graphyard/control-plane.json carries the record and master status shows it. Fix the upgrade's cause — the failed step and reason above — so the install runs the latest verified commit again.`,
    proof: 'unit:control-plane-upgrade-pinned',
    repaired: { text: 'The install again runs the latest verified Mainworks commit within a day of its publishing', proof: 'manual:control-plane-current' },
    reason: 'Filed by the master loop from the control-plane update record (GY-3199)',
  });
}

/** The bug item a loop step that ran past its timeout files upstream. */
export const stepStallItem = (step: string, repository: string) => faultItem({
  faultKey: `loop-step-stall:${step}`,
  title: `Loop ${step} step stalls past its timeout`,
  description: `The master loop's ${step} step on the install for ${repository} ran past its cycle timeout. The loop logs the stall each cycle in its journal; find what the step waits on and bound it.`,
  proof: 'unit:loop-step-bounded',
  reason: 'Filed by the master loop from a stalled cycle step (GY-3233)',
});

/** GY-3249: the bug item a merge trial that cannot fetch from an external host files upstream: one per host. */
export const trialHostFaultItem = (host: string, repository: string) => faultItem({
  faultKey: `trial-host-fault:${host}`,
  title: `Merge trials cannot fetch from ${host}`,
  description: `A merge trial on the install for ${repository} failed fetching from ${host}, rerun included, so the trial host's network does not reach a host a normal build needs. The head was neither refused nor reworked and stays queued; the trial record carries the step's output. Find why the trial container cannot reach ${host} and fix it.`,
  proof: 'unit:trial-host-reachable',
  reason: 'Filed by the master loop from a trial-host fault (GY-3249)',
});

/** GY-3339: the bug item a merge trial whose nested sandbox AppArmor denied files upstream: one per repository. */
export const trialSandboxFaultItem = (repository: string) => faultItem({
  faultKey: `trial-sandbox-fault:${repository}`,
  title: `Merge trials cannot start nested sandboxes on ${repository}'s trial host`,
  description: `A merge trial on the install for ${repository} failed because AppArmor denied a nested bubblewrap sandbox inside the trial container. The head was neither refused nor reworked and stays queued; the trial record carries the output. mainworks doctor names the fix: load the mainworks-trial AppArmor profile on the trial host (rerun mainworks up).`,
  proof: 'unit:trial-sandbox-starts',
  reason: 'Filed by the master loop from a trial-host fault (GY-3339)',
});

/** GY-3275: the bug item a merge trial that cannot build a repository's own trial image files upstream: one per repository. */
export const trialImageFaultItem = (repository: string) => faultItem({
  faultKey: `trial-image-fault:${repository}`,
  title: `Merge trials cannot build ${repository}'s trial image`,
  description: `A merge trial on the install for ${repository} could not build the repository's graphyard.trial.Dockerfile image, so the trial host's Docker cannot build what the repository's base branch declares. The head was neither refused nor reworked and stays queued; the trial record carries the build's output. Fix what on the trial host kept Docker from building it, or land a head that fixes the Dockerfile (it is trialled in its own image), and let the queued head retry.`,
  proof: 'unit:trial-image-builds',
  reason: 'Filed by the master loop from a trial-host fault (GY-3275)',
});

/** GY-3316: the bug item a merge trial that Docker refused a network for spent address pools files upstream: one per repository. */
export const trialNetworkFaultItem = (repository: string, networks: string) => faultItem({
  faultKey: `trial-network-fault:${repository}`,
  title: `Merge trials cannot create Docker networks on the install for ${repository}`,
  description: `A merge trial on the install for ${repository} failed to create its network: all predefined address pools have been fully subnetted, with ${networks} Mainworks preview networks on the trial host. The head was neither refused nor reworked and stays queued. Find what leaks the networks and remove it; the loop's leftovers sweep removes trial networks no container uses.`,
  proof: 'unit:trial-network-created',
  reason: 'Filed by the master loop from a trial-host fault (GY-3316)',
});

/** Every fault item the loop files is one faultItem. */
export type FaultItem = ReturnType<typeof faultItem>;

/** When a terminal item reached done (delivered or closed), in ms. */
const doneAt = (item: Pick<Work, 'stageEnteredAt' | 'updatedAt' | 'delivery' | 'observation' | 'closure'>) =>
  Date.parse(item.closure?.at ?? item.delivery?.mergedAt ?? item.observation?.mergedAt ?? item.stageEnteredAt ?? item.updatedAt);

/**
 * GY-3693: the standing repair item for `faultKey` — any open item with that fault key, else the
 * most recently delivered or closed item with that fault key within the last 24 hours.
 * GY-3973: `openOnly` leaves the done ones out.
 */
function existingFaultItem(work: readonly Work[], faultKey: string, now: number, openOnly = false): Work | null {
  const matching = work.filter(item => item.faultKey === faultKey);
  const open = matching.find(item => item.stage !== 'done');
  if (open || openOnly) return open ?? null;
  const recent = matching
    .filter(item => { const at = doneAt(item); return Number.isFinite(at) && now - at < faultCooldownMs; })
    .sort((a, b) => doneAt(b) - doneAt(a));
  return recent[0] ?? null;
}

/**
 * GY-3693: the one shared filing helper for loop- and release-check-filed repair items.
 * Before filing, looks for an item with the same `faultKey` that is open, or reached done
 * (delivered or closed) within the last 24 hours, and records an observation note on it instead.
 * GY-3973: `openOnly` — a recurrence after its recorded item is done — notes an open item only.
 */
export async function fileLoopFault(
  ports: {
    work: readonly Work[];
    now: number;
    createWork?: (input: FaultItem, idempotencyKey: string) => Promise<{ key?: string } | null>;
    note?: (item: Pick<Work, 'id' | 'key'>, text: string, idempotencyKey: string) => Promise<unknown>;
  },
  item: FaultItem,
  observation: string,
  idempotencyKey = item.faultKey,
  openOnly = false,
): Promise<{ action: 'noted'; item: string } | { action: 'filed'; item: string | null } | { action: 'unwired' }> {
  const existing = existingFaultItem(ports.work, item.faultKey, ports.now, openOnly);
  if (existing) {
    if (ports.note) await ports.note(existing, observation.slice(0, 1000), `fault-note:${item.faultKey}:${randomUUID()}`);
    return { action: 'noted', item: existing.key };
  }
  if (!ports.createWork) return { action: 'unwired' };
  const prior = ports.work.filter(entry => entry.faultKey === item.faultKey).length;
  const created = await ports.createWork(item, prior ? `${idempotencyKey}:${prior}` : idempotencyKey);
  return { action: 'filed', item: created?.key ?? null };
}

/** Production upstream filer: POSTs the item to the upstream install as its credential's principal, idempotent on the fault's key. */
export function upstreamFiler(upstream: NonNullable<MasterConfig['upstream']>, fetcher: typeof fetch = fetch) {
  return async (input: FaultItem, key: string): Promise<{ key?: string }> => {
    const token = await readCredentialFile(upstream.credentialFile);
    const response = await fetcher(`${serverOrigin(upstream.url)}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`the upstream install refused it (${response.status}): ${text.slice(0, 200)}`);
    return JSON.parse(text) as { key?: string };
  };
}

type FaultCycle = Pick<Cycle, 'state' | 'effects' | 'clock' | 'log' | 'config'> & Partial<Pick<Cycle, 'snapshot'>>;

/**
 * Reports one fault: filed upstream when one is configured, into this install (through
 * `fileLoopFault`, adding an observation note to any open or recently done item with the same
 * `faultKey`) only when it manages Mainworks's own repository, otherwise one attention line. A
 * failed upstream filing stands as its attention line and is asked again an hour later.
 */
async function reportFault(cycle: FaultCycle, item: FaultItem, fault: string) {
  const key = item.faultKey, row = cycle.state.actions[key], upstream = cycle.effects.fileUpstream;
  const note = (state: 'done' | 'failed', detail: string) => {
    const entry = storeAction(cycle.state, key, { kind: 'attention', work: null, principal: null, state, detail: detail.slice(0, 1900), attempts: (row?.attempts ?? 0) + 1, epoch: null, cycle: cycle.state.cycle, at: new Date(cycle.clock).toISOString() });
    cycle.log(actionLine(cycle.state.cycle, entry));
  };
  if (!upstream && cycle.config.repository?.toLowerCase() === mainworksRepository) {
    const work = cycle.snapshot?.work ?? [];
    const existing = existingFaultItem(work, key, cycle.clock);
    if (!existing && row && row.state === 'done' && cycle.clock - Date.parse(row.at) < faultCooldownMs) return;
    try {
      const result = await fileLoopFault({ work, now: cycle.clock, createWork: cycle.effects.mergeWriter?.createWork, note: cycle.effects.mergeWriter?.note }, item, fault, key);
      if (result.action === 'unwired') return note('failed', `Mainworks fault: ${fault}. No work filer is wired, so it is not filed.`);
      note('done', `${result.action === 'noted' ? 'Noted' : 'Filed'} ${result.item ?? 'an item'}: ${fault}`);
    } catch (error) { note('failed', `Mainworks fault: ${fault}. Could not file it: ${message(error)}`); }
    return;
  }
  if (row && (row.state === 'done' || !upstream || cycle.clock - Date.parse(row.at) < upstreamRetryMs)) return;
  if (!upstream) return note('failed', `Mainworks fault: ${fault}. No upstream install is configured (upstream in master.json), so it is not filed; report it to Mainworks, never as work in ${cycle.config.repository}`);
  try {
    const filed = await upstream(item, key);
    note('done', `Filed ${filed?.key ?? 'an item'} to the upstream install: ${fault}`);
  } catch (error) { note('failed', `Mainworks fault: ${fault}. Could not file it to the upstream install: ${message(error)}`); }
}

/** GY-3249: a merge trial that could not fetch from `host` is reported once per host, like any Mainworks fault. */
export const reportTrialHostFault = (cycle: FaultCycle, host: string) =>
  reportFault(cycle, trialHostFaultItem(host, cycle.config.repository), `merge trials cannot fetch from ${host}, a host a normal build needs`);

/** GY-3316: a merge trial Docker refused a network for spent address pools is reported once per repository, naming the preview networks on the host. */
export const reportTrialNetworkFault = (cycle: FaultCycle, networks: string) =>
  reportFault(cycle, trialNetworkFaultItem(cycle.config.repository, networks), `merge trials cannot create a Docker network on the install for ${cycle.config.repository}: its address pools are spent, with ${networks} Mainworks preview networks on the trial host`);

/** GY-3275: a merge trial that cannot build a repository's own trial image is reported once per repository, like any Mainworks fault. */
export const reportTrialImageFault = (cycle: FaultCycle) =>
  reportFault(cycle, trialImageFaultItem(cycle.config.repository), `merge trials cannot build the repository's graphyard.trial.Dockerfile image on the install for ${cycle.config.repository}`);

/** GY-3339: a merge trial whose nested sandbox AppArmor denied is reported once per repository, like any Mainworks fault. */
export const reportTrialSandboxFault = (cycle: FaultCycle) =>
  reportFault(cycle, trialSandboxFaultItem(cycle.config.repository), `merge trials cannot start nested sandboxes: AppArmor denies them in the trial container on the install for ${cycle.config.repository}`);

/**
 * The control plane's own faults, read beside the cycle: a stuck upgrade from the record, the
 * steps this cycle saw stall, and the daily staleness line. Nothing here writes the record — the
 * deploy watch owns it.
 */
export async function controlPlaneStep(cycle: FaultCycle, stalledSteps: readonly string[] = []) {
  for (const step of stalledSteps) await reportFault(cycle, stepStallItem(step, cycle.config.repository), `the loop's ${step} step ran past its timeout`);
  const root = cycle.effects.mergeWriter?.gate?.root;
  if (!root) return;
  const record = readControlPlaneRecord(controlPlaneRecordPath(root));
  // GY-3693: one fault per failed step, never a duplicate per verified commit.
  if (record?.failedStep && record.verified)
    await reportFault(cycle, controlPlaneUpgradeItem(record), `the control-plane upgrade to ${record.verified.slice(0, 12)} keeps failing at ${record.failedStep}, so the install still runs ${record.commit?.slice(0, 12) ?? 'its previous version'}`);
  // The daily diagnostics: each staleness line once per UTC day, in the journal the leftovers
  // report writes to. Nothing stale logs nothing.
  const day = new Date(cycle.clock).toISOString().slice(0, 10);
  if (cycle.state.controlPlaneDay !== day) {
    cycle.state.controlPlaneDay = day;
    const stale = controlPlaneStaleLines(readControlPlaneRecord(controlPlaneRecordPath(root)), cycle.clock);
    if (stale.length) cycle.log(`[mainworks-master] control-plane diagnostics: ${stale.join('; ')}`);
  }
}

/** The pinning-test proof a gate filing binds, named from its check: `known-red:test:tests/a-b.test.ts` → `unit:a-b-pinned`. */
export const pinningProof = (key: string) =>
  `unit:${key.slice(key.indexOf(':') + 1).toLowerCase().replace(/^test:tests\//, '').replace(/\.test\.ts$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-pinned`;

/** The proof a gate filing owes once the batch gate passes again; the loop records it itself (GY-3443). */
export const repairedProof = 'manual:batch-gate-repaired';

/** GY-3837: what proofs a managed repository can actually execute in its merge trial. */
export interface ProjectProofCapabilities {
  /** True when the repository declares a runner that produces `unit:` / `integration:` proof counts (Node test runner, vitest or pytest). */
  unitRunner: boolean;
  /** Declared `delivery.mergeGate.preMerge` check names from `graphyard.json`. */
  preMergeChecks?: readonly string[];
  /** An existing core E2E case id declared in `graphyard.json` (`gate.core` or `featureMap`). */
  coreCase?: string;
}

const unitRunnerCommand = /\b(?:node\b.*--test|npm\s+(?:run\s+)?test\b|pnpm\s+(?:run\s+)?test\b|vitest\b|pytest\b)/;

/** GY-3837: derive a repository's executable proof capabilities from its `graphyard.json`, `package.json` and pytest presence. */
export function projectProofCapabilities(input: {
  projectConfigJson?: string | null;
  packageJson?: string | null;
  hasPytest?: boolean;
}): ProjectProofCapabilities {
  let preMerge: { check?: unknown; command?: unknown; selection?: unknown }[] = [];
  let coreCase: string | undefined;
  if (input.projectConfigJson) {
    try {
      const parsed = JSON.parse(input.projectConfigJson) as {
        delivery?: { mergeGate?: { preMerge?: unknown } };
        gate?: { core?: unknown };
        featureMap?: unknown;
      };
      if (Array.isArray(parsed.delivery?.mergeGate?.preMerge)) {
        preMerge = parsed.delivery.mergeGate.preMerge as { check?: unknown; command?: unknown; selection?: unknown }[];
      }
      if (Array.isArray(parsed.gate?.core)) {
        const first = parsed.gate.core.find((entry): entry is string => typeof entry === 'string' && entry.length > 0);
        if (first) coreCase = first;
      }
      if (!coreCase && Array.isArray(parsed.featureMap) && parsed.featureMap.length > 0) {
        coreCase = 'graphyard-feature-map';
      }
    } catch { /* ignore malformed config */ }
  }
  const preMergeChecks = preMerge
    .map(entry => (typeof entry.check === 'string' ? entry.check.trim() : ''))
    .filter(Boolean);
  let hasPackageTest = false;
  let hasVitest = false;
  if (input.packageJson) {
    try {
      const pkg = JSON.parse(input.packageJson) as { scripts?: Record<string, unknown>; devDependencies?: Record<string, unknown>; dependencies?: Record<string, unknown> };
      hasPackageTest = typeof pkg.scripts?.test === 'string' && pkg.scripts.test.trim().length > 0;
      hasVitest = Boolean(pkg.devDependencies?.vitest || pkg.dependencies?.vitest);
    } catch { /* ignore malformed package.json */ }
  }
  const preMergeRunsUnit = preMerge.some(entry =>
    Boolean(entry.selection) || (typeof entry.command === 'string' && unitRunnerCommand.test(entry.command)));
  // Matches trial.ts `repositoryTrialChecks` + proof-runner.ts `countByRunner`:
  // when preMerge is declared, package.json scripts.test is not used as a fallback; only vitest/pytest or a Node/vitest/pytest preMerge check runs unit proofs.
  const unitRunner = Boolean(input.hasPytest || hasVitest || (preMerge.length > 0 ? preMergeRunsUnit : hasPackageTest));
  return { unitRunner, ...(preMergeChecks.length ? { preMergeChecks } : {}), ...(coreCase ? { coreCase } : {}) };
}

/** GY-3837: read a repository's executable proof capabilities from a git ref (falling back to HEAD). */
export async function readProjectCapabilities(git: (args: string[]) => Promise<string>, ref: string): Promise<ProjectProofCapabilities> {
  const resolved = (await git(['rev-parse', '--verify', ref]).catch(() => git(['rev-parse', '--verify', 'HEAD']).catch(() => ''))).trim();
  const target = resolved || ref;
  const [projectConfigJson, packageJson, pytestOut] = await Promise.all([
    git(['show', `${target}:graphyard.json`]).catch(() => null),
    git(['show', `${target}:package.json`]).catch(() => null),
    git(['grep', '-l', '-F', '-e', 'def test_', target, '--', '*.py']).catch(() => ''),
  ]);
  return projectProofCapabilities({ projectConfigJson, packageJson, hasPytest: Boolean(pytestOut.trim()) });
}

const sanitizeCheckProof = (name: string) => `check:${name.replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '') || 'premerge'}`;

/**
 * The E2E proof a gate filing binds (GY-3568, GY-3837): Mainworks's own filings keep create-work-item, the
 * case its install has always run; every other repository binds its own — the failing case itself
 * when the check is one, else its declared core case when known, else a new case named like the pinning proof.
 */
const gateFiledE2e = (key: string, repository: string, capabilities?: ProjectProofCapabilities): { proof: string; clause: string } => {
  if (repository.toLowerCase() === mainworksRepository) return { proof: 'e2e:create-work-item', clause: 'creating a work item still works' };
  const check = key.slice(key.indexOf(':') + 1);
  if (check.startsWith('e2e:')) return { proof: check, clause: `the E2E case ${check.slice(4)} passes again` };
  if (capabilities?.coreCase) return { proof: `e2e:${capabilities.coreCase}`, clause: `the E2E case ${capabilities.coreCase} passes` };
  return { proof: `e2e:${pinningProof(key).slice('unit:'.length)}`, clause: `a new E2E case ${pinningProof(key).slice('unit:'.length)} passes` };
};

/**
 * A batch gate filing's item (GY-3160, GY-3568, GY-3837): binds a proof the repository can actually execute.
 * - E2E check in a project without a unit runner: binds `e2e:NAME` directly (never `unit:`).
 * - Declared `preMerge` check: binds `check:NAME` directly (never `unit:`).
 * - Test file in a project with a unit runner (or legacy callers omitting capabilities): keeps `unit:...` pinning proof.
 * - Any other check in a project without a unit runner: binds the repository's E2E proof (never `unit:`).
 */
export const gateFiledItem = (
  input: { title: string; description: string; key: string },
  baseBranch: string,
  repository: string,
  capabilities?: ProjectProofCapabilities,
) => {
  const check = input.key.slice(input.key.indexOf(':') + 1);
  const isFlake = input.key.startsWith('flake:');
  const hasUnitRunner = capabilities ? capabilities.unitRunner : true;
  const preMergeName = capabilities?.preMergeChecks?.find(name => check === name || check === `test:${name}`) ?? null;
  const plannedFile = !preMergeName ? /^(?:flake|known-red):test:(.+)$/.exec(input.key)?.[1] : undefined;
  const e2e = gateFiledE2e(input.key, repository, capabilities);

  let proof: string;
  let ac1Text: string | undefined;
  let type: 'bug' | 'chore' = 'bug';

  if (preMergeName) {
    proof = sanitizeCheckProof(preMergeName);
    ac1Text = isFlake
      ? `The declared check ${preMergeName} is fixed at its cause, not skipped or weakened, and passes deterministically`
      : `The declared check ${preMergeName} is fixed at its cause, not skipped or weakened, and passes in the merge trial`;
    if (isFlake && !hasUnitRunner) type = 'chore';
  } else if (check.startsWith('e2e:') && !hasUnitRunner) {
    proof = check;
    ac1Text = isFlake
      ? `The E2E case ${check.slice(4)} is fixed at its cause, not skipped or weakened, and passes deterministically`
      : `The E2E case ${check.slice(4)} is fixed at its cause, not skipped or weakened, and passes in the merge trial`;
    if (isFlake) type = 'chore';
  } else if (hasUnitRunner) {
    proof = pinningProof(input.key);
    ac1Text = isFlake ? flakyPinText : undefined;
  } else {
    proof = e2e.proof;
    ac1Text = isFlake
      ? `The check ${check} is fixed at its cause, not skipped or weakened, and passes deterministically`
      : `The check ${check} is fixed at its cause, not skipped or weakened, and passes in the merge trial`;
    if (isFlake) type = 'chore';
  }

  return faultItem({
    faultKey: input.key,
    title: input.title,
    description: input.description,
    proof,
    type,
    ...(ac1Text ? { ac1Text } : {}),
    repaired: { text: 'The batch gate passes again', proof: repairedProof },
    e2e,
    reason: `Filed by the batch gate on ${baseBranch}`,
    ...(plannedFile ? { plannedFiles: [plannedFile] } : {}),
  });
};

/** GY-3735: a merge trial's flake files the batch gate's own "Flaky check on main: CHECK" item, or notes the one its fault key has. */
export const fileFlakyCheck = async (
  reads: { createWork?: Parameters<typeof fileLoopFault>[0]['createWork']; note?: Parameters<typeof fileLoopFault>[0]['note']; git?: (args: string[]) => Promise<string>; baseBranch: string; now(): number },
  repository: string,
  work: readonly Work[],
  check: string,
  text: string,
) => {
  const capabilities = reads.git ? await readProjectCapabilities(reads.git, `refs/remotes/origin/${reads.baseBranch}`).catch(() => undefined) : undefined;
  return fileLoopFault(
    { work, now: reads.now(), createWork: reads.createWork, note: reads.note },
    gateFiledItem({ key: `flake:${check}`, title: `Flaky check on main: ${check}`, description: text }, reads.baseBranch, repository, capabilities),
    text,
  );
};
