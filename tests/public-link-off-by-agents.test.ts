import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { servedInstall } from './helpers/served-install.js';

// GY-3917: tightening access never waits on a person. The owner's session, the operator credential and
// the Lead turn the public link off; only the owner signed in to the dashboard turns it on.

const cli = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const tokens = { admin: 'test-admin-operator-credential-0123456789', worker: 'test-worker-credential-0123456789abcd', producer: 'test-producer-credential-0123456789ab', reader: 'test-reader-credential-0123456789abcd', agent: 'test-operator-agent-credential-0123456789' };

test('integration:public-link-off-by-agents-on-by-owner-only — off from the owner, the operator and the Lead, recorded and Funnel stopped next pass; on from the owner\'s session alone; workers, reviewers and producers refused both', async () => {
  const install = await servedInstall('public_link_off_agents', { funnel: true, principals: [
    { id: 'admin-operator', role: 'admin', token: tokens.admin }, { id: 'worker', role: 'worker', token: tokens.worker },
    { id: 'producer', role: 'producer', token: tokens.producer }, { id: 'reviewer', role: 'reader', token: tokens.reader },
  ] });
  try {
    const as = async (token: string, on: boolean) => {
      const response = await fetch(install.base + '/api/team-access/public-link', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ on }) });
      return { status: response.status, body: await response.json() as any };
    };
    const registered = await fetch(install.base + '/api/operator-agents', { method: 'POST', headers: { Authorization: `Bearer ${install.operator}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'register-lead' },
      body: JSON.stringify({ id: 'lead', displayName: 'Lead', capabilities: [], scope: { repositories: ['owner/public_link_off_agents'], workItems: ['*'] }, token: tokens.agent, reason: 'the Lead' }) });
    assert.ok(registered.ok, await registered.text());
    const funnelOpen = () => existsSync(join(install.host, 'funnel.json')) && Object.keys(JSON.parse(readFileSync(join(install.host, 'funnel.json'), 'utf8'))).length > 0;

    // On: only the owner's human session.
    for (const [token, name] of [[tokens.admin, 'operator credential'], [install.loop, 'loop'], [tokens.agent, 'Lead'], [tokens.worker, 'worker'], [tokens.producer, 'producer'], [tokens.reader, 'reviewer']]) {
      const refused = await as(token!, true);
      assert.equal(refused.status, 403, name);
      assert.equal(refused.body.error, 'Only the owner, signed in to the dashboard, turns the public link on');
    }
    for (const token of [tokens.worker, tokens.producer, tokens.reader]) {
      const refused = await as(token, false);
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error, 'Only the owner, the operator or the Lead turns the public link off');
    }

    // Off from each of the owner, the operator credential, the coordinator Lead and the operator-agent Lead.
    for (const [token, by, cliCommand] of [[install.operator, 'operator'], [tokens.admin, 'admin-operator'], [install.loop, 'loop'], [tokens.agent, 'lead', true]] as const) {
      assert.equal((await as(install.operator, true)).status, 200);
      await install.sync();
      assert.ok(funnelOpen(), 'on, the loop runs Funnel');
      let line: string;
      if (cliCommand) {
        const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GRAPHYARD|MAINWORKS)_/.test(name)));
        Object.assign(env, { MAINWORKS_URL: install.base, MAINWORKS_TOKEN: token });
        line = (await promisify(execFile)(process.execPath, [cli, 'team-access', 'public-link', 'off'], { env })).stdout.trim();
      } else {
        const off = await as(token, false);
        assert.equal(off.status, 200, JSON.stringify(off.body));
        assert.equal(off.body.on, false);
        assert.equal(off.body.by, by);
        assert.ok(Math.abs(Date.parse(off.body.at) - Date.now()) < 60_000);
        line = `Public link: off (set by ${off.body.by} at ${off.body.at})`;
      }
      assert.match(line, new RegExp(`^Public link: off \\(set by ${by} at \\d{4}-`));
      await install.sync();
      assert.equal(funnelOpen(), false, `off by ${by}, the loop stops Funnel within one pass`);
    }
  } finally { await install.close(); }
});
