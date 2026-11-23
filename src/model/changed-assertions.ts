// GY-3635: extract removed or modified assertion lines in existing tests and E2E cases, and
// require an explicit per-line ruling (kept meaning, or weakened) before a review can approve.
import { isE2eCasePath, isTestFilePath, isTestHelperPath } from './risk-class.js';

export interface ChangedAssertion {
  path: string;
  line: number;
  before: string;
  after?: string;
}

const unquoted = (path: string): string =>
  /^".*"$/.test(path) ? (() => { try { return JSON.parse(path) as string; } catch { return path; } })() : path;

const testAssertionPattern = /\b(?:assert(?:\.[A-Za-z_]\w*|\s*\(|\s+\S)|expect\s*\(|should\.[A-Za-z_]\w*|require\.[A-Za-z_]\w*|t\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\()/;
const e2eAssertionPattern = /"(?:expect|equals|notEquals|status|contains|notContains|matches|run|required|assert|exists|count|visible|text|min|max)"\s*:/;

function isAssertionLine(path: string, line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) return false;
  if (isE2eCasePath(path)) return e2eAssertionPattern.test(trimmed);
  return testAssertionPattern.test(trimmed);
}

const isCheckFile = (path: string | null) => !!path && (isTestFilePath(path) || isTestHelperPath(path) || isE2eCasePath(path));

/**
 * Parses a unified git diff and returns every removed or modified assertion line in existing
 * test files and E2E cases (newly added files with `--- /dev/null` are skipped).
 */
export function extractChangedAssertions(diff: string): ChangedAssertion[] {
  const results: ChangedAssertion[] = [];
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let oldLine = 0;
  let removed: Array<{ line: number; text: string }> = [];
  let added: string[] = [];

  const flush = () => {
    if (!removed.length) { added = []; return; }
    const targetPath = newPath ?? oldPath;
    if (oldPath !== null && targetPath && (isCheckFile(oldPath) || isCheckFile(newPath))) {
      const addedTrimmed = new Set(added.map(line => line.trim()));
      removed.forEach((entry, index) => {
        const before = entry.text.trim();
        if (!isAssertionLine(targetPath, before)) return;
        // Pure re-indentation or move within the same hunk with identical trimmed text is not modified.
        if (addedTrimmed.has(before)) return;
        const replacement = added[index]?.trim();
        results.push({
          path: targetPath,
          line: entry.line,
          before: before.slice(0, 500),
          ...(replacement ? { after: replacement.slice(0, 500) } : {}),
        });
      });
    }
    removed = [];
    added = [];
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      oldPath = null;
      newPath = null;
      oldLine = 0;
      continue;
    }
    if (line.startsWith('--- ')) {
      const raw = line.slice(4);
      oldPath = raw === '/dev/null' ? null : unquoted(raw.startsWith('a/') ? raw.slice(2) : raw);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4);
      newPath = raw === '/dev/null' ? null : unquoted(raw.startsWith('b/') ? raw.slice(2) : raw);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      flush();
      oldLine = Number(hunk[1]!);
      continue;
    }
    if (oldLine === 0) continue;
    if (line.startsWith('-')) {
      if (added.length) flush();
      removed.push({ line: oldLine, text: line.slice(1) });
      oldLine++;
    } else if (line.startsWith('+')) {
      added.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      flush();
      oldLine++;
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
    }
  }
  flush();
  return results;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Validates that an APPROVE review body rules on every changed assertion line as "kept meaning"
 * and rules none as "weakened". Returns null when valid, or a one-line refusal reason.
 */
export function validateAssertionRulings(body: string, assertions: readonly ChangedAssertion[]): string | null {
  if (!assertions.length) return null;
  const lines = body.split('\n');
  const unruled: string[] = [];
  const weakened: string[] = [];
  for (const assertion of assertions) {
    const ref = `${assertion.path}:${assertion.line}`;
    const refPattern = new RegExp(`(?:^|[^\\w./-])${escapeRegex(ref)}(?:$|[^\\d])`);
    const matching = lines.filter(line => refPattern.test(line));
    const hasKept = matching.some(line => /\bkept\s+meaning\b/i.test(line));
    const hasWeakened = matching.some(line => /\bweakened\b/i.test(line));
    if (hasWeakened) weakened.push(ref);
    else if (!hasKept) unruled.push(ref);
  }
  if (weakened.length) {
    return `Cannot APPROVE: changed assertion${weakened.length === 1 ? '' : 's'} ruled weakened (${weakened.join(', ')}); post REQUEST_CHANGES with a BLOCKING finding instead`;
  }
  if (unruled.length) {
    return `Cannot APPROVE: rule on every changed assertion line as "PATH:LINE — kept meaning" or "PATH:LINE — weakened" before approving; missing rulings for ${unruled.join(', ')}`;
  }
  return null;
}
