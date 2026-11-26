import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import { parseCase } from '../src/e2e/case.js';
import { projectCaseSuite } from '../src/release-project.js';
import type { E2eReport } from '../src/e2e/runner.js';
import { readFileSync } from 'node:fs';
import { listen } from './helpers/http-server.js';

// GY-2983 AC-2, on this head: on a served static fixture app with a required case, the dashboard's
// release line names the served commit and 'verified' after the serve pass runs its cases, and
// names the failing case once that case is broken. The case itself is
// e2e/cases/served-app-verified.json, run here the way the merge trial runs it: against a control
// plane whose serving root is a checkout, with the records the pass writes. The serving root is
// this test's own temporary checkout, so the records the case's command steps write are the ones
// this control plane reads.


test('unit:served-app-verified-case — the release line names the served commit verified, and the failing case once that case is broken', { timeout: 300_000 }, async () => {
  const operator: Principal = { id: 'e2e-operator', role: 'admin' }, token = `trial-${randomUUID()}`;
  // The checkout whose serving this control plane reports, and whose .graphyard the case's command
  // steps write the records into: the runner's root is the same checkout, exactly as in a trial.
  const { root } = await gitRepo({ label: 'served-app-verified-root', files: { 'served.txt': 'the fixture app the record claims is served\n' }, message: 'the fixture app' });
  // The case's command steps write the records with this script, which with no e2e serve writes into its own checkout.
  await mkdir(join(root, 'scripts')); await copyFile(join(process.cwd(), 'scripts', 'e2e-serve-record.mjs'), join(root, 'scripts', 'e2e-serve-record.mjs'));
  const written = join(root, '.graphyard', 'served.json');
  let close: (() => Promise<void>) | undefined, store: Store | null = null;
  process.env.GRAPHYARD_REPOSITORY_ROOT = root;
  try {
    store = await withDatabase('served-app-verified-case'); await store.init();
    const engine = new Engine(store, 120, '');
    const { url: origin, close: stop } = await listen(server(engine, [{ ...operator, token }], {})); close = stop;

    const file = 'e2e/cases/served-app-verified.json';
    let report: E2eReport | null = null;
    await projectCaseSuite(root, token, { cases: [{ file, definition: parseCase(file, readFileSync(join(process.cwd(), file), 'utf8')) }], select: () => true,
      withholdSecrets: true, artifactsDirectory: await temporaryDirectory('served-app-verified-artifacts'), signal: AbortSignal.timeout(240_000), report: value => { report = value; } })
      .run(origin, null);
    const outcome = (report as E2eReport | null)?.cases.find(entry => entry.id === 'served-app-verified');
    assert.equal(outcome?.verdict, 'passed', JSON.stringify(outcome?.failingStep ?? outcome));
  } finally { delete process.env.GRAPHYARD_REPOSITORY_ROOT; await rm(written, { force: true }); await close?.(); if (store) await store.close(); }
});

after(async () => { /* temporaryDirectory's own hook removes the database directories */ });
