export { humanOnlyDecisions } from '../model/human-request.js';
// Concern: session and worker harness permissions, and starting the master session.
import { itemLeadBrief } from '../review-prompt.js';
import { lstat, mkdir } from 'node:fs/promises';
import { mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, basename } from 'node:path';
import { type ChildRun, defaultChildRun } from '../child-runner.js';
import { nameForLaunch } from '../session-name.js';
import { launchAuthorization } from '../repository-setup.js';
import { type HarnessPlan, type HarnessRule, repositoryClaudeConfig, writeHarnessPermissions, masterHarnessPlan, claudeRuleProblem, bashRuleMatches } from '../harness.js';
import { userUnitDirectory, legacyLoopUnit, readInstallUnits } from '../install/units.js';
import type { MasterConfig, WorkerProfile } from './profiles.js';
import { coordinatorCheckoutRoot, promotionCommand, runtimeLoginHomes, workerConfinementRefusal } from './profiles.js';
import { masterCredentialMask, preparePeerExchange } from './confinement.js';
import { loadMasterConfig } from './config.js';
import { atomicPrivateText } from '../private-file.js';
import { readProjectMemory } from '../project-memory.js';
import { masterBriefSection, masterLessonsSection } from '../model/project-memory.js';
import { accountLaunch } from './environments.js';
import { type RequestDelivery, launchSession } from './launch.js';
import { type HerdrAgent, herdrSessionPaths, stopCreatedHerdrTab } from './herdr.js';
import type { PreparedWorker } from './dispatch.js';
import { worktreeRoot } from '../install/worktree-root.js';
import { mainworksRepository } from '../scenarios.js';
import { hostHeavyJobsDirectory, slotsDirectoryVariable, verificationEnvironment } from './verification-slots.js';
import { setting } from '../setting.js';
import { stateDirectory } from '../install/layout.js';

/**
 * The master's harness rules cover everything the master owns, not only the coordination loop:
 * tuning its own configuration through the CLI's owned fields (`master config` — a direct edit of
 * master.json would reach the credential and identity paths onboarding owns, so it
 * is not granted), restarting and reading the durable loop's exact unit, administering the
 * deployment it verifies, and re-running CI for a candidate. None of these reaches a merge, a
 * verdict, evidence, or a credential; the enforced boundaries are unchanged.
 */
function withMasterOwnedRules(plan: HarnessPlan, config: MasterConfig, root: string, unitDirectory: string): HarnessPlan {
  if (plan.harness === 'codex') return { ...plan, manual: `${plan.manual}# The master's own commands reach GitHub, Mainworks, the deployment and its private state beside\n# its credential, so start it with its broadest approval mode (master start codex adds these):\n#   --ask-for-approval never --sandbox workspace-write -c sandbox_workspace_write.network_access=true --add-dir ${JSON.stringify(dirname(config.credentialFile))}\n` };
  if (plan.harness !== 'claude') return plan;
  const workflows = [config.run.proofWorkflow, config.run.smokeWorkflow].filter((name): name is string => !!name);
  const units = installUnitRules(root, unitDirectory);
  const owned: HarnessRule[] = [
    { rule: 'Read(./.graphyard/master.json)', why: 'Read the master configuration the loop runs from: profiles, agent environments, run settings. It holds paths to credentials, never their values. Changing it goes through master config, which writes only the fields the master owns.' },
    ...units.allow,
    // Railway deploys each application from git on its own; Mainworks observes each app's versionUrl.
    { rule: 'Bash(railway status:*)', why: 'Railway deploys from git and Mainworks observes each app\'s versionUrl: read which release a service serves when master status names it lagging or failed.' },
    { rule: 'Bash(railway logs:*)', why: 'Read a service\'s deploy logs when its versionUrl does not answer main: Railway builds from git, Mainworks only observes.' },
    { rule: 'Bash(railway deployment:*)', why: 'List a service\'s deployments and their commits when its versionUrl lags main.' },
    { rule: 'Bash(railway redeploy:*)', why: 'Redeploy a service\'s current release after an infrastructure failure; Railway builds only what the base branch already holds.' },
    { rule: 'Bash(gh run list:*)', why: 'Find the CI and workflow runs of a candidate or delivery.' },
    { rule: 'Bash(gh run view:*)', why: 'Read a run\'s jobs and logs when a gate reports a failing check.' },
    { rule: 'Bash(gh run watch:*)', why: 'Follow a run the loop is waiting on.' },
    { rule: 'Bash(gh run rerun:*)', why: 'Re-run a flaky or infrastructure-failed run on the same commit; the check still has to pass on that exact head.' },
    ...workflows.map(name => ({ rule: `Bash(gh workflow run ${name}:*)`, why: `Request the configured ${name} workflow by hand, as master run does; the provider runs it with its own trusted secret.` })),
  ];
  return { ...plan, allow: [...plan.allow, ...owned.filter(entry => !plan.allow.some(existing => existing.rule === entry.rule))],
    deny: [...plan.deny, ...units.deny.filter(entry => !plan.deny.some(existing => existing.rule === entry.rule))] };
}

