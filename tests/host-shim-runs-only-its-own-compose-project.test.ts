import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostPrepareScript } from '../src/hosts.js';
import { dockerCalls, dockerEveryCall, git, shardHosts, type ShardHostsFixture } from './helpers/shard-hosts.js';
import { fakeHosts } from './helpers/fake-hosts.js';

// GY-3645 AC-2: the shim's run-check starts a Compose project only for a run directory it created,
// only from the Compose file that run's commit holds, and only with binds inside the run directory.

const proof = 'unit:host-shim-runs-only-its-own-compose-project';
const run = 'trial-abcdef';
let hosts: ShardHostsFixture, repo: string;
const service = { services: { db: { image: 'postgres:16', expose: [5432] } } };
// Committed Compose files reaching the host some other way than a service's bind: each is refused with these words.
const db = (extra: Record<string, unknown>, top: Record<string, unknown> = {}) => JSON.stringify({ services: { db: { image: 'postgres:16', expose: [5432], ...extra } }, ...top });
const escapes: Record<string, string> = {
  'driver-volume': db({ volumes: [{ type: 'volume', source: 'data', target: '/data' }] }, { volumes: { data: { driver_opts: { type: 'none', device: '/home', o: 'bind' } } } }),
  'secret-file': db({ secrets: ['key'] }, { secrets: { key: { file: '/home/gy-compute/.ssh/id_ed25519' } } }),
  'config-file': db({ configs: ['conf'] }, { configs: { conf: { file: '/etc/shadow' } } }),
  'env-file': db({ env_file: [{ path: '/etc/environment', required: true }] }),
  'build': db({ build: { context: '/' } }),
  'privileged': db({ privileged: true }),
  'host-network': db({ network_mode: 'host' }),
  'provider': db({ provider: { type: 'model', options: { model: 'ai/x' } } }),
  'escape': '{"services": {"db": {"image": "postgres:16", "expose": [5432]}}, "\\u0069nclude": ["/etc/compose.yaml"]}',
  'external-network': db({}, { networks: { default: { external: true, name: 'bridge' } } }),
  'include': JSON.stringify({ include: ['/home/gy-compute/other/compose.yaml'], ...JSON.parse(db({})) }),
};
const escapeWords: Record<string, RegExp> = {
  'driver-volume': /volume data is external or set by driver options/, 'secret-file': /secret key reads from outside the run directory/,
  'config-file': /config conf reads from outside the run directory/, 'env-file': /service db reads an env file outside the run directory/,
  'build': /service db sets build/, 'privileged': /service db sets privileged/, 'host-network': /service db shares the network_mode host/,
  'provider': /service db sets provider/, 'escape': /writes a character by an escape/,
  'external-network': /network default is external or set by driver options/, 'include': /includes or extends other files/,
};

before(async () => {
  hosts = await shardHosts('host-shim-compose', ['box']);
  // A run directory as prepare-run leaves it: the commit's checkout and the image's name.
  repo = join(hosts.home('box'), '.graphyard', 'runs', run, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, '..', 'image'), 'graphyard-warm:000000000000-none');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'compose.json'), JSON.stringify(service));
  writeFileSync(join(repo, 'changed.json'), JSON.stringify(service));
  writeFileSync(join(repo, 'binds.json'), JSON.stringify({ services: { db: { image: 'postgres:16', expose: [5432], volumes: [{ type: 'bind', source: '/etc', target: '/host-etc' }] } } }));
  for (const [name, compose] of Object.entries(escapes)) writeFileSync(join(repo, `${name}.json`), compose);
  symlinkSync(join(hosts.home('box'), 'outside.json'), join(repo, 'link.json'));
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'fixture');
  // After the checkout: a Compose file the commit never held, one changed since, and the symlink's target outside the run.
  writeFileSync(join(repo, 'untracked.json'), JSON.stringify(service));
  writeFileSync(join(repo, 'changed.json'), JSON.stringify({ services: { db: { image: 'postgres:16', privileged: true } } }));
  writeFileSync(join(hosts.home('box'), 'outside.json'), JSON.stringify(service));
});
const request = (extra: Record<string, unknown> = {}) => JSON.stringify({ file: 'compose.json', services: [{ service: 'db', port: 5432 }], argv: ['true'], cpus: 1, deadline: Date.now() + 60_000, ...extra });
const shim = (command: string, input: string) => spawnSync(hosts.shim, ['--home', hosts.home('box')], { encoding: 'utf8', input,
  env: { PATH: `${join(hosts.root, 'hosts', 'box', 'bin')}:/usr/bin:/bin`, HOME: hosts.home('box'), SSH_ORIGINAL_COMMAND: command, GRAPHYARD_HOST_FLOOR_GB: '0' } });
