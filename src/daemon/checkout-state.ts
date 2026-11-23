// Concern: GY-1773 — how the coordinator checkout stands (commit, HEAD, dirty paths), read from git.
// GY-1899 — which checkout that is: the one the running CLI comes from, never the managed repository's root.
// GY-2018 — under the test runner the checkout the suite itself runs from is never a judged one, wherever it stands.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkoutGuardApplies, coordinatorCheckoutRoot } from '../master/profiles.js';
import { underTestRunner } from '../runtime-environment.js';
/**
 * The checkout this process's own running code comes from: the directory above this tree's `src/`.
 * Under the test runner that is the suite's checkout, and GY-2018 keeps it out of every code-root
 * reading, wherever the suite stands.
 */
function runningCheckoutRoot(): string {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  try { return realpathSync(root); } catch { return resolve(root); }
}
/** Whether two paths name one directory, compared as the filesystem resolves them. */
const sameCheckout = (left: string, right: string) => {
  const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  return real(left) === real(right);
};
/**
 * The checkout the loop's loaded code comes from and its self-upgrade acts on: the one the running
 * CLI comes from — the directory above the configured launcher's `bin/` — never the managed
 * repository's root, whose HEAD names the managed project, not the code this process loaded (GY-1899).
 * For Graphyard's own install the two are one directory and nothing changes; a loop configured with
 * no CLI launcher could only ever have loaded the repository root, so that stands in. Under the test
 * runner only a checkout under the temporary directories is judged (`checkoutGuardApplies`, the
 * guard's own gate): a launcher a test passes from the checkout the suite itself runs from never
 * moves a test's upgrade off the root the test injected. That gate alone no longer holds the suite
 * out (GY-2018): the merge writer's trial runs this suite from a checkout under a temporary
 * directory, which the gate judged, so every fixture config's launcher — the bare `graphyard` one,
 * whose double dirname is the process's working directory — resolved to the suite's own tree and
 * eight proofs failed on the base tip itself. Wherever the suite stands, its own checkout is never
 * a judged one; `suite` names it so a test can hold a trial-shaped checkout to the same rule.
 */
export function loopCodeRoot(cliPath: string | null | undefined, repositoryRoot: string, suite: string | null = runningCheckoutRoot()): string {
  if (typeof cliPath !== 'string' || cliPath.length === 0) return repositoryRoot;
  const checkout = coordinatorCheckoutRoot(cliPath);
  // In production the guard does not apply and the CLI checkout stands (GY-1899); the suite's own
  // checkout is refused only under the test runner, which is the only place it is a gate.
  if (checkoutGuardApplies(checkout) && !(underTestRunner() && suite !== null && sameCheckout(checkout, suite))) return checkout;
  return repositoryRoot;
}
