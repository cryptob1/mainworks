import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

// GY-3964: importers name the owning module; the master and daemon barrels are gone.
test('unit:barrel-imports — source imports owning master modules and the daemon barrel is gone', () => {
  for (const barrel of ['src/master-daemon.ts', 'src/master.ts']) assert.equal(existsSync(resolve(root, barrel)), false, barrel);
});
