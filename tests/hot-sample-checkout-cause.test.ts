import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shardHosts } from './helpers/shard-hosts.js';
import { freePort } from './helpers/http-server.js';

// GY-3992: why check-runs-on-host-after-one-hot-sample failed its merge trials with "[step] checkout took 0s"
// (the first line of the inner trial's log; the failing line was "postgres:PORT accepted no TCP connection in time").
// The stand-in Docker resolved a check's service names (postgres) to this machine through HOSTALIASES, which glibc
// applies only inside its DNS lookup. A remote shard runs with --network=none and has no resolver, so the name never
// resolved (EAI_AGAIN) and the check waited out its 120 s. This runs the stand-in's services and a check container
// joined to them in a network namespace of their own, with loopback up and no resolver, as a shard has.

const proof = 'integration:hot-sample-checkout-cause';
const image = 'mainworks-trial:gy-3992-cause';
// The stand-in's own way to bring loopback up in a new network namespace, then run the rest of argv.
const loUp = "import ctypes, fcntl, os, socket, struct, sys; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); fcntl.ioctl(s, 0x8914, struct.pack('16sH', b'lo', 1)); s.close(); ctypes.CDLL(None).prctl(47, 4, 0, 0, 0); os.execvp(sys.argv[1], sys.argv[1:])";

test(`${proof} — a check container joined to its services reaches them by service name on a host with no DNS resolver`, { timeout: 60_000 }, async () => {
  const hosts = await shardHosts('gy-3992-cause', ['box'], {});
  const docker = join(hosts.root, 'hosts', 'box', 'bin', 'docker'), port = await freePort();
  await mkdir(hosts.state('box'), { recursive: true });
  await writeFile(join(hosts.state('box'), 'state.json'), JSON.stringify({ images: { [image]: `sha256:${'3992'.repeat(16)}` }, containers: {} }));
  await writeFile(join(hosts.root, 'compose.json'), JSON.stringify({ services: { postgres: { image: 'postgres:16', expose: [port] } } }));
  await writeFile(join(hosts.root, 'connect.mjs'), `import { connect } from 'node:net';
const end = Date.now() + 5000;
const attempt = () => connect({ host: 'postgres', port: ${port} }).once('connect', () => { console.log('postgres answered'); process.exit(0); })
  .once('error', error => { if (Date.now() > end) { console.error('no postgres: ' + error.code); process.exit(1); } setTimeout(attempt, 100); });
attempt();
`);
  const script = `set -e
cd ${JSON.stringify(hosts.root)}
${JSON.stringify(docker)} compose -p proj -f compose.json up -d --quiet-pull postgres
${JSON.stringify(docker)} create --name check --network=container:proj.postgres --workdir ${JSON.stringify(hosts.root)} --env PATH=/usr/bin:/bin --entrypoint ${JSON.stringify(process.execPath)} ${image} connect.mjs
status=0; ${JSON.stringify(docker)} start check || status=$?
${JSON.stringify(docker)} compose -p proj -f compose.json down
exit $status
`;
  await writeFile(join(hosts.root, 'run.sh'), script);
  const run = spawnSync('unshare', ['-cn', '--keep-caps', 'python3', '-c', loUp, 'sh', join(hosts.root, 'run.sh')], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.error, undefined, String(run.error));
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /postgres answered/);
});
