import { defineCommands } from './registry.js';
import { checkRuntime } from '../runtime-check.js';
import { loadMasterConfig } from '../master/config.js';
import { installIdFor } from '../install/types.js';
import { installDirectory } from '../install/secrets.js';

export const runtimeCommands = defineCommands([{
  name: 'runtime',
  help: [
    '  runtime check [ENV...]        Name the variables each deployed environment lacks: graphyard.json',
    '                                runtime says what it needs, the install\'s runtime.json how to list',
    '                                it. Exits 1 when one lacks any or its listing fails. Names only',
  ],
  readsConnection: () => false,
  async run(context) {
    if (context.id !== 'check') throw new Error('Usage: mainworks runtime check [ENV...]');
    const root = context.repositoryRoot();
    const results = await checkRuntime(root, installDirectory(installIdFor((await loadMasterConfig(root)).repository)), context.args);
    for (const { environment, missing, fault } of results)
      console.log(`${environment}: ${fault ?? (missing.length ? `missing ${missing.join(', ')}` : 'every required variable is set')}`);
    if (results.some(result => result.fault || result.missing.length)) process.exitCode = 1;
  },
}]);
