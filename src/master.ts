// GY-3964: no longer a barrel — importers name the owning module under src/master/. The file stays for
// the one loader that cannot: cli/workspace-generated.ts imports it by path from a merged tree.
export { withoutMasterInstructions } from './master/instructions.js';
