import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { hostShimScript } from '../src/host-shim.js';
import { parseHostProbe, readHostReadings } from '../src/hosts.js';
import { heatRereadDelayMs, readShardHosts, rereadHotHosts, underHeatLimit, type HostReading } from '../src/merge-writer/remote-shards.js';
import { trialHotCelsius } from '../src/merge-writer/trial-load.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { fixtureShim, shardHosts } from './helpers/shard-hosts.js';

// GY-3948 AC-1: a host's heat for placement is smoothed (median of >=5 samples over ~2s in probe),
// hot hosts with free cores are re-read once after 10s before fallback, and installed older helpers
// keep working unchanged.

const proof = 'unit:host-heat-is-smoothed-and-reread';

const host = (name: string, celsius: number | null, extra: Partial<HostReading> = {}): HostReading => ({
  name,
  cores: 24,
  busy: 2,
  steal: 0,
  celsius,
  limit: trialHotCelsius,
  away: false,
  compose: true,
  ...extra,
});

test(`${proof} — a smoothed 88 is re-read and the second read decides`, async () => {
  const smoothed = 88;

  // Second read cool -> host is used.
  let sleptMs: number | null = null;
  let reads = 0;
  const coolSecond = await rereadHotHosts(
    [host('gy-compute@vish-msi', smoothed)],
    async targets => {
      reads++;
      assert.deepEqual(targets, ['gy-compute@vish-msi']);
      return [host('gy-compute@vish-msi', 72)];
    },
    { sleep: async ms => { sleptMs = ms; } },
  );
  assert.equal(sleptMs, heatRereadDelayMs);
  assert.equal(reads, 1);
  assert.equal(underHeatLimit(coolSecond[0]!), true);
  assert.equal(coolSecond[0]!.celsius, 72);

  // Second read hot -> host is skipped with reason naming both values.
  const hotSecond = await rereadHotHosts(
    [host('gy-compute@vish-msi', smoothed)],
    async () => [host('gy-compute@vish-msi', 90)],
    { sleep: async () => {} },
  );
  assert.equal(underHeatLimit(hotSecond[0]!), false);
  assert.match(hotSecond[0]!.reason ?? '', /88.*90/);
});

test(`${proof} — a host at 70 is used at once without a second read`, async () => {
  let slept = false;
  let reads = 0;
  const result = await rereadHotHosts(
    [host('gy-compute@vish-msi', 70)],
    async () => { reads++; return [host('gy-compute@vish-msi', 70)]; },
    { sleep: async () => { slept = true; } },
  );
  assert.equal(slept, false);
  assert.equal(reads, 0);
  assert.equal(underHeatLimit(result[0]!), true);
  assert.equal(result[0]!.celsius, 70);
});

test(`${proof} — a host at 95 and 96 on both reads is skipped with both values in the reason`, async () => {
  let reads = 0;
  const result = await rereadHotHosts(
    [host('gy-compute@vish-msi', 95)],
    async () => { reads++; return [host('gy-compute@vish-msi', 96)]; },
    { sleep: async () => {} },
  );
  assert.equal(reads, 1);
  assert.equal(underHeatLimit(result[0]!), false);
  assert.match(result[0]!.reason ?? '', /too hot/);
  assert.match(result[0]!.reason ?? '', /95/);
  assert.match(result[0]!.reason ?? '', /96/);
});

test(`${proof} — a hot host with no free cores is skipped without waiting for a second read`, async () => {
  let slept = false;
  let reads = 0;
  const result = await rereadHotHosts(
    [host('gy-compute@vish-msi', 95, { cores: 8, busy: 8 })],
    async () => { reads++; return [host('gy-compute@vish-msi', 70)]; },
    { sleep: async () => { slept = true; } },
  );
  assert.equal(slept, false);
  assert.equal(reads, 0);
  assert.equal(underHeatLimit(result[0]!), false);
});

test(`${proof} — parseHostProbe uses temp-median when present and falls back to temp lines for older helpers`, () => {
  const modernOutput = [
    'cores 24',
    'load 2.50',
    'cpu  100 0 50 900 0 0 0 0 0 0',
    'temp coretemp 96000',
    'temp coretemp 69000',
    'temp-median 88',
    'runs 0',
  ].join('\n');
  assert.equal(parseHostProbe(modernOutput)?.celsius, 88);

  const olderOutput = [
    'cores 24',
    'load 2.50',
    'cpu  100 0 50 900 0 0 0 0 0 0',
    'temp coretemp 74000',
    'temp coretemp 79000',
    'runs 0',
  ].join('\n');
  assert.equal(parseHostProbe(olderOutput)?.celsius, 79);
});

