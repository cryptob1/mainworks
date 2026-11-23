// The launcher entry point. Commands live under src/cli/, one module per command group.
import { setting } from './mainworks-names.js';
import { main } from './cli/index.js';

main().catch(error => { console.error(error.message); process.exitCode = error.releaseHandover && setting('LAUNCHER') === '1' ? 75 : 1; });
