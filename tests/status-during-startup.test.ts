import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseUrl as createDatabaseUrl } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { main } from '../src/server/main.js';
import { ProductionWatch } from '../src/production-watch.js';
import { masterStatus } from '../src/cli/master-status.js';
import { masterConfigSchema, type MasterConfig } from '../src/master/profiles.js';

// GY-4001: a master status read while startup initialization runs says the server is starting
// instead of showing an empty board that reads as a stall.

const token = 'c'.repeat(32);
let scratch: string;

before(async () => {
  scratch = await temporaryDirectory('status-during-startup');
  process.env.DATABASE_URL = await createDatabaseUrl('status-during-startup');
  process.env.GRAPHYARD_PRINCIPALS = JSON.stringify([{ id: 'admin', role: 'admin', token: 'a'.repeat(32) }, { id: 'loop', role: 'coordinator', token }]);
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.GITHUB_CI_APP_IDS = '15368';
});

after(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {}); });

test('integration:status-during-startup — master status says starting with no board before startup completes, and the full board after', async () => {
  const original = ProductionWatch.prototype.load;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  ProductionWatch.prototype.load = async () => { await pending; };
  try {
    const instance = await main({ port: 0 });
    try {
      const url = `http://127.0.0.1:${(instance.http.address() as any).port}`;
      const { root } = await gitRepo({ label: 'status-during-startup-root' });
      const credentialFile = join(scratch, 'coordinator.token');
      writeFileSync(credentialFile, token, { mode: 0o600 });
      const config = masterConfigSchema.parse({ version: 1, url, credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
        repository: 'owner/status-during-startup', baseBranch: 'main', hostId: 'coord-a', masterAgentName: 'graphyard-master-startup', workers: [],
        run: { worktreeRoot: await temporaryDirectory('status-during-startup-wt') } }) as MasterConfig;
      const masterApi = async (path: string) => {
        const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw Object.assign(new Error(await response.text()), { status: response.status });
        return response.json();
      };
      const run = async () => '';

      assert.equal(instance.isReady(), false);
      const starting = await masterStatus(root, config, masterApi, run) as any;
      assert.equal(starting.starting, true);
      assert.equal(starting.items, undefined);
      assert.equal(starting.workers, undefined);
      // The loop's coordination read gets no board either, so the empty-board alarm has nothing to judge.
      const snapshot = await fetch(`${url}/api/work-snapshot?view=coordination`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(snapshot.status, 503);
      assert.equal((await snapshot.json()).starting, true);

      release();
      for (let i = 0; i < 200 && !instance.isReady(); i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(instance.isReady(), true);
      const ready = await masterStatus(root, config, masterApi, run) as any;
      assert.equal(ready.starting, undefined);
      assert.ok(Array.isArray(ready.items));
    } finally { release(); await instance.close(); }
  } finally { ProductionWatch.prototype.load = original; }
});
