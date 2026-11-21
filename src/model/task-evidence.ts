// Concern: GY-3599 — where an item's merge trial spent its time, folded from the merge ledger's own rows for the Task page. Pure.
import { mergeLedgerKinds, mergeTrialKind, mergeTrialStepKind } from './merge-ledger.js';

export interface TrialTimings {
  head: string; startedAt: string; /** Null while the trial runs. */ finishedAt: string | null; durationMs: number;
  steps: { step: string; durationMs: number; result: 'passed' | 'failed' | 'running' }[];
  /** Counts per test group, known once the trial reached a verdict. */
  groups: { name: string; passed: number; total: number }[];
  slowest: { file: string; durationMs: number } | null;
}
interface LedgerRow { kind: string; payload: any; created_at: string | Date }

/** The newest trial of an item, from its ledger rows oldest first: each step's time, each test group's counts and the slowest test file. */
export function trialTimings(rows: readonly LedgerRow[], now: number): TrialTimings | null {
  const from = rows.findLastIndex(row => row.kind === mergeLedgerKinds.intent);
  if (from < 0) return null;
  const intent = rows[from]!.payload, own = rows.slice(from + 1).filter(row => row.payload?.head === intent.head);
  const started = own.filter(row => row.kind === mergeTrialStepKind).map(row => ({ step: String(row.payload.step), at: Date.parse(row.payload.at) }));
  const ended = own.findLast(row => row.kind === mergeTrialKind), trial = ended?.payload, finished = ended ? new Date(ended.created_at).getTime() : null;
  const failed = (step: string, last: boolean) => !trial ? false : trial.outcome !== 'verdict' ? last
    : step === 'build' ? trial.build === 'fail' : step === 'tests' ? trial.tests.failed.length > 0
      : step === 'tests: e2e' && (trial.e2e ?? []).some((entry: any) => entry.failed > 0 || entry.missing);
  const steps = started.map(({ step, at }, index) => {
    const last = index === started.length - 1;
    return { step, durationMs: Math.max(0, (last ? finished ?? now : started[index + 1]!.at) - at), result: last && !trial ? 'running' as const : failed(step, last) ? 'failed' as const : 'passed' as const };
  });
  const e2e: { executed: number; failed: number; missing?: boolean }[] = trial?.e2e ?? [];
  return { head: intent.head, startedAt: intent.at, finishedAt: finished === null ? null : new Date(finished).toISOString(), durationMs: Math.max(0, (finished ?? now) - Date.parse(intent.at)), steps,
    groups: [...(trial?.tests?.files ? [{ name: 'tests', passed: trial.tests.passed, total: trial.tests.files }] : []),
      ...(e2e.length ? [{ name: 'e2e', passed: e2e.filter(entry => entry.executed > 0 && entry.failed === 0 && !entry.missing).length, total: e2e.length }] : [])],
    slowest: trial?.tests?.slowest ?? null };
}
