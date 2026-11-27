import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configCommand } from '../src/cli/config-owner.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { daemonStatePath } from '../src/daemon/state.js';
import { applyInstall, buildPlan, installRequestFromArgs, prepareInstall } from '../src/install/index.js';
import type { MasterConfig } from '../src/master/profiles.js';
import { servedInstall } from './helpers/served-install.js';
import { harness } from './install-harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3850: the owner commits are authored by is one install setting: install records it from the
// installer's git config and shows it in --plan, `mainworks config owner "NAME" EMAIL` changes it with
// history, and an install with none shows one attention line naming that command. A re-run guesses nothing.

test('integration:owner-attribution-setting — install records the owner from git config and shows it in the plan; config owner changes it with history; none shows one attention line', async () => {
  // install --plan shows the owner from the installer's git config; --apply records it on a first install.
  const fixture = await harness({ provider: 'compose', serverUrl: 'http://127.0.0.1:4310', extraResponses: [
    { match: 'git config --global user.name', result: 'Ada Lovelace\n' }, { match: 'git config --global user.email', result: 'ada@example.com\n' }] });
  const posted: unknown[] = [];
  const served = fixture.deps.fetch!;
  fixture.deps.fetch = (async (input: any, init: any = {}) => String(input).endsWith('/api/owner') && init.method === 'POST'
    ? (posted.push(JSON.parse(String(init.body))), new Response(JSON.stringify({ owner: JSON.parse(String(init.body)) }), { status: 200 })) : served(input, init)) as typeof fetch;
  try {
    const args = ['--provider', 'compose', '--repo', 'owner/project'];
    const planned = await buildPlan(await prepareInstall(fixture.root, installRequestFromArgs(args).request, fixture.deps, 'plan'));
    const action = planned.actions.find(entry => entry.id === 'graphyard.owner')!;
    assert.equal(action.state, 'create');
    assert.equal(action.title, `Author every commit as 'Ada Lovelace (Mainworks) <ada@example.com>'; change it with mainworks config owner "NAME" EMAIL`);
    assert.deepEqual(action.values?.map(value => [value.name, value.value]), [['owner name', 'Ada Lovelace'], ['owner email', 'ada@example.com']]);
    assert.deepEqual(posted, [], 'the plan changes nothing');
    const session = await prepareInstall(fixture.root, installRequestFromArgs([...args, '--apply']).request, fixture.deps, 'apply');
    await applyInstall(session, await buildPlan(session));
    assert.deepEqual(posted, [{ name: 'Ada Lovelace', email: 'ada@example.com' }]);

    // A re-run or upgrade of the existing install sets nothing by guessing.
    const again = await prepareInstall(fixture.root, installRequestFromArgs([...args, '--apply']).request, fixture.deps, 'apply');
    const rerun = await buildPlan(again);
    assert.equal(rerun.actions.find(entry => entry.id === 'graphyard.owner')!.state, 'satisfied');
    await applyInstall(again, rerun);
    assert.equal(posted.length, 1, 'an existing install records no owner by guessing');
  } finally { await fixture.cleanup(); }

  const install = await servedInstall('owner_attribution');
  const previousToken = process.env.MAINWORKS_TOKEN;
  process.env.MAINWORKS_TOKEN = install.operator;
  try {
    // None recorded: commits are authored Mainworks, and master status shows one attention line naming the command.
    assert.equal((await install.call('/api/owner')).body.owner, null);
    assert.equal((await install.call('/api/status')).body.owner, null);
    const root = await temporaryDirectory('owner-attribution');
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    const credentials = await temporaryDirectory('owner-attribution-credentials');
    const master = { url: install.base, repository: 'owner/owner_attribution', credentialFile: join(credentials, 'coordinator.token'), hostId: 'yard-box', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
    await writeFile(daemonStatePath(master), JSON.stringify({ version: 1, url: master.url, repository: master.repository }));
    const attention = async () => (await masterStatusReport(root, master, async path => path === 'owner' ? (await install.call('/api/owner')).body : { work: [], now: new Date().toISOString() }, async () => ''))
      .attention.filter((line: any) => line.subject === 'commit author');
    const unowned = await attention();
    assert.equal(unowned.length, 1);
    assert.equal(unowned[0]!.text, 'Commits are authored "Mainworks": name the owner with mainworks config owner "NAME" EMAIL');

    // mainworks config owner changes it: applied at once, with history; only an admin may.
    const printed: any[] = [];
    const context = { id: 'owner', repositoryRoot: () => root, print: (value: unknown) => { printed.push(value); },
      api: async (path: string, body?: unknown) => { const answer = await install.call(`/api/${path}`, body); if (answer.status !== 200) throw new Error(answer.body.error); return answer.body; } } as any;
    await configCommand.run({ ...context, args: ['Ada Lovelace', 'ada@example.com'] }, undefined);
    assert.deepEqual(printed.at(-1), { owner: { name: 'Ada Lovelace', email: 'ada@example.com', by: 'operator', at: printed.at(-1).owner.at }, author: 'Ada Lovelace (Mainworks) <ada@example.com>' });
    assert.deepEqual((await install.call('/api/status')).body.owner, { name: 'Ada Lovelace', email: 'ada@example.com' });
    assert.deepEqual(await attention(), [], 'the attention line clears once the owner is named');
    await configCommand.run({ ...context, args: ['Grace Hopper', 'grace@example.com'] }, undefined);
    const history = (await install.call('/api/owner')).body.history;
    assert.deepEqual(history.map((entry: any) => [entry.name, entry.email, entry.by]), [['Grace Hopper', 'grace@example.com', 'operator'], ['Ada Lovelace', 'ada@example.com', 'operator']]);
    await configCommand.run({ ...context, args: [] }, undefined);
    assert.equal(printed.at(-1).author, 'Grace Hopper (Mainworks) <grace@example.com>');
    await assert.rejects(configCommand.run({ ...context, args: ['Only a name'] }, undefined), /Usage: mainworks config owner "NAME" EMAIL/);

    const refused = await fetch(`${install.base}/api/owner`, { method: 'POST', headers: { Authorization: `Bearer ${install.loop}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Loop', email: 'loop@example.com' }) });
    assert.equal(refused.status, 403);
    assert.equal((await install.call('/api/owner')).body.owner.name, 'Grace Hopper');
  } finally {
    if (previousToken === undefined) delete process.env.MAINWORKS_TOKEN; else process.env.MAINWORKS_TOKEN = previousToken;
    await install.close();
  }
});
