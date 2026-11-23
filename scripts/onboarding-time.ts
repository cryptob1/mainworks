// The daily onboarding time (GY-3747), run by the diagnostics in a checkout of the verified commit:
// a scratch install on its own disposable Postgres, timed from connect to first merge. Prints the
// run as its last line of JSON.
//
//   node --import tsx scripts/onboarding-time.ts COMMIT
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveTestPorts } from '../src/cli/test-isolation.js';
import { copyTemplateCluster, createMigratedDatabase, warmPassword, warmUser } from '../src/e2e/warm-postgres.js';
import { postgresBinaries, startCluster, type LocalPaths } from '../src/install/local-runtime.js';
import { measureOnboarding } from '../src/onboarding-scratch.js';
import { Store } from '../src/store.js';

const scratch = await mkdtemp(join(tmpdir(), 'mainworks-onboarding-'));
const ports = await reserveTestPorts(), port = ports.base;
try {
  const data = join(scratch, 'postgres');
  await copyTemplateCluster(data, port);
  const cluster = await startCluster({ data } as LocalPaths, port, await postgresBinaries());
  try {
    await createMigratedDatabase(port, 'onboarding');
    const store = new Store(`postgres://${warmUser}:${warmPassword}@127.0.0.1:${port}/onboarding`);
    await store.init();
    try { console.log(JSON.stringify(await measureOnboarding(store, { scratch, commit: process.argv[2] ?? 'unknown' }))); } finally { await store.close(); }
  } finally { await cluster.stop(); }
} finally {
  ports.release();
  await rm(scratch, { recursive: true, force: true });
}
