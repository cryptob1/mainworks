// Real loop child process for GY-3986 integration test: runs `runCycle` with detached trial runs
// and optionally hangs the merge writer step forever once the detached trial is running in `tests`.
import { spawn } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runCycle } from '../../src/daemon/cycle.js';
import type { DaemonEffects } from '../../src/daemon/effects.js';
import { emptyDaemonState } from '../../src/daemon/state.js';
import { masterConfigSchema } from '../../src/master/profiles.js';
import { adoptTrialRun, launchTrialRun, stopTrialRun, trialRunsDirectory } from '../../src/merge-writer/trial-run.js';
import { exitWhenStopped } from '../../src/master/loop-restart.js';
import { loopReads, storeSnapshot } from './pipeline-world.js';

const where = JSON.parse(process.argv[2]!);
const { snapshot } = storeSnapshot(where.database);
const config = masterConfigSchema.parse({
  version: 1, url: where.url, credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
  workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } },
});
let state = emptyDaemonState(config);
try { state = JSON.parse(await readFile(where.cursor, 'utf8')); } catch {}

const reads = loopReads({ ...where, snapshot }, { gate: false });
reads.adoptTrialRun = adoptTrialRun;
reads.stopTrialRun = stopTrialRun;
reads.launchTrialRun = request => launchTrialRun({
  runsRoot: trialRunsDirectory(where.checkout),
  spec: { version: 1, ...request, root: where.checkout, base: where.trials, hidden: [], startedAt: new Date().toISOString() },
  spawn: ((file: string, args: string[], options: object) => {
    const index = args.findIndex(arg => arg.endsWith('/trial-main.ts'));
    const replaced = [...args];
    replaced.splice(index, 1, fileURLToPath(new URL('./trial-restart-process.ts', import.meta.url)), 'trial');
    return spawn(file, replaced, options);
  }) as typeof spawn,
});
if (where.hangMergeAfterTrialStart) {
  reads.memory = async () => {
    if (state.mergeWriter.inFlight?.step === 'tests') return await new Promise<never>(() => {});
    return null;
  };
}

let writing = Promise.resolve();
const persist = () => {
  const text = JSON.stringify(state);
  writing = writing.then(async () => {
    await writeFile(where.cursor + '.tmp', text);
    await rename(where.cursor + '.tmp', where.cursor);
  });
  return writing;
};

const effects: DaemonEffects = {
  snapshot: async () => ({ work: await snapshot(), now: new Date().toISOString() }),
  agents: () => [], herdr: () => ({ agents: [], available: true }),
  credentials: async () => ({}),
  closeSession: () => {},
  dispatch: async () => {},
  mergeWriter: reads,
  persist,
};

const stopping = exitWhenStopped(process, { graceMs: 10, boundMs: 1000 });
let stopped = false;
process.once('SIGTERM', () => { stopped = true; void writing.then(() => stopping.stopped()); });

while (!stopped) {
  await (runCycle as (...args: unknown[]) => Promise<unknown>)(
    config, state, effects, Date.now, undefined, (line: string) => console.error(line), undefined, where.stuckBoundMs,
  );
  await delay(100);
}
