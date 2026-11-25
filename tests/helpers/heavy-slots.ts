// GY-3854: a test file run from a Mainworks session or loop (`node --test FILE`) inherits the host's
// real heavy-job slot directory, and its fixture trials registered there as `test merge GY-1`. Imported
// for its effect, before any test runs, by temp-dirs.ts and by every file that starts trials without it.
// The file then runs as the suite's runner would start it: outside any budget, with its data home under
// this checkout. A fixture that wants slots names its own directory.
import { resolve } from 'node:path';
import { heldVariable, projectVariable, slotsDirectoryVariable } from '../../src/master/verification-slots.js';
import { setting } from '../../src/setting.js';

// Only a test file: a process a test starts keeps the directory the test handed it.
if (/\.test\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  for (const name of [slotsDirectoryVariable, projectVariable, heldVariable]) { delete process.env[name]; delete process.env[name.replace(/^GRAPHYARD_/, 'MAINWORKS_')]; }
  if (!setting('DATA_HOME')) process.env.GRAPHYARD_DATA_HOME = resolve(import.meta.dirname, '../../.graphyard/test-data');
}
