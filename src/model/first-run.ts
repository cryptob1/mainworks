import { isClosed } from './closure.js';
import type { Work } from './work.js';

/**
 * First-run onboarding state (GY-3603): an install with no merged work opens on the four-step
 * first-run page instead of an empty Home, driven by the existing setup checks and the fleet's
 * live-request status. Step 3 starts the first task from a small open issue or a typed change (GY-3709).
 */

/** Whether this install has at least one merged work item. */
export const hasMergedWork = (work: readonly Pick<Work, 'stage' | 'delivery' | 'observation'>[]): boolean =>
  work.some(item => item.stage === 'done' && !!(item.delivery?.mergedAt ?? item.observation?.mergedAt));

export interface FirstRunBuilderAccount {
  name: string;
  runtime: string;
  modelId: string | null;
  host: string | null;
  passed: boolean;
  error: string | null;
}

export interface FirstRunState {
  currentStep: 1 | 2 | 3 | 4;
  repository: string | null;
  fetchRefusal: string | null;
  step1Done: boolean;
  builder: FirstRunBuilderAccount | null;
  step2Done: boolean;
  activeTask: Work | null;
  step3Done: boolean;
}

function evaluateBuilder(account: any): FirstRunBuilderAccount {
  const name = typeof account?.name === 'string' ? account.name : 'builder';
  const runtime = typeof account?.runtime === 'string' ? account.runtime : '';
  const modelId = typeof account?.modelId === 'string' && account.modelId.trim() ? account.modelId.trim() : null;
  const host = typeof account?.host === 'string' && account.host.trim() ? account.host.trim() : null;
  const smoke = account?.smoke as { result?: string; reason?: string | null } | null | undefined;
  const passed = account?.enabled !== false
    && account?.loggedIn !== false
    && account?.eligible !== false
    && !!modelId
    && (smoke?.result === 'pass' || (!!account?.checkedLive && account?.quota === 'available'));
  let error: string | null = null;
  if (!passed) {
    if (smoke?.result === 'fail') {
      error = (typeof smoke.reason === 'string' && smoke.reason.trim())
        || (typeof account?.reason === 'string' && account.reason.trim())
        || 'The live request did not answer on the registered model.';
    } else if (typeof account?.reason === 'string' && account.reason.trim()) {
      error = account.reason.trim();
    } else if (typeof account?.ineligible === 'string' && account.ineligible.trim()) {
      error = account.ineligible.trim();
    }
  }
  return { name, runtime, modelId, host, passed, error };
}

/**
 * Derive the four first-run steps from the live `/api/status` and `/api/work-snapshot` reads.
 * Step 2 passes only after a live request answers on a registered model id: a passing smoke, or a host live check
 * (`checkedLive`) that found the quota available.
 */
export function firstRunState(status: any, work: readonly Work[]): FirstRunState {
  const repository = typeof status?.repository === 'string' && status.repository.trim() ? status.repository.trim() : null;
  const fetchRefusal = typeof status?.setup?.fetchRefusal === 'string' && status.setup.fetchRefusal.trim() ? status.setup.fetchRefusal.trim() : null;
  const step1Done = !!repository && !fetchRefusal;

  const accounts: any[] = Array.isArray(status?.fleet?.accounts) ? status.fleet.accounts : [];
  const workerRole = Array.isArray(status?.fleet?.roles) ? status.fleet.roles.find((r: any) => r?.role === 'worker') : null;
  const workerNames: string[] = Array.isArray(workerRole?.accounts) ? workerRole.accounts : [];
  const candidates = workerNames.length > 0
    ? workerNames.map(name => accounts.find(a => a?.name === name)).filter(Boolean)
    : accounts;
  const evaluated = candidates.map(evaluateBuilder);
  const builder = evaluated.find(entry => entry.passed)
    ?? evaluated.find(entry => entry.error !== null)
    ?? evaluated[0]
    ?? null;
  const step2Done = !!builder?.passed;

  const openTasks = work.filter(item => !isClosed(item) && item.stage !== 'done');
  const activeTask = openTasks.at(-1) ?? null;
  const step3Done = step1Done && step2Done && !!activeTask;
  const currentStep: 1 | 2 | 3 | 4 = !step1Done ? 1 : !step2Done ? 2 : !activeTask ? 3 : 4;

  return { currentStep, repository, fetchRefusal, step1Done, builder, step2Done, activeTask, step3Done };
}

/** An open issue as the loop reads it with `gh issue list` (GY-3709). */
export interface FirstRunIssue { number: number; title: string; body: string; labels: string[]; url: string }

/** Up to three issues for a first task: those labelled small first, then the shortest bodies. */
export function smallIssues(issues: readonly FirstRunIssue[]): FirstRunIssue[] {
  const small = (issue: FirstRunIssue) => issue.labels.some(label => /small|good first issue/i.test(label));
  return [...issues].sort((a, b) => Number(small(b)) - Number(small(a)) || a.body.length - b.body.length || a.number - b.number).slice(0, 3);
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'change';

/** The create input for the first task, drafted from an issue or a typed change, with one E2E-proof criterion. */
export function firstTaskInput(source: FirstRunIssue | string) {
  const typed = typeof source === 'string';
  const title = (typed ? source.trim().split('\n')[0]! : source.title).trim().slice(0, 200);
  const name = typed ? `first-task-${slug(title)}` : `issue-${source.number}-${slug(title)}`;
  return {
    type: 'feature' as const,
    title,
    why: (typed ? `The owner asked for it on the first run: ${title}` : `Issue #${source.number} asks for it: ${title}`).slice(0, 300),
    simplest: (typed ? 'The smallest change that does what the owner asked.' : `The smallest change that closes issue #${source.number}.`),
    description: (typed ? source.trim() : `${source.url}\n\n${source.body}`).slice(0, 20_000),
    criteria: [{ id: 'AC-1', text: `${title}: shown working in the running app by e2e/cases/${name}.json`, proofs: [`e2e:${name}`] }],
  };
}
