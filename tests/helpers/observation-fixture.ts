import type { Candidate, Observation, Work } from '../../src/model/work.js';

/**
 * GY-3934: a valid merge Observation of an open, unreviewed pull request with no checks whose head
 * contains its bound base. Pass only what a test is about.
 */
export function observationFixture(candidate: Partial<Candidate> & { sha: string; baseSha: string }, overrides: Partial<Observation> = {}): Observation {
  return {
    candidate: { pr: 1, branch: 'graphyard/gy-1-1', author: 'implementer', ...candidate }, checks: [], reviews: [],
    merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(),
    prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: '7b'.padEnd(40, 'f'), baseTipContained: true, ...overrides,
  };
}

/** `item`'s submitted pull request observed at `sha` over `baseSha`, with test and typecheck passing. */
export function itemObservation(item: Work, sha: string, baseSha: string, overrides: Partial<Observation> = {}): Observation {
  return observationFixture({ sha, baseSha, pr: item.submission!.pr, branch: item.workspaces.at(-1)!.branch }, { clockOffset: { min: 0, max: 0 },
    checks: ['test', 'typecheck'].map((name) => ({ name, result: 'success', appId: 15368 })), files: ['src/loop.ts'], ...overrides });
}
