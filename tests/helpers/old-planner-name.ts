import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// GY-4024: the planner is the Lead. Help's sources keep `master` only in command and unit names.
const helpSources = ['web/pages/guide.tsx', 'src/guide/setup.ts', 'src/guide/infra.ts'];
const plannerAsMaster = String.raw`\b(?:[Tt]he|[Aa]n?|[Ii]ts|[Tt]heir|[Yy]our)\s+[Mm]aster\b(?![-./])|(?<![-./\w])Master\b(?![-./])`;

/** Each `PATH:LINE: words` where Help's sources call the planner the Master. */
export function oldPlannerNameLines(root = fileURLToPath(new URL('../..', import.meta.url))): string[] {
  try {
    return execFileSync('git', ['grep', '-n', '-o', '-P', plannerAsMaster, '--', ...helpSources], { cwd: root, encoding: 'utf8' })
      .split('\n').filter(Boolean).map(line => line.replace(/^([^:]*:\d+):/, '$1: '));
  } catch (error: any) { if (error.status === 1) return []; throw error; }
}
