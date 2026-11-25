// Concern: GY-3835 — one headless planner run on an empty board: gathers the brief, 6-hour flow
// numbers, rework causes and five slowest trial test files, runs a headless session, and files at
// most three unreleased draft items with why and simplest only (no criteria).
import { benchResultsPath, readBenchResults } from '../bench.js';
import {
  parsePlannerDrafts,
  plannerPrompt,
  slowestTrialTestFiles,
  type PlannerInput,
  type PlannerOutcome,
} from '../daemon/planner.js';
import { fleetRequest } from '../fleet.js';
import { defaultHeadlessExec, headlessRunMs, startHeadlessWorker, type HeadlessExec } from '../headless-session.js';
import { runtimeReport } from '../model/token-costs.js';
import type { FlowReport } from '../server/flow.js';
import { credentialMaskFor } from './confinement.js';
import { accountLaunch, onSelectedSession, selectAccount } from './environments.js';
import { runtimeLoginHomes, type MasterConfig } from './profiles.js';

const failureText = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 400);

export async function runPlanner(
  root: string,
  config: MasterConfig,
  input: PlannerInput,
  deps: {
    headless?: HeadlessExec;
    coordinatorRoot?: string;
    flow?: () => Promise<FlowReport | null>;
    createWork?: (body: Record<string, unknown>, idempotencyKey: string) => Promise<{ key?: string } | null>;
    select?: typeof selectAccount;
  } = {},
): Promise<PlannerOutcome> {
  const select = deps.select ?? selectAccount;
  let selected: Awaited<ReturnType<typeof selectAccount>>;
  try { selected = await select(config, 'worker', { name: 'planner', principal: 'planner' }); }
  catch (error) { return { skipped: failureText(error) }; }

  const startedAt = new Date().toISOString();
  try {
    const brief = input.brief ?? await fleetRequest(config, 'product-brief').then(body => typeof body?.brief?.markdown === 'string' ? body.brief.markdown : null, () => null);
    const flowReport = deps.flow ? await deps.flow().catch(() => null) : await fleetRequest(config, 'flow').then(body => body as FlowReport, () => null);
    const benchSlowest = readBenchResults(benchResultsPath(root)).at(-1)?.slowestFiles;
    const slowestTrialFiles = slowestTrialTestFiles(root, benchSlowest);
    const prompt = plannerPrompt({ brief, flow6h: flowReport?.['6h'] ?? null, slowestTrialFiles, openTitles: input.openTitles });

    let captured = '';
    const baseExec = deps.headless ?? defaultHeadlessExec();
    const exec: HeadlessExec = async (command, args, options) => {
      const output = await baseExec(command, args, options);
      captured = output;
      return output;
    };

    const ended = await onSelectedSession(selected, 'planner launch failed', async () => {
      const launch = accountLaunch({ kind: selected.account?.kind, approvals: 'auto', agentArgs: [], environment: {} }, selected.account, { headless: true, repositoryRoot: root });
      const credentialMask = credentialMaskFor(config, { runtimeHomes: runtimeLoginHomes(launch.environment, launch.contract?.homeVariable, launch.kind) });
      let settle!: (ended: { output: string; ok: boolean }) => void;
      const done = new Promise<{ output: string; ok: boolean }>(resolve => { settle = resolve; });
      const started = await startHeadlessWorker({
        name: 'planner',
        work: 'planner',
        subject: 'Empty-board planner draft',
        epoch: 1,
        principal: 'planner',
        account: launch.account,
        kind: launch.kind!,
        args: launch.args,
        contract: launch.contract,
        credentialMask,
        directory: root,
        supervisor: [],
        coordinatorRoot: deps.coordinatorRoot,
        environment: launch.environment,
        prompt,
        root,
        exec,
        timeoutMs: headlessRunMs,
        settle: async result => settle(result),
      });
      return started.ended ?? await done;
    });

    const rawOutput = captured || ended.output;
    const reply = runtimeReport(rawOutput).reply ?? rawOutput;
    const drafts = parsePlannerDrafts(reply);
    const filed: string[] = [];
    if (deps.createWork) {
      for (let index = 0; index < drafts.length; index += 1) {
        const draft = drafts[index]!;
        const created = await deps.createWork(
          {
            title: draft.title,
            why: draft.why,
            simplest: draft.simplest,
            ...(draft.goal ? { goal: draft.goal } : {}),
            type: draft.type ?? 'feature',
            priority: draft.priority ?? 2,
            criteria: [],
            origin: 'planner',
          },
          `planner-draft:${startedAt}:${index}`,
        );
        if (created?.key) filed.push(created.key);
      }
    }
    return {
      filed,
      result: filed.length
        ? `Filed ${filed.length} draft(s): ${filed.join(', ')}`
        : ended.ok ? 'Filed 0 drafts' : `Ended without drafts: ${ended.output.trim().split('\n').at(-1) ?? 'the run failed'}`,
    };
  } finally {
    await selected.release?.('the planner run ended').catch(() => false);
  }
}
