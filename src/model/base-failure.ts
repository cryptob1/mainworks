

// A CI log line may start with its timestamp; a terminal log may carry colour codes.
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
// eslint-disable-next-line no-control-regex
const ansi = /\u001b\[[0-9;]*m/g;
/**
 * The failing test names a Node test-runner log reports, in either of its reporters: the spec
 * reporter's `✖ name (12.3ms)` and TAP's `not ok 3 - name`. A suite that failed because a test in
 * it did is listed too, as the runner lists it; both sides of a comparison are read the same way,
 * so that is no difference between them. TODO and SKIP entries are not failures.
 */
export function parseFailedTests(log: string): string[] {
  const names = new Set<string>();
  for (const raw of log.split('\n')) {
    const line = raw.replace(timestamp, '').replace(ansi, '').trimEnd();
    const spec = /^\s*✖ (.+?) \(\d+(?:\.\d+)?m?s\)(?:\s+#.*)?$/.exec(line);
    const tap = /^\s*not ok \d+ - (.+?)(\s+#\s+(?:TODO|SKIP)\b.*)?$/i.exec(line);
    const name = spec?.[1] ?? (tap && !tap[2] ? tap[1] : null);
    if (name && name.length <= 500) names.add(name.trim());
  }
  return [...names].sort();
}

