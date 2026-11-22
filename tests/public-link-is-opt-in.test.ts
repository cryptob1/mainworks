import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { incidentsFromStatus, publicLinkOffLine } from '../src/model/incidents.js';
import { tailnetOnlyGuidance } from '../src/server/routes/team-access.js';
import { funnelRetryMs } from '../src/team-access.js';
import { servedInstall } from './helpers/served-install.js';

// GY-3690: the public link is the owner's explicit choice. Off, the loop never runs Funnel and a new
// invite says it opens only on the tailnet. On, with the install served tailnet-only on 443 and a
// teammate invited, the loop turns Funnel on for 443; while it cannot, Home shows one incident and
// master status one line, and both clear once the link is public.

test('e2e:public-link-is-opt-in — off, the loop never runs Funnel and invites say tailnet only; on, it turns Funnel back on for the port that serves the install, and Home says so while invited people are locked out', async () => {
  const install = await servedInstall('public_link_is_opt_in');
  try {
    await install.serve({ 443: install.base });
    const funnels = () => readFileSync(join(install.host, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]).filter(args => args[0] === 'funnel');
    const loopApi = async (path: string) => (await fetch(install.base + path, { headers: { Authorization: `Bearer ${install.loop}` } })).json() as Promise<any>;
    const incident = async () => incidentsFromStatus((await install.call('/api/status')).body, [], Date.now()).filter(item => item.kind === 'public-link');
    const start = Date.now();

    // Off (the default): no funnel call, and a new invite says it opens only on the tailnet.
    await install.sync(start);
    assert.deepEqual(funnels(), []);
    const invite = await install.call('/api/invites', { name: 'ana@example.com', role: 'viewer', days: 7 });
    assert.equal(invite.status, 200, JSON.stringify(invite.body));
    assert.equal(invite.body.note, tailnetOnlyGuidance);
    await install.sync(start + funnelRetryMs);
    assert.deepEqual(funnels(), [], 'still none, even with public ports free');
    assert.deepEqual(await incident(), [], 'no incident while the owner keeps it off');

    // On, Funnel refused: the loop ran the command for 443, the install's own port, and says it is locked.
    assert.equal((await install.call('/api/team-access/public-link', { on: true })).body.on, true);
    await install.sync(start + 2 * funnelRetryMs);
    assert.deepEqual(funnels(), [['funnel', '--bg', '--https=443', install.base]]);
    const open = await incident();
    assert.equal(open.length, 1);
    assert.equal(open[0]!.broke, `${publicLinkOffLine}.`);
    assert.equal(open[0]!.broke, 'Invited people cannot open the dashboard: the public link is off although you turned it on.');
    assert.equal(open[0]!.impact, 'It has not been public yet.');
    assert.match(open[0]!.doing, /^Turning Funnel on for port 443 failed: .*The loop retries every 10 minutes\.$/);
    assert.equal((await loopApi('/api/team-access/host')).publicLinkOff.doing, open[0]!.doing, 'master status reads the same line');

    // Within 10 minutes the loop checks but does not run the command again.
    await install.sync(start + 2 * funnelRetryMs + 60_000);
    assert.equal(funnels().length, 1);

    // Funnel is allowed again: the next run turns it on and the incident clears.
    await rm(join(install.host, 'funnel-refused'));
    await install.sync(start + 3 * funnelRetryMs);
    assert.deepEqual(funnels().at(-1), ['funnel', '--bg', '--https=443', install.base]);
    assert.equal((await install.call('/api/team-access')).body.public, true);
    assert.deepEqual(await incident(), []);
    assert.equal((await loopApi('/api/team-access/host')).publicLinkOff, null);
  } finally { await install.close(); }
});
