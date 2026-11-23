import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { proposedRuntimes } from '../src/model/registry.js';
import { headlessWorkers, type HeadlessWorkers } from './helpers/headless-workers.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3721: a Pi account in the worker role builds. The real control plane, registry, dispatch,
// claim, worktree and watch; the only substitute is the `pi` program, which exits non-zero unless
// its key file sits under PI_CODING_AGENT_DIR and it was named provider and model as the registry
// id gives them, then commits and submits its head under its lease.
let workers: HeadlessWorkers;
before(async () => { workers = await headlessWorkers('pi-account-builds'); });
after(async () => { await workers.stop(); });

const coordinator = { id: 'graphyard-master', role: 'coordinator' } as const;

test('e2e:pi-account-builds — a Pi worker launched on its own login runs one item to submitted with a commit', async () => {
  const bin = await temporaryDirectory('pi-bin'), home = await temporaryDirectory('pi-a');
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: 'fixture-key' } }), { mode: 0o600 });
  await writeFile(join(bin, 'pi'), `#!${process.execPath}
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2), line = ' ' + args.join(' ') + ' ';
const dir = process.env.PI_CODING_AGENT_DIR;
if (!dir || !fs.existsSync(dir + '/auth.json')) { console.error('No API key found for zai'); process.exit(1); }
if (!line.includes(' --provider zai --model glm-5.3 ')) { console.error('Model not found: ' + args.join(' ')); process.exit(1); }
if (line.includes('Reply with the single word OK.')) { console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'OK', model: 'glm-5.3' } })); process.exit(0); }
const [, key, epoch] = /complete (GY-\\d+) (\\d+) --head/.exec(args.join(' ')) ?? [];
fs.writeFileSync('change.txt', 'built by pi\\n');
execFileSync('git', ['add', 'change.txt']);
execFileSync('git', ['-c', 'user.name=w', '-c', 'user.email=w@example.invalid', 'commit', '-qm', 'pi work']);
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const response = await fetch(process.env.GRAPHYARD_URL + '/api/work/' + key + '/submit', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.GRAPHYARD_TOKEN, 'Content-Type': 'application/json', 'Idempotency-Key': key + ':' + epoch }, body: JSON.stringify({ epoch: Number(epoch), head }) });
console.log('submitted ' + head + ' ' + response.status);
`, { mode: 0o755 });
  const pi = proposedRuntimes.find(runtime => runtime.name === 'pi')!;
  await workers.registry.mutate(coordinator as never, 'apply', {
    runtimes: [{ ...pi, launch: { ...pi.launch, environment: { PATH: `${bin}:/usr/bin:/bin` } } }],
    models: [{ name: 'glm', id: 'zai/glm-5.3' }],
    accounts: [{ enabled: true, maxSessions: null, name: 'pi-a', runtime: 'pi', model: 'glm', credential: { host: workers.hostId, home } }],
    roles: [{ name: 'worker', accounts: ['pi-a'], concurrency: 1 }], reason: 'GY-3721 fixture' }, randomUUID());
  await workers.registry.observe(coordinator as never, { host: workers.hostId, observations: [{ account: 'pi-a', quota: { loggedIn: true, state: 'available' }, smoke: { result: 'pass', reason: null } }] }, randomUUID());

  const work = await workers.readyItem('GY-9721');
  const launched = await workers.dispatch(work);
  assert.equal(launched.runtime, 'pi');
  assert.equal(launched.account?.environment, 'pi-a');
  const item = await workers.submitted(work.id, 1);
  assert.equal(item.submission?.epoch, 1, 'the item reached submitted');
  const path = item.workspaces[0]!.path, head = item.candidate?.sha ?? execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(execFileSync('git', ['-C', path, 'log', '-1', '--format=%s', head], { encoding: 'utf8' }).trim(), 'pi work', 'the Pi session produced the submitted commit');
  assert.equal(execFileSync('git', ['-C', path, 'show', `${head}:change.txt`], { encoding: 'utf8' }), 'built by pi\n');
});
