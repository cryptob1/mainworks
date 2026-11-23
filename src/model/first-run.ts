import { isClosed } from './closure.js';
import type { Work } from './work.js';

/**
 * First-run onboarding state (GY-3603): an install with no merged work opens on the four-step
 * first-run page instead of an empty Home, driven by the existing setup checks, fleet live-request
 * status, small open issues, and task creation/dispatch.
 */

/** Whether this install has at least one merged work item. */
export const hasMergedWork = (work: readonly Pick<Work, 'stage' | 'delivery' | 'observation'>[]): boolean =>
  work.some(item => item.stage === 'done' && !!(item.delivery?.mergedAt ?? item.observation?.mergedAt));

export interface RawOpenIssue {
  number: number;
  title: string;
  body?: string | null;
  labels?: readonly (string | { name?: string })[];
  state?: string;
  pull_request?: unknown;
  html_url?: string | null;
  url?: string | null;
}

export interface SmallIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url: string | null;
}

const SMALL_LABEL = /^(small|good first issue|starter|quick[- ]?win|size[:/\s-]*(xs|s|small))$/i;

const labelNames = (labels: RawOpenIssue['labels']): string[] =>
  (labels ?? []).map(label => (typeof label === 'string' ? label : label?.name ?? '').trim()).filter(Boolean);

/**
 * Pick up to three open issues (excluding pull requests): prefer issues labelled as small;
 * when none are labelled small, fall back to the three with the shortest bodies.
 */
export function selectSmallIssues(raw: readonly RawOpenIssue[]): SmallIssue[] {
  const open = raw
    .filter(issue => !issue.pull_request && (!issue.state || issue.state.toLowerCase() === 'open') && Number.isInteger(issue.number) && typeof issue.title === 'string' && issue.title.trim().length > 0)
    .map((issue): SmallIssue => ({
      number: issue.number,
      title: issue.title.trim(),
      body: typeof issue.body === 'string' ? issue.body.trim() : '',
      labels: labelNames(issue.labels),
      url: typeof issue.html_url === 'string' ? issue.html_url : typeof issue.url === 'string' ? issue.url : null,
    }));
  const small = open.filter(issue => issue.labels.some(name => SMALL_LABEL.test(name)));
  const pool = small.length > 0 ? small : open;
  return [...pool]
    .sort((a, b) => a.body.length - b.body.length || a.number - b.number)
    .slice(0, 3);
}

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
    && smoke?.result === 'pass';
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
 * Step 2 passes only after a live request (`smoke.result === 'pass'`) answers on a registered model id.
 */
export function firstRunState(status: any, work: readonly Work[], startedId?: string | null): FirstRunState {
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
  const activeTask = (startedId ? openTasks.find(item => item.id === startedId) : null) ?? openTasks.at(-1) ?? null;
  const step3Done = step1Done && step2Done && !!activeTask;
  const currentStep: 1 | 2 | 3 | 4 = !step1Done ? 1 : !step2Done ? 2 : !activeTask ? 3 : 4;

  return { currentStep, repository, fetchRefusal, step1Done, builder, step2Done, activeTask, step3Done };
}

const slugify = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'first-run-change';

/**
 * Draft the POST /api/work body for a first-run change from either a repository issue or a
 * one-line free-text description, always carrying `why`, `simplest`, and an `e2e:` proof criterion.
 */
export function draftFirstRunTask(pick: { issue: SmallIssue } | { text: string }) {
  if ('issue' in pick) {
    const { issue } = pick;
    const title = issue.title.slice(0, 200);
    const description = issue.body
      ? `Issue #${issue.number}: ${issue.title}\n\n${issue.body}`
      : `Issue #${issue.number}: ${issue.title}`;
    return {
      title,
      why: `Resolves issue #${issue.number}: ${issue.title}`.slice(0, 300),
      simplest: 'Make the smallest self-contained change that resolves this issue and proves it with an E2E test.',
      description: description.slice(0, 20000),
      criteria: [{
        id: 'AC-1',
        text: `Issue #${issue.number} (${issue.title}) is fixed and verified end to end.`.slice(0, 2000),
        proofs: [`e2e:issue-${issue.number}`],
      }],
      policy: { review: true, checks: ['test', 'typecheck'] },
    };
  }
  const text = pick.text.trim();
  const title = text.slice(0, 200);
  return {
    title,
    why: `Delivers the requested first-run change: ${text}`.slice(0, 300),
    simplest: 'Make the smallest self-contained change that satisfies this request and proves it with an E2E test.',
    description: text.slice(0, 20000),
    criteria: [{
      id: 'AC-1',
      text: `The change works end to end: ${text}`.slice(0, 2000),
      proofs: [`e2e:${slugify(text)}`],
    }],
    policy: { review: true, checks: ['test', 'typecheck'] },
  };
}
