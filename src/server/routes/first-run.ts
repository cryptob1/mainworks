import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { demand } from '../../model.js';
import { selectSmallIssues, type RawOpenIssue } from '../../model/first-run.js';
import { defineRoutes } from '../routes.js';

const execFileAsync = promisify(execFile);
const readers = ['admin', 'coordinator', 'reader', 'slice-lead'] as const;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Read open issues from GitHub for `repository` via `gh api`. Returns an empty list on any
 * error (unauthenticated, offline, or non-GitHub repo) so first-run step 3 falls back cleanly
 * to the free-text box.
 */
async function readGitHubOpenIssues(repository: string): Promise<RawOpenIssue[]> {
  if (!repoPattern.test(repository)) return [];
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `repos/${repository}/issues?state=open&per_page=30`],
      { timeout: 8_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * First-run helper route (GY-3603): lists up to three small open issues for Step 3 of the
 * first-run page. No other new backend is needed; steps 1, 2, 3 and 4 use existing status,
 * agent-registry, work create/ready, and task evidence routes.
 */
export const firstRunRoutes = defineRoutes('first-run', [
  {
    method: 'GET',
    path: '/api/first-run/issues',
    async handle({ actor, services }) {
      demand((readers as readonly string[]).includes(actor.role), 'First-run issues are readable by admin, coordinator, slice-lead and reader identities', 403);
      const repository = services.repository?.trim();
      if (!repository) return { issues: [] };
      const raw = services.listOpenIssues
        ? await services.listOpenIssues(repository)
        : await readGitHubOpenIssues(repository);
      return { issues: selectSmallIssues(raw) };
    },
  },
]);