/**
 * The master's unit rules (GY-1441): every systemctl command it may run names this install's own
 * loop unit exactly, and every other Mainworks unit on the host is denied, so a master started from
 * a second install can never restart another install's loop. A glob cannot say "every
 * mainworks-* unit but mine", so the denies are the shapes that can never be this install's (the
 * legacy names for a per-install unit, the per-install names for a legacy alias) plus every other
 * install's unit found installed beside it; a deny that would match one of the install's own
 * commands is dropped, since in Claude Code a deny beats the allow.
 */
function installUnitRules(root: string, unitDirectory: string): { allow: HarnessRule[]; deny: HarnessRule[] } {
  const units = readInstallUnits(root), master = units.master;
  const allow: HarnessRule[] = [
    { rule: `Bash(systemctl --user restart ${master})`, why: 'Restart the durable loop after a configuration or CLI change; it resumes from its persisted cursors. The unit is this install\'s own, exact, so no other unit can be named.' },
    { rule: `Bash(systemctl --user start ${master})`, why: 'Start the durable loop when master status reports it is not running.' },
    { rule: `Bash(systemctl --user enable --now ${master})`, why: 'Re-enable and start the loop\'s own supervisor when master status reports the unit installed but disabled; without it nothing restarts the loop after a crash or a reboot. The unit is exact, so no other unit can be enabled.' },
    { rule: `Bash(systemctl --user stop ${master})`, why: 'Stop the durable loop before an upgrade; nothing is lost, its cursors are persisted before every action.' },
    { rule: `Bash(systemctl --user status ${master})`, why: 'Read whether the durable loop is running.' },
    { rule: 'Bash(systemctl --user daemon-reload)', why: 'Reload the loop\'s user unit after it is edited.' },
    { rule: `Bash(journalctl --user -u ${master}:*)`, why: 'Read the loop\'s launch, failover and refusal log; the unit is pinned to the loop\'s own.' },
  ];
  const why = 'Another Mainworks installation on this host owns this unit; restarting, stopping or enabling it would disrupt that install\'s loop (GY-1441).';
  const shapes = units.alias ? ['graphyard-master-*'] : [`${legacyLoopUnit}*`, 'graphyard-master'];
  const others: string[] = [];
  try {
    for (const name of readdirSync(unitDirectory)) {
      if (name === master) continue;
      if (/^(?:graphyard|mainworks)-master[A-Za-z0-9._-]*\.service$/.test(name)) others.push(name, `${name} *`, name.replace(/\.service$/, ''));
    }
  } catch { /* no unit directory: only the structural shapes apply */ }
  const own = allow.map(entry => /^Bash\((.*)\)$/.exec(entry.rule)![1].replace(/:\*$/, ''));
  const deny = [...new Set([...shapes, ...others])].map(target => ({ rule: `Bash(systemctl --user * ${target})`, why }))
    .filter(entry => !claudeRuleProblem(entry.rule) && !own.some(command => bashRuleMatches(entry.rule, command)));
  return { allow, deny };
}

/**
 * Role-scoped harness rules for the sessions the master launches. The master's own rules live in
 * the repository's .claude/settings.local.json, and Claude Code loads that file for every session
 * started anywhere under the repository — assigned worktrees included — so a master deny such as
 * `git push` would otherwise refuse a worker's push to its own branch. Each Claude session the
 * master launches under a repository that carries project settings therefore starts with only the
 * operator's user settings plus its own role file (`--setting-sources user --settings FILE`), and
 * never the master's. Like the master's rules these are a prompt policy, not authority: the
 * lease, the session's own credential and branch protection remain the enforcement.
 */
export type SessionRole = 'worker' | 'reviewer' | 'producer';
export interface SessionHarnessInput { role: SessionRole; kind: string | undefined; cliPath: string; repository: string; baseBranch: string; credentialHome: string; credentialDirectories: string[]; branch?: string; pr?: number;
  /** The detached checkout Mainworks allocated for a reviewer session under the managed worktree root. */
  checkout?: string }