test(`${proof} — installed live helper versions (update-shim:2/receive-image:3/run-shard:2 and oldest verb set) keep working unchanged alongside the new probe`, async () => {
  const fixture = await shardHosts('gy-3948-compat', ['current', 'modern', 'oldest']);
  const hwmon = join(fixture.root, 'hwmon', 'hwmon0');
  await mkdir(hwmon, { recursive: true });
  await writeFile(join(hwmon, 'name'), 'coretemp\n');
  await writeFile(join(hwmon, 'temp1_input'), '74000\n');

  const liveModernVerbs = 'probe:1 receive-pack:1 receive-image:3 prepare-run:2 run-shard:2 fetch-records:1 clean:1 run-session:1 update-shim:2 share:1';
  const liveOldestVerbs = 'probe:1 receive-pack:1 receive-image:1 prepare-run:1 run-shard:2 fetch-records:1 clean:1';

  const legacyTempLine = `    for d in ${fixture.root}/hwmon/hwmon*; do n=$(cat "$d/name" 2>/dev/null); for t in "$d"/temp*_input; do [ -r "$t" ] && echo "temp $n $(cat "$t")"; done; done`;
  const makeOlderShim = (verbs: string, digestChar: string) => fixtureShim(hostShimScript, fixture.root)
    .replace(/^    echo "shim [0-9a-f]{64}"$/m, `    echo "shim ${digestChar.repeat(64)}"`)
    .replace(/^    echo "verbs .*"$/m, `    echo "verbs ${verbs}"`)
    .replace(/^    .*temp-median.*$/gm, legacyTempLine);

  const modernShim = join(fixture.root, 'shim-modern');
  const oldestShim = join(fixture.root, 'shim-oldest');
  await writeFile(modernShim, makeOlderShim(liveModernVerbs, 'a'));
  await writeFile(oldestShim, makeOlderShim(liveOldestVerbs, 'b'));
  await chmod(modernShim, 0o755);
  await chmod(oldestShim, 0o755);

  await writeFile(join(fixture.bin, 'ssh'), `#!/bin/sh
if [ "$1" = -G ]; then exec /usr/bin/ssh "$@"; fi
for arg; do case "$arg" in -fNM|-O) exit 0;; esac; done
for last; do :; done
for arg; do case "$arg" in *@*) target="$arg";; esac; done
host="\${target#*@}"; dir="${fixture.root}/hosts/$host"
if [ ! -d "$dir" ] || [ -e "$dir.down" ]; then echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255; fi
cd "$dir/home" && export HOME="$dir/home" PATH="$dir/bin:/usr/bin:/bin" GRAPHYARD_HOST_FLOOR_GB=0 GRAPHYARD_PROBE_SAMPLE_SECONDS=0.01
case "$host" in
  modern) shim="${modernShim}" ;;
  oldest) shim="${oldestShim}" ;;
  *) shim="${fixture.shim}" ;;
esac
SSH_ORIGINAL_COMMAND="$last" exec "$shim"
`);
  await chmod(join(fixture.bin, 'ssh'), 0o755);

  const hostsJson = join(await temporaryDirectory('gy-3948-hosts-file'), 'hosts.json');
  await writeFile(hostsJson, JSON.stringify([
    { target: 'gy-compute@current', addedAt: '2026-11-26T00:00:00.000Z' },
    { target: 'gy-compute@modern', addedAt: '2026-11-26T00:00:00.000Z' },
    { target: 'gy-compute@oldest', addedAt: '2026-11-26T00:00:00.000Z' },
  ]));

  const run: ChildRun = (command, args, options) => defaultChildRun(command, args, {
    ...options,
    env: { ...process.env, ...options?.env, PATH: `${fixture.bin}:${process.env.PATH}` },
  });

  // Verify the current shim emits temp-median and all three helpers stay ready with celsius 74.
  const currentOut = String(await run('ssh', ['gy-compute@current', 'probe']));
  assert.match(currentOut, /^temp-median 74$/m, currentOut);

  const loopReadings = await readHostReadings([], { file: hostsJson, run, local: 'coordinator' });
  for (const name of ['gy-compute@current', 'gy-compute@modern', 'gy-compute@oldest']) {
    const entry = loopReadings.find(r => r.host === name);
    assert.ok(entry, `missing ${name}`);
    assert.equal(entry.away, false, `${name}: ${entry.reason}`);
    assert.equal(entry.celsius, 74, `${name}: ${JSON.stringify(entry)}`);
  }

  const trialReadings = await readShardHosts(['gy-compute@current', 'gy-compute@modern', 'gy-compute@oldest'], run, 2);
  for (const name of ['gy-compute@current', 'gy-compute@modern', 'gy-compute@oldest']) {
    const entry = trialReadings.find(r => r.name === name);
    assert.ok(entry, `missing ${name}`);
    assert.equal(entry.away, false, `${name}: ${entry.reason}`);
    assert.equal(entry.celsius, 74, `${name}: ${JSON.stringify(entry)}`);
  }
});