const started = () => dockerCalls(hosts.state('box')).filter(call => call.startsWith('compose up'));

test(`${proof} — a Compose file outside the run directory, absent from the commit or changed since it, and any request beyond file, services and command, are refused before Docker runs`, () => {
  const refused: [string, string, string][] = [
    ['a path above the run directory', `run-check ${run}`, request({ file: '../../../.ssh/authorized_keys' })],
    ['an absolute path', `run-check ${run}`, request({ file: '/etc/passwd' })],
    ['a committed symlink leaving the run directory', `run-check ${run}`, request({ file: 'link.json' })],
    ['a file the commit does not hold', `run-check ${run}`, request({ file: 'untracked.json' })],
    ['a file changed since the commit', `run-check ${run}`, request({ file: 'changed.json' })],
    ['a mount', `run-check ${run}`, request({ mounts: [['/', '/host', false]] })],
    ['a network', `run-check ${run}`, request({ network: 'host' })],
    ['a service name that is no name', `run-check ${run}`, request({ services: [{ service: 'db --privileged', port: 5432 }] })],
    ['no service', `run-check ${run}`, request({ services: [] })],
    ['input that is no JSON', `run-check ${run}`, 'docker compose up'],
    ['a run named by a path', 'run-check ../../.ssh', request()],
    ['another argument', `run-check ${run} compose.json`, request()],
  ];
  const calls = dockerEveryCall(hosts.state('box')).length;
  for (const [name, command, input] of refused) {
    const result = shim(command, input);
    assert.equal(result.status, 1, `${name}: ${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, '', name);
    assert.match(result.stderr, /graphyard-host-shim refuses/, name);
  }
  assert.equal(dockerEveryCall(hosts.state('box')).length, calls, 'no Docker call was made for a refused request');
});

test(`${proof} — a run directory the shim did not create is refused, and so is a committed Compose file that reaches the host outside the run directory: a bind, a driver-option volume, a secret, config or env file, a build, a privileged, host-network or provider service, an external network, an include or an escaped key`, () => {
  const unknown = shim('run-check trial-zzzzzz', request());
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /graphyard-host-shim: no run trial-zzzzzz/);

  const binds = shim(`run-check ${run}`, request({ file: 'binds.json' }));
  assert.equal(binds.status, 1, binds.stdout);
  assert.match(binds.stderr, /graphyard-host-shim refuses: binds\.json binds \/etc, outside the run directory/);
  for (const name of Object.keys(escapes)) {
    const result = shim(`run-check ${run}`, request({ file: `${name}.json` }));
    assert.equal(result.status, 1, `${name}: ${result.stdout}`);
    assert.match(result.stderr, new RegExp(`graphyard-host-shim refuses: ${name}\\.json .*${escapeWords[name]!.source}`), name);
  }
  assert.deepEqual(started(), [], 'no project was started');
});

test(`${proof} — the commit's own Compose file runs: its services start, the command runs with their variables and the project is removed`, { timeout: 60_000 }, () => {
  const result = shim(`run-check ${run}`, request({ argv: ['/bin/sh', '-c', 'echo "db at $GRAPHYARD_SERVICE_DB_HOST:$GRAPHYARD_SERVICE_DB_PORT"; exit 7'] }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^db at db:5432$/m);
  assert.match(result.stdout, /\ngraphyard-check services \d+\ngraphyard-check command \d+\ngraphyard-check teardown \d+\ngraphyard-check exit 7\n$/, 'the command\'s exit code and each step\'s time');
  assert.deepEqual(dockerCalls(hosts.state('box')).filter(call => call.startsWith('compose')), ['compose up db', 'compose down']);
});

test(`${proof} — host prepare says the host's rootless Docker needs the Compose plugin and checks for it`, { timeout: 120_000 }, async () => {
  assert.match(hostPrepareScript('ssh-ed25519 AAAAC3NzaOperatorKey operator@vishrog'), /sudo -u "\$user" docker compose version/);
  // The prepared stand-in host has no Compose plugin: the printed script, run there, says so.
  const prepared = await fakeHosts('host-shim-compose-prepare', [{ name: 'box' }]);
  assert.match(prepared.prepareOutput('box'), /Docker Compose plugin: missing\. This host's rootless Docker needs it to run checks that declare Compose services/);
});
