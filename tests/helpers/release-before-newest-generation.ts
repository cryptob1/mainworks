import { execFileSync } from 'node:child_process';
import { schemaAt } from '../../src/cli/upgrade.js';

const lineage = 'src/store/schema-lineage.ts';

/**
 * GY-3960: the revision just before `newer`'s newest schema generation was appended: the parent of the
 * newest commit touching the lineage whose parent is one generation older. A later commit that rewrites
 * that generation in place (GY-3942's second round did) leaves the generation count alone and is passed over.
 */
export function releaseBeforeNewestGeneration(repo: string, newer: string): string {
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const generation = (revision: string) => { try { return schemaAt(git('show', `${revision}:${lineage}`)); } catch { return null; } };
  const newest = generation(newer);
  if (newest === null) throw new Error(`${newer} has no ${lineage}`);
  for (const commit of git('log', '--format=%H', newer, '--', lineage).split('\n').filter(Boolean)) {
    if (generation(`${commit}^`) === newest - 1) return git('rev-parse', `${commit}^`);
  }
  throw new Error(`no revision before ${newer} holds generation ${newest - 1}`);
}
