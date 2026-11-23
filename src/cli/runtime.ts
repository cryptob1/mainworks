import { defineCommands } from './registry.js';
import { checkRuntime } from '../runtime-check.js';

export const runtimeCommands = defineCommands([{
  name: 'runtime',
  help: [
    '  runtime check [ENV...]        Run each deployed environment\'s variables command (graphyard.json',
    '                                runtime) and name the required variables it lacks; exits 1 when',
    '                                one lacks any or its listing fails. Prints names, never values',
  ],
  readsConnection: () => false,
  async run(context) {
    if (context.id !== 'check') throw new Error('Usage: graphyard runtime check [ENV...]');
    const results = await checkRuntime(context.repositoryRoot(), context.args);
    for (const { environment, missing, fault } of results)
      console.log(`${environment}: ${fault ?? (missing.length ? `missing ${missing.join(', ')}` : 'every required variable is set')}`);
    if (results.some(result => result.fault || result.missing.length)) process.exitCode = 1;
  },
}]);
