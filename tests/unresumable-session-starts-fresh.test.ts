import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { startHeadlessWorker } from '../src/headless-session.js';
import { clearRuns } from '../src/runner/registry.js';
import { supervise } from '../src/session-watch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-4018: a rework that continues its Builder's codex session on a machine without that
// conversation exited with "no rollout found for thread id", burning an attempt. The supervisor now
// starts the same attempt fresh with the usual prompt, under the same lease, and the run log says so.
// Any other resume failure still ends the attempt.

const proof = 'integration:unresumable-session-starts-fresh';
const path = process.env.PATH;
after(() => { clearRuns(); process.env.PATH = path; });

/** A stand-in codex: its resume prints ERROR and exits 1; a fresh run records its prompt and exits 0. */
const standIn = (error: string) => `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--help')) process.exit(0);
if (args.includes('resume')) { console.error(${JSON.stringify(error)}); process.exit(1); }
require('fs').writeFileSync(process.env.FRESH_PROMPT_FILE, args.at(-1));
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fresh-thread' }));
`;

async function run(label: string, error: string) {
  const base = await temporaryDirectory(label);
  await mkdir(join(base, 'bin'));
  await mkdir(join(base, 'worktree'));
  await mkdir(join(base, 'codex-home'));
  await writeFile(join(base, 'bin', 'codex'), standIn(error), { mode: 0o755 });
  const promptFile = join(base, 'fresh-prompt');
  // `mainworks watch` runs in the run's environment; the supervisor hands its own to the runtime.
  process.env.FRESH_PROMPT_FILE = promptFile;
  process.env.PATH = `${join(base, 'bin')}:${path}`;
  const surrendered: string[] = [];
  let log = '';
  // The exec runs the supervisor `mainworks watch` runs, against a lease that always renews.
  const renew = async () => ({ updatedAt: new Date().toISOString(), lease: { epoch: 1, expiresAt: new Date(Date.now() + 120_000).toISOString() } });
  const { id } = await startHeadlessWorker({ name: 'builder', work: 'GY-1', subject: 'GY-1: widgets', epoch: 1, principal: 'worker', account: null, kind: 'codex', args: [],
    environment: { PATH: `${join(base, 'bin')}:${process.env.PATH}`, CODEX_HOME: join(base, 'codex-home') }, directory: join(base, 'worktree'), supervisor: [],
    prompt: 'trial failed: fix the widget count', session: 'thread-on-another-machine', freshPrompt: 'Implement GY-1 from the start.', root: base, timeoutMs: 60_000, startupMs: 30_000,
    exec: async (command, args, options) => {
      log = String(options.env.GRAPHYARD_RUN_LOG);
      const code = await supervise(command, args, 1, renew, { log, detached: true, graceMs: 50, session: { surrender: async cause => { surrendered.push(cause); } } });
      if (code) throw new Error(`exited with code ${code}`);
      return '';
    } });
  const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line).text as string);
  return { id, lines, prompt: await readFile(promptFile, 'utf8').catch(() => null), surrendered };
}

test(`${proof} — a codex resume that finds no rollout starts the same attempt fresh with the usual prompt, and the run log says so`, { timeout: 60_000 }, async () => {
  const result = await run('unresumable-fresh', 'Error: thread/resume: thread/resume failed: no rollout found for thread id thread-on-another-machine (code -32600)');
  assert.ok(result.lines.some(line => /no rollout found/.test(line)), 'the resume was tried');
  assert.ok(result.lines.some(line => /could not be resumed; starting a fresh session/.test(line)), `the run log says the session started fresh: ${result.lines.join('\n')}`);
  assert.match(result.prompt ?? '', /Implement GY-1 from the start\./, 'the fresh session got the usual prompt');
  assert.ok(result.lines.some(line => /fresh-thread/.test(line)), 'the fresh session ran under the same supervisor');
});

test(`${proof} — any other resume failure ends the attempt as before`, { timeout: 60_000 }, async () => {
  const result = await run('unresumable-other', 'Error: the model is overloaded');
  assert.equal(result.prompt, null, 'no fresh session started');
  assert.ok(!result.lines.some(line => /starting a fresh session/.test(line)));
  assert.ok(result.surrendered.some(cause => /code 1/.test(cause)), 'the lease was released naming the exit');
});
