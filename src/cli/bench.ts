import { defineCommands } from './registry.js';

function flagValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  const prefix = `${flag}=`;
  const inline = args.find(arg => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
}

/** Checks whether the install's loop currently shows a queued or in-flight merge trial. */
async function hasQueuedTrial(root: string): Promise<boolean> {
  try {
    const [{ loadStoredMasterConfig }, { readDaemonState }] = await Promise.all([import('../master.js'), import('../daemon/state.js')]);
    const config = await loadStoredMasterConfig(root);
    const state = await readDaemonState(root, config);
    return (state.mergeWriter.queue?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

export const benchCommands = defineCommands([{
  name: 'bench',
  readsConnection: () => false,
  help: [
    '  bench trial [--files PATH] [--ref REF]     Run the fixed reference trial on main (or REF), print',
    '                                             one JSON result and append it to .graphyard/bench-results.jsonl',
    '  bench trial --compare REF [--files PATH]   Run the benchmark on REF and on main back to back and',
    '                                             print the per-step difference',
  ],
  async run(context) {
    if (context.id !== 'trial') {
      throw new Error('Usage: mainworks bench trial [--files PATH] [--ref REF] [--compare REF]');
    }
    const [{ checkoutRoot }, { benchTrial, compareBenchResults, formatBenchComparison }] = await Promise.all([import('./context.js'), import('../bench.js')]);
    const root = await checkoutRoot(context, 'bench trial');
    const filesPath = flagValue(context.args, '--files');
    const compareRef = flagValue(context.args, '--compare');
    const ref = flagValue(context.args, '--ref');
    const queued = await hasQueuedTrial(root);
    if (queued) {
      throw new Error('A change is queued for merge; retry once the queue is empty');
    }

    if (compareRef) {
      const candidate = await benchTrial({ root, ref: compareRef, filesPath, print: () => {} });
      const baseline = await benchTrial({ root, filesPath, print: () => {} });
      const comparison = compareBenchResults(baseline, candidate);
      console.log(formatBenchComparison(comparison));
      console.log(JSON.stringify(comparison));
      return;
    }

    await benchTrial({ root, ref, filesPath });
  },
}]);
