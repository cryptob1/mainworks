import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { databaseBoundWarning } from '../src/server/plane-health.js';
import { healthRoutes } from '../src/server/routes/health.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { withEnv } from './helpers/env.js';

// GY-4005: core's database reached 9.99 GB of its 10 GB bound with nothing saying so. Past 80% of the
// bound /healthz and master status each show one line: used, bound, the largest table and the action.
const bound = 10e9;
const reading = (used: number) => ({ used, bound, advisory: true, tables: [{ table: 'events', bytes: used - 0.6e9 }, { table: 'work_items', bytes: 0.1e9 }] });

/** /healthz over a pool that answers the database at `used` bytes of a configured 10 GB bound. */
async function healthz(used: number) {
  const client = {
    query: async (sql: string) => /pg_database_size/.test(sql) ? { rows: [{ size: used }] } : /pg_total_relation_size/.test(sql) ? { rows: reading(used).tables } : { rows: [{}] },
    release: () => {},
  };
  const pool = { waitingCount: 0, idleCount: 1, connect: async () => client, query: client.query };
  return withEnv({ MAINWORKS_DATABASE_MAX_BYTES: String(bound) }, async () => {
    const services = { engine: { store: { pool } }, build: { commit: 'c'.repeat(40), protocol: 1 } } as any;
    return await healthRoutes.routes[0].handle({ services, url: new URL('http://plane/healthz'), send: () => { throw new Error('no 503 expected'); } } as any, []) as any;
  });
}

test('unit:health-warns-at-80-percent-of-database-bound — past 80% of the bound /healthz and master status show one line with used, bound, the largest table and the action; at or under it they show none', async () => {
  const line = databaseBoundWarning(reading(9.4e9));
  assert.equal(line, 'Database at 94% of its bound: 9.4 GB of 10.0 GB, largest table events 8.8 GB. File a fix for what fills events, or grow the volume and raise MAINWORKS_DATABASE_MAX_BYTES.');
  assert.equal(databaseBoundWarning(reading(8e9)), null, 'exactly 80% is not past it');
  assert.equal(databaseBoundWarning(reading(7.9e9)), null);
  assert.equal(databaseBoundWarning({ used: null, bound, detail: 'unreadable' }), null, 'an unread size says nothing rather than something false');

  assert.equal((await healthz(9.4e9)).warning, line, '/healthz shows the line');
  assert.equal((await healthz(5e9)).warning, null);

  const directory = await temporaryDirectory('database-bound-warning');
  const root = join(directory, 'checkout');
  execFileSync('git', ['init', '-q', root]);
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/project', credentialFile: join(directory, 'coordinator.token'),
    cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main', githubAppId: 1234, masterAgentName: 'master', workers: [] });
  const status = (warning: string | null) => masterStatusReport(root, config, async (path: string) => path === 'database-bound' ? { warning } : { work: [], now: new Date().toISOString() }, async () => '');
  const shown = (await status(line)).attention.filter((entry: any) => (entry.text ?? entry) === line);
  assert.equal(shown.length, 1, 'master status shows the line once');
  assert.equal((await status(null)).attention.some((entry: any) => /Database at/.test(entry.text ?? entry)), false);
});
