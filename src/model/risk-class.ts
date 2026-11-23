import type { RepositoryPolicy, CompiledRule } from './repository-policy.js';
import type { Work } from './work.js';
// ---- Risk class from the merge delta (GY-1521) ---------------------------------------------------

/**
 * The risk class of a change, judged from the files the merge would actually apply to the base
 * branch — the landing check's three-way result when it was computed against the live base tip —
 * naming, per file, the rule that made it sensitive. It is the one merge rule (model/gates.ts): a
 * sensitive delta waits for one independent approval before the merge writer merges it; any other
 * merges on its passing trial and is reviewed after the merge. It is computed on read and shown by
 * `graphyard status` and the item page.
 *
 * `sensitive` is whatever the repository's graphyard.json declares under `risk.sensitive`
 * (model/repository-policy.ts, GY-1843): each entry a glob and the rule a reason cites. A repository
 * that declares none gets the generic default — CI configuration, dependency manifests and
 * lockfiles, migrations, container, compose, deploy and infrastructure files, auth and secrets,
 * anywhere in the tree — never Graphyard's own layout, which Graphyard's graphyard.json declares for
 * itself. Everything else is `normal`. A delta nobody can see (no files at all) is sensitive: until
 * the class can see what a change touches, it is treated as the worst case.
 */
const riskClasses = ['sensitive', 'normal'] as const;
export type RiskClass = typeof riskClasses[number];

export const compiled = new WeakMap<RepositoryPolicy, CompiledRule[]>();

/** Whether a change of this class is reviewed before it merges: only a sensitive one; a normal change merges on its trial and owes one post-merge review (GY-1525). */
export const reviewedBeforeMerge = (risk: RiskClass) => risk === 'sensitive';

/** One file of a delta: its path and, for a rename, where it came from. */
export interface DeltaFile {
  path: string;
  previousPath?: string;
  status?: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions?: number;
  deletions?: number;
  baseSha?: string | null;
  previousBaseSha?: string | null;
  /** Whether a diff to graphyard.json touches its checks section (GY-3635). */
  checksChanged?: boolean;
}
export interface RiskVerdict { risk: RiskClass; reasons: string[] }

/** The reason for one sensitive path: the path and the rule it matched, so a reader can check both. */
export const sensitiveReason = (path: string, rule: string) => `${path}: ${rule}`;
/** The reason an unseen delta is sensitive. */
export const unknownChangeReason = 'unknown change';

/** GY-3635: paths whose edits can weaken the repository's own checks. */
const isTestSelectorPath = (path: string) => path === 'scripts/ci-tests.mjs';
export const isTestHelperPath = (path: string) => path.startsWith('tests/helpers/') && !path.includes('*');
export const isE2eCasePath = (path: string) => path.startsWith('e2e/cases/') && path.endsWith('.json');
export const isTestFilePath = (path: string) =>
  !isTestHelperPath(path) && (
    path.startsWith('tests/')
    || path.startsWith('browser-tests/')
    || /(?:^|\/)(?:tests?|__tests__|specs?)\//.test(path)
    || /\.(?:test|spec)\.[^/]+$/.test(path)
    || /_test\.[^/]+$/.test(path)
  );

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

/** Whether two versions of graphyard.json differ in their checks sections (delivery.mergeGate, checks, gate, risk, e2e). */
export function graphyardChecksChanged(baseText: string | null, headText: string | null): boolean {
  if (baseText === headText) return false;
  const parse = (text: string | null): Record<string, unknown> | null => {
    if (text === null) return {};
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  };
  const before = parse(baseText), after = parse(headText);
  if (!before || !after) return true;
  const section = (doc: Record<string, unknown>) => ({
    checks: doc.checks,
    mergeGate: (doc.delivery as Record<string, unknown> | undefined)?.mergeGate,
    gate: doc.gate,
    risk: doc.risk,
    e2e: doc.e2e,
  });
  return canonical(section(before)) !== canonical(section(after));
}

const existedOnBase = (file: DeltaFile) =>
  file.status === 'modified'
  || file.status === 'removed'
  || file.status === 'renamed'
  || file.status === 'changed'
  || (!!file.previousPath && file.previousPath !== file.path)
  || (typeof file.baseSha === 'string' && file.baseSha.length > 0)
  || (file.deletions ?? 0) > 0;

/**
 * GY-3635: reasons for files that modify or remove existing checks — existing test files, existing
 * e2e cases, scripts/ci-tests.mjs, tests/helpers/**, or graphyard.json's checks section.
 * Adding new test files or new e2e cases yields no reason.
 */
export function checkIntegrityReasons(files: readonly DeltaFile[]): string[] {
  const reasons: string[] = [];
  for (const file of files) {
    if (file.status === 'unchanged') continue;
    const ends = file.previousPath && file.previousPath !== file.path ? [file.path, file.previousPath] : [file.path];
    for (const path of ends) {
      if (isTestSelectorPath(path)) { reasons.push(sensitiveReason(path, 'test selector')); continue; }
      if (isTestHelperPath(path)) { reasons.push(sensitiveReason(path, 'test helper')); continue; }
      if (path === 'graphyard.json') {
        if (file.checksChanged === true || (file.checksChanged === undefined && existedOnBase(file))) {
          reasons.push(sensitiveReason(path, 'trial checks'));
        }
        continue;
      }
      if (isE2eCasePath(path) && existedOnBase(file)) { reasons.push(sensitiveReason(path, 'existing e2e case')); continue; }
      if (isTestFilePath(path) && existedOnBase(file)) { reasons.push(sensitiveReason(path, 'existing test')); }
    }
  }
  return [...new Set(reasons)];
}

/** Both ends of each file: a rename out of a sensitive tree is a change to that tree whatever its destination. */
export function deltaPaths(files: readonly DeltaFile[]): string[] {
  return [...new Set(files.flatMap(file => file.previousPath && file.previousPath !== file.path ? [file.path, file.previousPath] : [file.path]))];
}

declare module './work.js' {
  interface Work {
    /** GY-1521: the risk class of the delta the merge would apply, computed on read; never stamped by an evaluation. */
    risk?: RiskClass;
  }
}

/** What the delta was read from, so a reader knows which comparison the class judged. */
export type DeltaSource = 'landing' | 'scope' | 'files' | 'none';

/**
 * The delta an item's class is judged from: the landing check's files when that check compared
 * the current head against the live base tip (`observation.landing.base === observation.baseTip`),
 * else the candidate's scope files against its bound base, else the observation's plain file list.
 * No observation is no delta.
 */
export function riskDelta(work: Pick<Work, 'candidate' | 'observation'>): { files: DeltaFile[]; source: DeltaSource } {
  const obs = work.observation;
  if (!obs) return { files: [], source: 'none' };
  const currentHead = !work.candidate || obs.candidate.sha === work.candidate.sha;
  if (currentHead && obs.landing?.files && obs.baseTip && obs.landing.base === obs.baseTip) return { files: obs.landing.files, source: 'landing' };
  if (obs.scopeFiles) return { files: obs.scopeFiles, source: 'scope' };
  return { files: (obs.files ?? []).map(path => ({ path })), source: 'files' };
}
