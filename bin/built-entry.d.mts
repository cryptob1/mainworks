// Types for bin/built-entry.mjs, which tests/helpers/run-tests.ts imports.
export const builtEntries: string[];
export function builtEntry(root: string, name: string): string | null;
export function buildEntries(root: string): Promise<void>;
