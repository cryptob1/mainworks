import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
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

// GY-2976 AC-3, on this head: the served control plane's status read — the master status serving
// block the dashboard uses — returns the serve fields over the API (url, served commit, atMain,
// last failure; null when nothing is declared), and the dashboard page shows the Served line with
// a link when a URL is present. The case itself is e2e/cases/served-app-link.json, run here the
// way the merge trial runs it: against a control plane whose serving root is a checkout, with the
// serve record a served main writes.
// GY-3669: the serving root is this test's own checkout, never the shared one. tests/graphyard-e2e-serve
// runs scripts/e2e-serve.mjs in the shared checkout, whose .graphyard/e2e-serve.json sends
// scripts/e2e-serve-record.mjs to another root while it runs, so the record missed this control plane.


/** Runs the case from `source` (the checkout holding the case and its script) against a control plane serving a checkout of its own. */
async function runLinkCase(source: string) {
  const operator: Principal = { id: 'e2e-operator', role: 'admin' }, token = `trial-${randomUUID()}`;
  const { root } = await gitRepo({ label: 'served-app-link-root', message: 'the fixture app', files: { 'served.txt': 'the fixture app the record claims is served\n' } });
  await mkdir(join(root, 'scripts')); await copyFile(join(source, 'scripts', 'e2e-serve-record.mjs'), join(root, 'scripts', 'e2e-serve-record.mjs'));
  let close: (() => Promise<void>) | undefined, store: Store | null = null;
  process.env.GRAPHYARD_REPOSITORY_ROOT = root;
  try {
    store = await withDatabase('served-app-link-case'); await store.init();
    const engine = new Engine(store, 120, '');
    const { url: origin, close: stop } = await listen(server(engine, [{ ...operator, token }], {})); close = stop;

    const file = 'e2e/cases/served-app-link.json';
    let report: E2eReport | null = null;
    await projectCaseSuite(root, token, { cases: [{ file, definition: parseCase(file, readFileSync(join(source, file), 'utf8')) }], select: () => true,
      withholdSecrets: true, artifactsDirectory: await temporaryDirectory('served-app-link-artifacts'), signal: AbortSignal.timeout(240_000), report: value => { report = value; } })
      .run(origin, null);
    const outcome = (report as E2eReport | null)?.cases.find(entry => entry.id === 'served-app-link');
    assert.equal(outcome?.verdict, 'passed', JSON.stringify(outcome?.failingStep ?? outcome));
  } finally { delete process.env.GRAPHYARD_REPOSITORY_ROOT; await close?.(); if (store) await store.close(); } }

test('unit:served-app-link-case — the served head reports the declared serve over the API and the dashboard links it', { timeout: 300_000 }, async () => {
  await runLinkCase(process.cwd());
});

test('unit:served-app-link-case-pinned — a concurrent e2e serve\'s seed file in the shared checkout does not move the serve record', { timeout: 300_000 }, async () => {
  // The shared checkout as tests/graphyard-e2e-serve leaves it while it runs: its seed file names another delivery root.
  const shared = await temporaryDirectory('served-app-link-shared');
  await symlink(join(process.cwd(), 'scripts'), join(shared, 'scripts'));
  await symlink(join(process.cwd(), 'e2e'), join(shared, 'e2e'));
  await mkdir(join(shared, '.graphyard'));
  await writeFile(join(shared, '.graphyard', 'e2e-serve.json'), JSON.stringify({ delivery: { root: await temporaryDirectory('served-app-link-elsewhere') } }));
  await runLinkCase(shared);
});

after(async () => { /* temporaryDirectory's own hook removes the database directories */ });