export function sessionHarnessPlan(input: SessionHarnessInput): HarnessPlan {
  if (input.kind !== 'claude') return { harness: input.kind ?? 'unknown', file: null, allow: [], deny: [], manual: null, note: `${input.kind ?? 'This runtime'} does not load the repository's Claude Code settings, so it inherits no master rule; its own approval configuration applies.` };
  const cli = `node ${input.cliPath}`;
  const secrets: HarnessRule[] = [
    ...[...new Set(input.credentialDirectories)].sort().map(directory => ({ rule: `Read(/${directory}/**)`, why: 'Mainworks credentials live here; the session uses its own through the CLI and never reads their bytes.' })),
    { rule: 'Read(./.graphyard/connection.json)', why: 'Holds an individual Mainworks credential.' },
    { rule: 'Read(./.graphyard/credentials.json)', why: 'Holds local principal credentials.' },
    { rule: 'Read(./.graphyard/github-app.json)', why: 'Holds the control-plane App private key.' },
    // GY-3711: a fresh install keeps the same files in .mainworks.
    { rule: 'Read(./.mainworks/connection.json)', why: 'Holds an individual Mainworks credential.' },
    { rule: 'Read(./.mainworks/credentials.json)', why: 'Holds local principal credentials.' },
    { rule: 'Read(./.mainworks/github-app.json)', why: 'Holds the control-plane App private key.' },
    { rule: 'Read(**/*.pem)', why: 'App private keys are never read into a session transcript.' },
    { rule: 'Read(**/*.token)', why: 'Token files are never read into a session transcript.' },
    { rule: 'Bash(gh pr merge:*)', why: 'Delivery happens only through the guarded merge.' },
    // Scoped to the merge endpoints, not the word: a reviewer's verdict body often says "merge", and
    // in Claude Code a deny beats the allow for its one review call.
    { rule: 'Bash(gh api *pulls/*/merge*)', why: 'A raw pull-request merge call is an administrative merge bypass.' },
    { rule: 'Bash(gh api *repos/*/merges*)', why: 'A raw branch-merge call is an administrative merge bypass.' },
    { rule: 'Bash(gh api graphql*)', why: 'GraphQL reaches merge and merge-queue mutations; no session needs it.' },
    { rule: 'Bash(agent-browser *)', why: "The operator's browser profile is driven only by the master's recorded flows." },
  ];
  const noVerdict: HarnessRule[] = [
    { rule: 'Bash(gh pr review:*)', why: 'Only the independent reviewer posts a verdict.' },
    { rule: 'Bash(gh api *pulls/*/reviews*)', why: 'Only the independent reviewer posts a verdict.' },
  ];
  const noPush: HarnessRule[] = [
    { rule: 'Bash(git push:*)', why: 'This session implements nothing and pushes nothing.' },
    { rule: 'Bash(git commit:*)', why: 'This session changes nothing in the candidate.' },
    { rule: `Bash(${cli} claim:*)`, why: 'Claiming work would make this principal an implementer.' },
  ];
  // GY-3331: a product reviewer walks the app with agent-browser, and a confined session's HOME is
  // private scratch — never the operator's browser profile — so the operator-profile deny below
  // stays on workers, producers and the master alone.
  const reviewerSecrets = secrets.filter(entry => entry.rule !== 'Bash(agent-browser *)');
  let allow: HarnessRule[], deny: HarnessRule[];
  if (input.role === 'worker') {
    if (!input.branch) throw new Error('A worker harness names the assigned branch it may push');
    // The same worker rules installWorkerHarness writes into the worktree, plus the shared secret
    // and verdict denies: loaded through --settings they apply even though the worktree's own
    // settings file is not loaded.
    const worker = workerHarnessPlan({ cliPath: input.cliPath, branch: input.branch, baseBranch: input.baseBranch, credentialHome: input.credentialHome });
    const extra = [...secrets, ...noVerdict, { rule: `Bash(${cli} evidence:*)`, why: 'Implementation workers never submit trusted evidence.' }];
    allow = worker.allow;
    deny = [...worker.deny, ...extra.filter(entry => !worker.deny.some(existing => existing.rule === entry.rule))];
  } else if (input.role === 'reviewer') {
    allow = [
      { rule: 'Bash(gh pr diff:*)', why: 'Read the candidate diff.' },
      { rule: 'Bash(gh pr view:*)', why: 'Read the pull request and poll its mergeability before posting.' },
      // GY-1492: the verdict goes through review post, which checks the launch's binding, the head,
      // mergeability and the thread lines before its one POST; a raw review call is denied below.
      { rule: `Bash(${cli} review post:*)`, why: 'Post the one verdict this session was launched for, checked against its launch binding; the master itself is denied every review call.' },
      // Surrounding code is read from a detached checkout under the managed worktree root, which
      // Mainworks allocates for the session and removes when it ends.
      ...(input.checkout ? [{ rule: 'Bash(git fetch:*)', why: 'Fetch the exact head under review.' },
        { rule: `Bash(git worktree add --detach ${input.checkout}:*)`, why: 'Check the exact head out, read-only, in the checkout Mainworks allocated for this session.' }] : []),
    ];
    deny = [...reviewerSecrets, ...noPush,
      { rule: `Bash(${cli} evidence:*)`, why: 'A reviewer never submits evidence.' },
      { rule: 'Bash(gh api *pulls/*/reviews*)', why: 'The verdict is posted only through review post, which checks it first.' },
      { rule: 'Edit(./**)', why: 'The review session is read-only.' },
      { rule: 'Write(./**)', why: 'The review session is read-only.' },
    ];
  } else {
    allow = [
      { rule: `Bash(${cli} evidence:*)`, why: 'Submit the evidence of the proof group this session was launched for, under its own producer credential.' },
      { rule: `Bash(${cli} status:*)`, why: 'Read the acceptance criteria the proofs establish.' },
      { rule: 'Bash(git fetch:*)', why: 'Fetch the exact head.' },
      { rule: 'Bash(git worktree add:*)', why: 'Check the exact head out in a detached worktree of its own.' },
      { rule: 'Bash(git worktree remove:*)', why: 'Remove that worktree once every proof is submitted.' },
    ];
    deny = [...secrets, ...noPush, ...noVerdict];
  }
  return { harness: 'claude', file: null, allow, deny, manual: null, note: `Role-scoped ${input.role} rules; the session loads these and the operator's user settings, never the repository's project or local settings where the master's rules live.` };
}

