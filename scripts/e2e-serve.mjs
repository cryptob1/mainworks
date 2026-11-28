// The head's control plane for the merge trial's E2E cases (GY-2969), as graphyard.json's
// e2e.serve declares it:
//
//   node --import tsx scripts/e2e-serve.mjs
//
// It starts the local runtime (src/install/local-runtime.ts: embedded Postgres, migrations, the
// control plane) against a fresh database under TMPDIR — its cluster a copy of the warm template
// cluster and its database a clone of the migrated template (src/e2e/warm-postgres.ts) — serving
// 127.0.0.1:4391 (or GRAPHYARD_E2E_SERVE_PORT, which every worker session carries (GY-3584), so a run beside another serve on the host keeps its own
// port, GY-3195) with one admin principal whose token is GRAPHYARD_E2E_TOKEN (the token the trial's cases authenticate with; one
// is made and printed when unset). On SIGTERM or SIGINT it stops the server and the database and
// removes the database directory. No credential is read. A case that seeds its own records
// (scripts/e2e-seed-plain-status.mjs) reads the database URL from .graphyard/e2e-serve-PORT.json, its own
// serve's port: two serves in one checkout (a trial's, a worker's) never overwrite or remove each other's (GY-3666).
// The loop's item-preview step runs beside it (GY-3193), so a preview case's items gain their previews.
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localPaths, serveControlPlane, startLocalRuntime } from '../src/install/local-runtime.ts';
import { copyTemplateCluster, templateDatabase, warmPassword } from '../src/e2e/warm-postgres.ts';
import { deliveryFixture } from './e2e-delivery-fixture.mjs';
import { startPreviewLoop } from './e2e-preview-loop.mjs';

const freePort = () => new Promise((accept, reject) => {
  const server = createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => accept(port)); });
});

export async function startE2eServe({
  port = Number(process.env.GRAPHYARD_E2E_SERVE_PORT) || 4391,
  token = process.env.GRAPHYARD_E2E_TOKEN || randomBytes(24).toString('hex'),
  cwd = process.cwd(),
  startRuntime = startLocalRuntime,
  serve = serveControlPlane,
  startPreviews = startPreviewLoop,
  copyCluster = copyTemplateCluster,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-e2e-serve-'));
  const seedFile = join(cwd, '.graphyard', `e2e-serve-${port}.json`);
  let wroteSeed = false;
  const removeDirectory = () => Promise.all([rm(directory, { recursive: true, force: true }), ...(wroteSeed ? [rm(seedFile, { force: true })] : [])]);
  const paths = localPaths(directory);
  let runtime, previews;
  try {
    const delivery = await deliveryFixture(directory);
    const workerToken = randomBytes(24).toString('hex'), coordinatorToken = randomBytes(24).toString('hex');
    const databasePort = await freePort();
    await mkdir(paths.postgres, { recursive: true, mode: 0o700 });
    await copyCluster(paths.data, databasePort);
    await writeFile(paths.passwordFile, warmPassword, { mode: 0o600 });
    await writeFile(paths.portFile, String(databasePort));
    await writeFile(paths.environment, JSON.stringify({
      PORT: String(port), HOST: '127.0.0.1',
      GITHUB_REPOSITORY: 'cryptob1/graphyard',
      GRAPHYARD_REPOSITORY_ROOT: delivery.root,
      GRAPHYARD_PRINCIPALS: JSON.stringify([
        { id: 'e2e-operator', role: 'admin', sessionKind: 'human', token },
        { id: 'e2e-worker', role: 'worker', token: workerToken },
        { id: 'e2e-coordinator', role: 'coordinator', token: coordinatorToken },
      ]),
    }), { mode: 0o600 });
    // GY-4109: write the port seed file before the control plane binds its port, so any case that
    // runs as soon as /healthz?ready answers 200 always finds .graphyard/e2e-serve-PORT.json on disk.
    runtime = await startRuntime(directory, {
      template: templateDatabase,
      serve: async environment => {
        await mkdir(dirname(seedFile), { recursive: true });
        await writeFile(seedFile, JSON.stringify({ databaseUrl: environment.DATABASE_URL, delivery: { ...delivery, workerToken, coordinatorToken } }), { mode: 0o600 });
        wroteSeed = true;
        return serve(environment);
      },
    });
    previews = startPreviews({ url: runtime.url, token: coordinatorToken, root: delivery.root, base: join(directory, 'previews') });
    let stopping = null;
    const stop = () => stopping ??= previews.stop().then(() => runtime.stop()).finally(() => removeDirectory());
    return { directory, seedFile, runtime, previews, stop };
  } catch (error) {
    await removeDirectory();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.GRAPHYARD_E2E_TOKEN || randomBytes(24).toString('hex');
  if (!process.env.GRAPHYARD_E2E_TOKEN) console.log(`GRAPHYARD_E2E_TOKEN unset; the admin token is ${token}`);
  try {
    const started = await startE2eServe({ token });
    // The trial waits for /healthz?ready to answer 200: mutations are refused until startup validation completes.
    console.log(`Mainworks e2e serve at ${started.runtime.url} on a database in ${started.directory}`);
    let stopping = null;
    const shutdown = () => {
      stopping ??= started.stop().catch(error => console.error(error instanceof Error ? error.message : String(error))).finally(() => process.exit(0));
      setTimeout(() => process.exit(1), 30_000).unref();
    };
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
    started.runtime.cluster.process.once('exit', code => { if (stopping) return; console.error(`Postgres exited (${code})`); shutdown(); });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
