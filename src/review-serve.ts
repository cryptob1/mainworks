// Concern: GY-3662 — a product review's served head, detached from the loop's process (its own
// session and, under systemd, its own transient scope, like detached trial runs in
// merge-writer/trial-run.ts) so a loop restart during a deploy never kills a review's app in
// flight. The serve directory records its process meta on disk; whichever loop settles or closes
// the review session stops it.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { detachedLaunch, processIdentity, readRunMeta, runAlive, runContainment, runFiles, signalRun, type RunContainment, type RunMeta } from './runner/pi.js';
import type { E2eServe } from './model/repository-policy.js';
import { ServeCommandError, serveTailLines } from './merge-writer/serve-head.js';

/** Where detached product-review serves keep their process meta and logs, beside headless-runs and trial-runs. */
export const reviewServesDirectory = (root: string) => resolve(root, '.graphyard', 'review-serves');

/** Self-bound watchdog for a detached review serve: well past the 1-hour review token so no live review is cut short, while bounding any abandoned serve. */
export const reviewServeBoundSeconds = 90 * 60;

const stopGraceMs = 5_000;

/**
 * Starts a product review's `e2e.serve` command detached from this loop process (its own session
 * and, under systemd, its own transient scope) and waits until `serve.url` answers HTTP 2xx.
 * Records `run.json` in `<root>/.graphyard/review-serves/<id>` so a restarted loop can stop it
 * when the adopted review session ends.
 */
export async function startReviewServe(input: {
  root: string;
  id: string;
  worktree: string;
  serve: E2eServe;
  env: Record<string, string>;
  containment?: RunContainment;
  spawn?: typeof spawn;
  log?: (line: string) => void;
}): Promise<{ url: string; directory: string }> {
  const { serve } = input;
  const startedAt = Date.now(), deadline = startedAt + serve.readySeconds * 1000;
  // An endpoint that answers before the command starts is another application's: its answers would not be the head's.
  const occupied = await fetch(serve.url, { signal: AbortSignal.timeout(2_000) }).then(() => true, () => false);
  if (occupied) throw new Error(`${serve.url} already answers before the serve command starts; another application holds it, so the head cannot be served there`);

  const directory = join(reviewServesDirectory(input.root), input.id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const containment = input.containment ?? runContainment({ log: input.log });
  const unitId = `review-serve-${input.id}`;
  const launch = detachedLaunch(directory, unitId, 'sh', ['-c', serve.command], containment, [], reviewServeBoundSeconds);

  let spawnError: string | null = null;
  const child = (input.spawn ?? spawn)(launch.file, launch.args, { cwd: input.worktree, env: input.env, detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  child.on('error', error => { spawnError = `${launch.file} could not be started: ${error.message}`; });
  child.unref();

  const meta: RunMeta = {
    version: 1,
    id: unitId,
    command: serve.command.slice(0, 4000),
    pid: child.pid ?? null,
    identity: child.pid ? processIdentity(child.pid) : null,
    containment,
    unit: launch.unit,
    startedAt: new Date(startedAt).toISOString(),
    timeoutMs: reviewServeBoundSeconds * 1000,
    exitGraceMs: 0,
  };
  writeFileSync(runFiles(directory).meta, JSON.stringify(meta), { mode: 0o600 });

  const readOutput = () => {
    const files = runFiles(directory);
    const text = [files.stdout, files.stderr].map(file => { try { return readFileSync(file, 'utf8'); } catch { return ''; } }).join('\n').trimEnd();
    return text ? text.split('\n').slice(-serveTailLines) : [];
  };
  const readExit = () => { try { return readFileSync(runFiles(directory).exit, 'utf8').trim(); } catch { return null; } };
  const fail = async (reason: string): Promise<never> => {
    const output = readOutput();
    await stopReviewServe(directory);
    throw new ServeCommandError(reason, output, startedAt, Date.now());
  };

  for (;;) {
    if (spawnError) await fail(spawnError);
    const exit = readExit();
    if (exit !== null) await fail(`the serve command ended (status ${exit}): ${readOutput().slice(-5).join(' | ').slice(0, 500)}`);
    if (meta.pid && !runAlive(meta)) {
      const afterExit = readExit();
      await fail(`the serve command ended${afterExit !== null ? ` (status ${afterExit})` : ''}: ${readOutput().slice(-5).join(' | ').slice(0, 500)}`);
    }
    const answered = await fetch(serve.url, { signal: AbortSignal.timeout(2_000) }).then(response => response.ok, () => false);
    if (answered) return { url: new URL(serve.url).origin, directory };
    if (Date.now() >= deadline) await fail(`the serve command did not answer ${serve.url} within ${serve.readySeconds}s`);
    await new Promise(accept => setTimeout(accept, 200));
  }
}

/**
 * Stops a detached product-review serve from its directory (idempotent) and removes its directory.
 * Signals the serve's whole process group with SIGTERM, waits briefly for graceful exit, then SIGKILL.
 */
export async function stopReviewServe(directory: string): Promise<void> {
  const meta = readRunMeta(directory);
  if (meta && runAlive(meta)) {
    signalRun(meta, 'SIGTERM');
    const graceEnd = Date.now() + stopGraceMs;
    while (runAlive(meta) && Date.now() < graceEnd) await new Promise(accept => setTimeout(accept, 50));
    if (runAlive(meta)) {
      signalRun(meta, 'SIGKILL');
      const killEnd = Date.now() + 2_000;
      while (runAlive(meta) && Date.now() < killEnd) await new Promise(accept => setTimeout(accept, 50));
    }
  }
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