/** Where a session's role file lives: beside the ledgers, ignored by Git, never inside a worktree it is launched for. */
export const sessionHarnessFile = (root: string, role: SessionRole, profile: string) => resolve(stateDirectory(root), 'harness', `${role}-${profile}.json`);
async function repositoryCarriesClaudeSettings(root: string) {
  for (const name of ['settings.json', 'settings.local.json']) {
    try { await lstat(resolve(root, '.claude', name)); return true; } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  // Folder trust checks ancestors too. An isolated HOME can put durable scratch below a
  // different account's settings; exclude those project sources rather than trusting them.
  return !!await repositoryClaudeConfig(root);
}
/**
 * Writes the role file and returns the runtime arguments that load it instead of the repository's
 * settings. A Claude session whose repository and ancestors carry no project settings inherits
 * nothing and is launched with its profile arguments unchanged. Loading only the user settings also leaves
 * out the repository's AGENTS.md, so such a session carries the launch authorization written there
 * (repository-setup.ts launchAuthorization) as its role text, loaded from the session's role file.
 */
/** A session's host heavy-job variables (GY-612, GY-3290): the lock directory every project on this host shares, its project, and the wrappers first on PATH. */
export function sessionVerificationEnvironment(config: Pick<MasterConfig, 'repository'>): Record<string, string> {
  return verificationEnvironment(config.repository);
}
/**
 * The host's lock directory, which every session must be able to write to take a slot, created now
 * so a sandboxed runtime (Codex under workspace-write) can be granted it with `--add-dir`: without
 * the grant its `mkdir slot-N` is refused and the run goes ahead unbounded. It is the only path the
 * budget adds to a session's writable roots. None when it cannot be created.
 */
export function sessionSlotsGrant(): string[] {
  const directory = setting(slotsDirectoryVariable) ?? hostHeavyJobsDirectory();
  try { mkdirSync(directory, { recursive: true }); } catch { return []; }
  return [directory];
}
export async function prepareSessionHarness(root: string, config: MasterConfig, input: Omit<SessionHarnessInput, 'cliPath' | 'repository' | 'baseBranch' | 'credentialHome' | 'credentialDirectories'> & { profile: string; credentialFiles?: string[] }) {
  const plan = sessionHarnessPlan({ ...input, cliPath: config.cliPath, repository: config.repository, baseBranch: config.baseBranch, credentialHome: dirname(dirname(config.credentialFile)),
    credentialDirectories: [dirname(config.credentialFile), ...(input.credentialFiles ?? []).map(file => dirname(file))] });
  // Every session's heavy jobs share the host's budget (GY-612, GY-3290): its tab carries the host's
  // lock directory, its project and the wrappers first on its PATH.
  const environment = sessionVerificationEnvironment(config);
  if (input.kind !== 'claude' || !await repositoryCarriesClaudeSettings(root)) return { plan, file: null, args: [] as string[], role: null as string | null, environment };
  const file = sessionHarnessFile(root, input.role, input.profile);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await atomicPrivateText(file, `${JSON.stringify({ permissions: { allow: plan.allow.map(entry => entry.rule), deny: plan.deny.map(entry => entry.rule) } }, null, 2)}\n`);
  // The authorization is the session's role text: startAgentSession writes it to the session's
  // role file and the command line loads that file (GY-121), never the text itself.
  return { plan, file, args: ['--setting-sources', 'user', '--settings', file], role: launchAuthorization.replace(/\s+/g, ' ') as string | null, environment };
}
/**
 * The master session's own first request (GY-93): the role, its boundaries and its commands, shared
 * verbatim by the human launch (`master start`) and the loop's launch (GY-898). A replacement
 * started by the loop carries the same request plus the handover the loop composes from
 * control-plane truth (master-session.ts masterRequest), so both paths start the same session.
 */
/** GY-3233: the master's rule for a fault in Mainworks itself, on an install for another repository; guide master states it too. */
export const upstreamRule = (repository: string) => `A Mainworks fault (stuck upgrade, stalled loop step, sandbox, launch or trial-host failure: network, disk, missing trial-image tool) goes to master.json's upstream or master status; never file it in ${repository} or change ${repository} to work around it.`;
/** GY-3521: the mission every master starts from, identical for every project and runtime. */
export const masterMission = 'Mission: build world-class software. Be creative and innovative: look for the better way, not just the next ticket. Push hard to resolve every problem yourself (run the command, choose the model, fix the fault) before involving the owner.';
export function masterPrompt(config: MasterConfig): string {
  // GY-1501: a supervised install has no operator-agent identity by design; that is its mode, not an onboarding fault.
  const supervised = config.supervision === 'supervised';
  const supervisedInstruction = `This install is supervised: an agent reviewer reviews each head and the control plane merges it, but supervised mode provisions no operator-agent identity; that is the mode the operator chose, not an onboarding fault, so do not report the missing identity. Record what needs the operator in master status and leave it there; promotion to autonomy (${promotionCommand}) is the operator's choice.`;
  // GY-3274: the master owns the product's success — it learns the problem
  // and the users before acting, keeps the product brief, ranks work by its success signals and
  // re-checks those signals after each deploy; the owner's stated mission and priorities override that ranking.
  const founder = `You are the dedicated Mainworks master agent for ${config.repository}, responsible for the product succeeding: learn the problem and users first (repository, docs, the running app, owner messages, item history), write and revise the product brief, turn it into goals and work items ranked by impact on its success signals, re-check them after each deploy, and record lessons; the owner's stated mission and priorities override that ranking.`;
  // GY-3491: the rest of the master's rules live once, in master guide.
  return `${masterMission} ${founder} ${itemLeadBrief.trim()}${config.forPerson ? ` Work only items whose human owner is ${config.forPerson}.` : ' Skip owned items.'} Never implement, claim worker leases, review, approve or submit evidence, weaken requirements, or bypass gates. Run node ${config.cliPath} master status, then node ${config.cliPath} master guide. Investigate with node ${config.cliPath} ask GY-N QUESTION. Act without asking: only goals and priorities, spending money or opening third-party accounts, and issuing credentials to people belong to the human. ${config.repository.toLowerCase() === mainworksRepository ? '' : `${upstreamRule(config.repository)} `}${supervised ? supervisedInstruction : `Every decision is yours to apply at once with your own identity.${config.operatorAgent ? '' : ` Your operator-agent identity is not provisioned yet; report that onboarding must run master autonomy --admin-token-stdin --apply.`}`}`;
}

export async function startMaster(root: string, kind: WorkerProfile['kind'], agentArgs: string[], agents: HerdrAgent[], run?: ChildRun) {
  if (!kind) throw new Error('Choose a supported master agent kind');
  const config = await loadMasterConfig(root);
  const memory = await readProjectMemory(root).catch(() => null);
  const masterRetry = `mainworks master start ${kind}, once masterAgentName in .graphyard/master.json is a name Herdr can launch`;
  const name = nameForLaunch(masterRetry, () => config.masterAgentName);
  if (agents.some(agent => agent.name === name)) throw new Error(`Master agent ${name} is already visible in Herdr; the loop supervises the live master session (master status, daemon.master) — close it there or in Herdr before starting another`);
  // Installation, not operator memory: the harness the master runs under learns the master's own
  // commands before the session starts, so a routine status or review never waits on a keypress.
  const harness = await writeHarnessPermissions(root, masterHarness(root, config, kind), true);
  let pane: string | undefined, tabId: string | undefined, delivery: RequestDelivery | undefined;
  try {
    // The master runs with its runtime's broadest approval mode too; the harness rules above, not
    // runtime prompts, say what it may do. Codex's sandbox is widened to the private state the
    // master's own commands write beside its credential, and its tab carries the recipe's variables.
    // Pin the existing login before confinement replaces the operator HOME with private scratch.
    // Only the selected runtime directory is granted, never the operator home itself.
    const environment: Record<string, string> = kind === 'codex'
      ? { CODEX_HOME: resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex')) }
      : kind === 'claude' ? { CLAUDE_CONFIG_DIR: resolve(process.env.CLAUDE_CONFIG_DIR || resolve(homedir(), '.claude')) } : {};
    const launch = accountLaunch({ kind, approvals: 'auto', agentArgs, environment }, null, { writable: [dirname(config.credentialFile)] });
    // GY-3237: the install state the master session's own recovery commands write — reviewer
    // bindings beside the coordinator credential (reviewer.ts reviewerCredentialDirectory) and
    // the managed worktree root its launches allocate checkouts under — granted writable.
    // GY-3385: and each recorded peer's peers directory, where the session places the reporter
    // tokens it issues them (master peer issue), created where missing before the confinement binds.
    const stateDirectories = [resolve(config.credentialFile, '../..', 'reviewers'), worktreeRoot(root, config), ...preparePeerExchange(config)];

    // The master starts on its own request too; a runtime without that contract is prompted
    // after start, with the text last and the confirmation following it. The request is the
    // shared master prompt (GY-898), the same one the loop's launch carries with its handover,
    // with the product brief and then the master's own recorded lessons (GY-3274) after it.
    // The master is confined like every other launched session (GY-1658): its configuration,
    // administration and browser-flow commands run from the coordinator root with the checkout
    // read-only, its managed .graphyard state writable; a host that cannot confine it refuses.
    ({ delivery } = await launchSession({ name, kind, args: launch.args, text: masterPrompt(config) + masterBriefSection(memory) + masterLessonsSection(memory), workspace: config.herdrWorkspace, label: `Mainworks master · ${config.repository}`, environment: { GRAPHYARD_MASTER: '1', ...launch.environment }, run, onPane: (nextPane, nextTab) => { pane = nextPane; tabId = nextTab; }, start: { directory: root, confirm: 'follow', retry: masterRetry, environment: launch.environment, confinement: 'master', masterStateDirectory: dirname(config.credentialFile), stateDirectories, credentialMask: masterCredentialMask(config, runtimeLoginHomes(launch.environment, null, launch.kind)), herdrPaths: herdrSessionPaths(config) } }));
  } catch (error) {
    const malformedTab = (error as any)?.herdrTab as string | undefined;
    if (pane || tabId || malformedTab) try { await stopCreatedHerdrTab(pane, tabId ?? malformedTab, run); }
    catch { throw new Error(`${error instanceof Error ? error.message : 'Master startup failed'}; Herdr could not confirm cleanup of the created tab`); }
    throw error;
  }
  return { agentName: name, kind, pane: pane!, status: delivery === 'request' ? 'started on its request' : 'started and prompted', delivery, focusChanged: false, harness };
}

// ---- Autonomy ----------------------------------------------------------------------------------
// Humans set goals; agents run the loop. Everything a human used to approve the master applies with
// its own operator-agent identity. What stays human is this list, and nothing else.
export const masterOperatorCapabilities = ['policy:requirements', 'policy:review-provider', 'e2e:record'] as const;
export const autonomyReason = 'Master autonomy onboarding: the master\'s operator-agent identity';
/** The one agent identity onboarding provisions: the master's own, which applies every decision. */
export function autonomyPlan(config: MasterConfig) {
  const name = config.repository.split('/').at(-1)!.replace(/[^a-zA-Z0-9._-]/g, '-');
  const directory = dirname(config.credentialFile), stem = basename(config.credentialFile, '.token');
  const scope = { repositories: [config.repository], workItems: ['*'] };
  return {
    operatorAgent: { id: config.operatorAgent?.id ?? `graphyard-master-${name}-operator`.slice(0, 100), displayName: `Mainworks master for ${config.repository}`.slice(0, 100), capabilities: [...masterOperatorCapabilities], scope,
      credentialFile: config.operatorAgent?.credentialFile ?? resolve(directory, `${stem}-operator.token`), role: 'Applies every decision the master makes (create, release, unblock, requirements, rework, close, attest) under its own name' },
  };
}

/** Rules every master session gets on top of its loop rules: it cannot borrow another identity. */
const autonomyDeny = (credentialHome: string): HarnessRule[] => [
  { rule: 'Bash(*GRAPHYARD_TOKEN_FILE=*)', why: 'The master acts only as its own identities; pointing a command at a worker\'s or producer\'s credential file would let it borrow another identity.' },
  { rule: 'Bash(*MAINWORKS_TOKEN_FILE=*)', why: 'The master acts only as its own identities; pointing a command at a worker\'s or producer\'s credential file would let it borrow another identity.' },
  { rule: `Edit(//${credentialHome}/**)`, why: 'Agent credentials are issued by onboarding and rotated through the API, never edited in place.' },
];
export function masterHarness(root: string, config: MasterConfig, harness: string, options: { unitDirectory?: string } = {}) {
  const credentialHome = dirname(dirname(config.credentialFile));
  const plan = withMasterOwnedRules(masterHarnessPlan({ harness, root, cliPath: config.cliPath, repository: config.repository, baseBranch: config.baseBranch, credentialHome }), config, root, options.unitDirectory ?? userUnitDirectory());
  return plan.file ? { ...plan, deny: [...plan.deny, ...autonomyDeny(credentialHome)] } : plan;
}

/**
 * A worker session's own rules, written into its assigned worktree: it runs its item's commands,
 * pushes its assigned branch and opens the pull request without a keypress, and is denied pushing
 * the base branch, force-pushing, deleting a ref, rebasing, merging, reviewing and reading a
 * credential, in every spelling a rule names; a spelling no rule names is unmatched, not denied.
 *
 * The one history rewrite it may make goes through `restore-branch GY-N EPOCH`, never a raw push:
 * the recovery of a contaminated branch resets the assigned branch to the item's reviewed
 * head, syncs it onto the base and pushes, and the rework the control plane authorizes must be
 * executable by the session it dispatches (GY-128). A permission glob cannot say "this ref and no
 * other", and a Claude worker runs under bypassPermissions, where a command no rule matches runs.
 * So every raw `--force*` push is denied, the lease push included, and the CLI makes the one lease
 * push itself: to the branch registered for the caller's live lease, conditional on the tip it
 * fetched (`--force-with-lease=refs/heads/BRANCH:TIP`), so it replaces only what it saw.
 */
/** Submission guidance in every worker request's pre-submit list; merge trials judge trial-only tests. */
export const submissionPolicyRule = "The full test suite is CI's gate: run the build and npm run test:affected -- BOUND_PROOF_TEST_FILES, not npm test. ";
export const sandboxFailureRule = "For sandbox-only test failures, including required criteria tests lacking Docker, unnested bubblewrap or a trial-image fixture: record command and environment error in the commit message, submit with complete instead of recording a blocker; the merge trial runs the test and decides. Fix or block assertion failures, build errors and refusals of your own writes. ";
/** Every character an empty-source refspec's name can start with as typed: a ref name's first character, a quote, or an expansion. */
export const emptySourceStarts = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ...'_.-/@\'"$`{~'];
/**
 * The coordinator checkout's own files, denied to a worker session's Edit and Write (GY-857).
 * That checkout runs the loop, and worker sessions once wrote their
 * half-finished work there by absolute path; a restart then loaded it. Every area the loaded
 * code lives in is denied in both files the worker reads — its worktree's settings and its role
 * file — while the worktree itself, and the managed state beside it under `.graphyard/`, stay
 * its to write. A harness rule is a prompt policy; the lease, the worktree's own Git isolation
 * and branch protection remain the enforcement.
 */
const checkoutAreas = ['src', 'tests', 'scripts', 'bin', 'docs', 'examples', 'integrations', 'web', 'browser-tests', 'design', 'deploy', 'docker'];
function coordinatorWriteDenials(coordinatorRoot: string): HarnessRule[] {
  if (!coordinatorRoot || coordinatorRoot === '/') return [];
  const absolute = `//${coordinatorRoot.replace(/^\//, '')}`;
  const why = (area: string) => `The coordinator checkout runs the loop; this session writes only its assigned worktree, never ${area}/ there (GY-857).`;
  return checkoutAreas.flatMap(area => [{ rule: `Edit(${absolute}/${area}/**)`, why: why(area) }, { rule: `Write(${absolute}/${area}/**)`, why: why(area) }]);
}
export function workerHarnessPlan(input: { cliPath: string; branch: string; baseBranch: string; credentialHome: string }): HarnessPlan {
  const cli = `node ${input.cliPath}`;
  // GY-1835: the session opens no pull request — it submits the head with `complete GY-N EPOCH
  // --head` — so its harness allows no `gh pr` command.
  const allow: HarnessRule[] = [
    ...['status', 'sync', 'restore-branch', 'complete', 'blocked', 'heartbeat', 'events', 'diagnose'].map(command => ({ rule: `Bash(${cli} ${command}:*)`, why: `The worker's own ${command} command on its claimed item; the server checks the lease epoch.` })),
    { rule: `Bash(git push origin ${input.branch})`, why: 'Push the assigned branch; Mainworks observes it as the candidate head.' },
    { rule: `Bash(git push -u origin ${input.branch})`, why: 'Publish the assigned branch the first time.' },
    { rule: `Bash(git push origin HEAD:${input.branch})`, why: 'Push the current head to the assigned branch.' },
    { rule: 'Bash(git fetch origin)', why: 'Read the remote tips restore-branch and sync compare against.' },
    { rule: 'Bash(git reset --hard *)', why: 'Move the assigned branch back to the reviewed head before sync; it changes only this worktree.' },
    { rule: `Bash(git merge origin/${input.baseBranch})`, why: 'sync merges the base branch; the worker never rebases.' },
  ];
  // Every rewrite, in each spelling a rule can name: `--force`, `--force-with-lease` (bare or
  // `=REF:SHA`) and `--force-if-includes` alike, and the abbreviations git accepts for them. The
  // lease push of the assigned branch is restore-branch's, which checks the ref itself; no rule may
  // end in `:*` or ` *` where the bare prefix would match an allowed push, because Claude Code reads
  // both as "this prefix, with or without more". Nor may `:*` stand anywhere but at the end: Claude
  // Code skips such a rule and stops the session on a settings warning before it starts
  // (claudeRuleProblem), so the empty-source refspec is spelled once per character its name can
  // start with (` :g*`, ` :r*`, …), plus the bare ` :` that pushes every matching branch. Each rule
  // also has a twin for a push behind git's global options (`git -C DIR push`, `git -c KEY=VALUE push`).
  const push: [string, string][] = [
    ['*--force*', 'A raw force push, the lease form included, could rewrite any ref: a glob cannot limit it to the assigned branch. The one restoration push is restore-branch.'],
    ['*--f*', 'Any abbreviation git accepts for --force, --force-with-lease or --force-if-includes.'],
    ['-f*', 'Short form of a force push.'],
    ['* -f*', 'Short form of a force push.'],
    ['*-*f *', 'A force flag bundled with other short flags (-uf).'],
    ['*-*f', 'A force flag bundled with other short flags, last on the line.'],
    ['*+*', 'A leading + refspec is a force push.'],
    ['*--mirror*', 'Mirroring rewrites every ref on the remote.'],
    ['*--m*', 'An abbreviation of --mirror.'],
    ['*--all*', 'The worker pushes its assigned branch, never every branch.'],
    ['*--al*', 'An abbreviation of --all.'],
    ['*--delete*', 'Deleting a remote ref is never part of an attempt.'],
    ['*--de*', 'An abbreviation of --delete.'],
    ['*--pru*', 'Pruning deletes every remote ref the local side lacks.'],
    ['-d*', 'Short form of deleting a remote ref, alone or first in a bundle (-du).'],
    ['* -d*', 'Short form of deleting a remote ref, alone or first in a bundle (-du).'],
    ['*-*d *', 'A delete flag bundled with other short flags (-ud).'],
    ['*-*d', 'A delete flag bundled with other short flags, last on the line.'],
    ...emptySourceStarts.map((start): [string, string] => [`* :${start}*`, 'An empty source refspec deletes the ref it names, whatever the name.']),
    ['* :', 'A bare ":" refspec pushes every matching branch, the base branch included.'],
    [`*:${input.baseBranch}*`, 'The base branch moves only through the guarded merge.'],
    [`origin ${input.baseBranch}*`, 'The base branch moves only through the guarded merge.'],
    [`* ${input.baseBranch}`, 'The base branch moves only through the guarded merge.'],
    [`* ${input.baseBranch} *`, 'The base branch moves only through the guarded merge.'],
    [`*refs/heads/${input.baseBranch}*`, 'The base branch moves only through the guarded merge, in its full ref spelling too.'],
  ];
  const deny: HarnessRule[] = [
    ...push.flatMap(([form, why]) => [{ rule: `Bash(git push ${form})`, why }, { rule: `Bash(git -* push ${form})`, why: `${why} Also behind git's global options.` }]),
    ...coordinatorWriteDenials(coordinatorCheckoutRoot(input.cliPath)),
    { rule: 'Bash(git rebase:*)', why: 'sync merges the base branch; a rebase would re-resolve files already merged.' },
    { rule: 'Bash(gh pr merge:*)', why: 'Workers never merge; the control plane\'s merge gate decides.' },
    { rule: 'Bash(gh pr review:*)', why: 'Workers never review their own work.' },
    { rule: 'Bash(*GRAPHYARD_TOKEN_FILE=*)', why: 'A worker acts only as its own principal.' },
    { rule: 'Bash(*MAINWORKS_TOKEN_FILE=*)', why: 'A worker acts only as its own principal.' },
    { rule: `Read(//${input.credentialHome}/**)`, why: 'Credentials are used through the CLI, never read into a transcript.' },
    { rule: 'Read(**/*.token)', why: 'Token files are never read into a session transcript.' },
  ];
  return { harness: 'claude', file: '.claude/settings.local.json', allow, deny, manual: null, note: 'Worker rules for one assigned worktree: its own commands and its own branch. A harness rule is a prompt policy; branch protection, leases and the merge gate remain the enforcement.' };
}
/** Install the worker rules in a freshly prepared worktree, only where Git already ignores them. */
export async function installWorkerHarness(config: MasterConfig, profile: WorkerProfile, key: string, prepared: PreparedWorker) {
  // GY-857: a profile whose own settings would turn its runtime's write confinement off is
  // refused here, at the launch, whatever its kind — the worker never starts able to write
  // outside its assigned worktree.
  const refusal = workerConfinementRefusal(profile);
  if (refusal) throw new Error(refusal);
  if (profile.kind !== 'claude') return { applied: false, reason: `No generated worker rules for ${profile.kind}` };
  try { await defaultChildRun('git', ['check-ignore', '--quiet', '--', '.claude/settings.local.json'], { cwd: prepared.path }); }
  catch { return { applied: false, reason: 'The worktree does not ignore .claude/settings.local.json, so no rules were written into it' }; }
  const plan = workerHarnessPlan({ cliPath: config.cliPath, branch: `graphyard/${key.toLowerCase()}-${prepared.epoch}`, baseBranch: config.baseBranch, credentialHome: dirname(dirname(config.credentialFile)) });
  const written = await writeHarnessPermissions(prepared.path, plan, true);
  return { applied: written.applied, reason: null, added: written.added.length };
}
