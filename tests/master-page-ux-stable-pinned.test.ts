import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveMasterState } from '../browser-tests/master-state.js';
import { terminalSessionReader } from '../src/master/terminal-session.js';
import type { MasterConfig } from '../src/master/profiles.js';

// GY-3752: e2e:master-page-ux failed one run in 40 at an exact reconnect count. The spec rewrote the
// Lead's daemon state file in place while the terminal stream re-reads it every second; a read that
// landed mid-write found it empty, the reader threw, the stream exited and the page reconnected once
// more than the spec counts. The spec's save replaces the file whole, as the loop's own write does.
test('unit:master-page-ux-stable-pinned — a session read during the spec\'s save never sees a half-written state file', async () => {
  const site = await mkdtemp(join(tmpdir(), 'gy3752-'));
  try {
    const read = terminalSessionReader(() => ({ credentialFile: join(site, 'master.token') }) as MasterConfig);
    const state = (n: number) => ({ master: { agentName: '', pane: `w1:pane-${n}`, account: 'test-account', runtime: 'codex' }, status: 'idle', gap: 'x'.repeat(200_000) });
    await saveMasterState(join(site, 'master.daemon.json'), state(0));
    const failures: string[] = [];
    for (let n = 1; n <= 200; n++) {
      const saving = saveMasterState(join(site, 'master.daemon.json'), state(n));
      await Promise.all([saving, ...Array.from({ length: 4 }, () => read().catch(error => { failures.push(String(error)); }))]);
    }
    assert.deepEqual(failures.slice(0, 3), [], `${failures.length} session reads failed during a save`);
  } finally { await rm(site, { recursive: true, force: true }); }
});
