import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workCommands } from '../src/cli/work.js';

// GY-3761: every history caller asks for `details` (the event's own details, not the work
// document it embeds) unless it needs the full payload and says so.
test('unit:event-history-callers-default-to-details — the CLI and dashboard history reads ask for details unless a full payload is requested', async () => {
  const events = workCommands.find(command => command.name === 'events')! as any;
  const paths: string[] = [];
  const api = async (path: string) => { paths.push(path); return { events: [], page: { nextCursor: null } }; };
  const print = () => {};
  await events.unscoped({ api, print, args: [] });
  await events.run({ api, print, args: [] }, { id: 'w1' });
  await events.run({ api, print, args: ['--payload', 'full'] }, { id: 'w1' });
  const payload = (path: string) => new URLSearchParams(path.split('?')[1] ?? '').get('payload');
  assert.deepEqual(paths.map(payload), ['details', 'details', 'full']);

  // Every other caller of /api/events names its payload: details or none for display, full only where it reads the work document.
  const callers: [string, RegExp][] = [
    ['web/main.tsx', /api\(`events\?[^`]*payload=details/],
    ['web/pages/master.tsx', /api\(`events\?[^`]*payload=details/],
    ['src/cli/master/loop.ts', /'events\?[^']*payload=none/],
    ['src/cli/master-status.ts', /`events\?[^`]*payload=full/],
    ['src/merge-admission-audit.ts', /payload: 'full'/],
  ];
  for (const [file, pattern] of callers) assert.match(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), pattern, file);
});
