// Concern: GY-3599 — where an item's merge trial spent its time, folded from the merge ledger's own rows for the Task page. Pure.
import { mergeLedgerKinds, mergeTrialKind, mergeTrialStepKind } from './merge-ledger.js';

export interface TrialTimings {
  head: string; startedAt: string; /** Null while the trial runs. */ finishedAt: string | null; durationMs: number;
  steps: { step: string; durationMs: number; result: 'passed' | 'failed' | 'running' }[];
  /**
   * Counts per test group. A verdict's are final; while the trial runs, and when it ended without a
   * verdict, the tests' are those of the shards that have ended so far (`soFar`), so `passed` and `failed` need not add up to `total`.
   */
  groups: { name: string; passed: number; failed: number; total: number }[];
  slowest: { file: string; durationMs: number } | null;
  /** The tests' counts and the slowest file are those of the shards that have ended so far, not a verdict's. */
  soFar: boolean;
  /** What a running trial printed so far: the newest step report with output, sent as test shards end; null once it reaches a verdict. */
  output: string | null;
}
interface LedgerRow { kind: string; payload: any; created_at: string | Date }

/** The newest trial of an item, from its ledger rows oldest first: each step's time, each test group's counts and the slowest test file. */
export function trialTimings(rows: readonly LedgerRow[], now: number): TrialTimings | null {
  const from = rows.findLastIndex(row => row.kind === mergeLedgerKinds.intent);
  if (from < 0) return null;
  const intent = rows[from]!.payload, own = rows.slice(from + 1).filter(row => row.payload?.head === intent.head);
  // A step sent again under its own start carries what the trial has to say so far: it is one step.
  const reports = own.filter(row => row.kind === mergeTrialStepKind);
  const started = reports.filter((row, index) => index === 0 || row.payload.step !== reports[index - 1]!.payload.step || row.payload.at !== reports[index - 1]!.payload.at)
    .map(row => ({ step: String(row.payload.step), at: Date.parse(row.payload.at) }));
  const ended = own.findLast(row => row.kind === mergeTrialKind), trial = ended?.payload, finished = ended ? new Date(ended.created_at).getTime() : null;
  const failed = (step: string, last: boolean) => !trial ? false : trial.outcome !== 'verdict' ? last
    : step === 'build' ? trial.build === 'fail' : step === 'tests' ? trial.tests.failed.length > 0
      : step === 'tests: e2e' && (trial.e2e ?? []).some((entry: any) => entry.failed > 0 || entry.missing);
  const steps = started.map(({ step, at }, index) => {
    const last = index === started.length - 1;
    return { step, durationMs: Math.max(0, (last ? finished ?? now : started[index + 1]!.at) - at), result: last && !trial ? 'running' as const : failed(step, last) ? 'failed' as const : 'passed' as const };
  });
  const verdict = trial?.outcome === 'verdict';
  // The tests' counts: the verdict's once there is one, else the newest shard-end report's.
  const counts = verdict ? { passed: trial.tests.passed, failed: trial.tests.failed.length, files: trial.tests.files, slowest: trial.tests.slowest }
    : reports.findLast(row => row.payload.tests)?.payload.tests;
  const e2e: { executed: number; failed: number; missing?: boolean }[] = verdict ? trial.e2e ?? [] : [];
  const passedCase = (entry: { executed: number; failed: number; missing?: boolean }) => entry.executed > 0 && entry.failed === 0 && !entry.missing;
  return { head: intent.head, startedAt: intent.at, finishedAt: finished === null ? null : new Date(finished).toISOString(), durationMs: Math.max(0, (finished ?? now) - Date.parse(intent.at)), steps,
    groups: [...(counts?.files ? [{ name: 'tests', passed: counts.passed, failed: counts.failed, total: counts.files }] : []),
      ...(e2e.length ? [{ name: 'e2e', passed: e2e.filter(passedCase).length, failed: e2e.filter(entry => !passedCase(entry)).length, total: e2e.length }] : [])],
    slowest: counts?.slowest ?? null, soFar: !verdict && !!counts, output: ended ? null : reports.findLast(row => row.payload.output)?.payload.output ?? null };
}
