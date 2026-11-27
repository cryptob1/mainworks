import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeHosts } from './helpers/fake-hosts.js';
import { main } from '../src/cli/index.js';
import { readHostReadings } from '../src/hosts.js';
import { encodeLoopHosts, loopHosts } from '../src/model/loop-presence.js';
import WorkersPage from '../web/pages/workers.js';

// GY-4008 AC-1: on a machine with intel_pstate/no_turbo or cpufreq/boost, the prepare script host add runs
// asks whether to keep turbo or boost off across reboots. Yes installs a boot unit that writes the sysfs
// file; no changes nothing. host list and the Workers page show whether it is off; docs/reference.md names it (docs/install.md was folded into it by GY-3109).

const proof = 'integration:host-keeps-boost-off';
let hosts: Awaited<ReturnType<typeof fakeHosts>>, config: string;
const saved = { PATH: process.env.PATH, GRAPHYARD_CONFIG_HOME: process.env.GRAPHYARD_CONFIG_HOME, GRAPHYARD_CPU_SYSFS: process.env.GRAPHYARD_CPU_SYSFS };
const cpu = (name: string) => join(hosts.host(name), 'sys-cpu');
const unit = (name: string) => join(hosts.host(name), 'etc', 'systemd', 'system', 'graphyard-turbo-off.service');

before(async () => {
  hosts = await fakeHosts('host-keeps-boost-off', [{ name: 'intel' }, { name: 'amd' }, { name: 'plain' }]);
  config = join(hosts.root, 'config');
  Object.assign(process.env, { PATH: `${hosts.bin}:${saved.PATH}`, GRAPHYARD_CONFIG_HOME: config });
});
after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });

/** Run the prepare script on a host whose CPU sysfs is the fixture's, answering the question with `input`. */
const prepare = async (name: string, input: string) => {
  process.env.GRAPHYARD_CPU_SYSFS = cpu(name);
  try { return await hosts.prepare(name, { input }); } finally { delete process.env.GRAPHYARD_CPU_SYSFS; }
};
/** What the boot unit runs at boot, run once as boot would. */
const boot = async (name: string) => {
  const command = /^ExecStart=\/bin\/sh -c '(.*)'$/m.exec(await readFile(unit(name), 'utf8'))?.[1];
  assert.ok(command, 'the unit writes the sysfs file at boot');
  execFileSync('sh', ['-c', command]);
};

test(`${proof} — declining changes nothing; accepting installs a boot unit that keeps turbo or boost off; host list and Workers show it`, { timeout: 120_000 }, async () => {
  await mkdir(join(cpu('intel'), 'intel_pstate'), { recursive: true });
  await writeFile(join(cpu('intel'), 'intel_pstate', 'no_turbo'), '0\n');
  await mkdir(join(cpu('amd'), 'cpufreq'), { recursive: true });
  await writeFile(join(cpu('amd'), 'cpufreq', 'boost'), '1\n');

  // Declining: the question is asked, nothing is installed, the value is untouched.
  const declined = await prepare('intel', 'n\n');
  assert.match(declined, /Turbo comes back on at every reboot\. Keep it off, so shared builds run cooler\? \[y\/N\]/);
  assert.match(declined, /Turbo: left as it is/);
  assert.equal(existsSync(unit('intel')), false, 'declining installs no unit');
  assert.equal(await readFile(join(cpu('intel'), 'intel_pstate', 'no_turbo'), 'utf8'), '0\n');

  // A CPU with neither file is not asked.
  const plain = await prepare('plain', 'y\n');
  assert.doesNotMatch(plain, /Turbo|Boost/);
  assert.equal(existsSync(unit('plain')), false);

  // Accepting: a boot unit writes 1 to no_turbo (0 to boost) and is enabled now.
  const accepted = await prepare('intel', 'y\n');
  assert.match(accepted, /Turbo: off now and at every boot/);
  assert.match(await readFile(join(hosts.host('intel'), 'log'), 'utf8'), /systemctl enable --now graphyard-turbo-off/);
  await boot('intel');
  assert.equal((await readFile(join(cpu('intel'), 'intel_pstate', 'no_turbo'), 'utf8')).trim(), '1');
  assert.match(await prepare('amd', 'y\n'), /Boost: off now and at every boot/);
  await boot('amd');
  assert.equal((await readFile(join(cpu('amd'), 'cpufreq', 'boost'), 'utf8')).trim(), '0');
  // Again: no second question.
  assert.match(await prepare('intel', ''), /Turbo: kept off at every boot/);

  // host list and the Workers page show it, read through each host's helper.
  for (const name of ['intel', 'amd', 'plain']) await main(['host', 'add', `gy-compute@${name}`]);
  process.env.GRAPHYARD_CPU_SYSFS = cpu('intel');
  const lines: string[] = [], log = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
  try { await main(['host', 'list']); } finally { console.log = log; }
  assert.match(lines.join('\n'), /^gy-compute@intel {2}added \S+, turbo off$/m);

  const readings = await readHostReadings([], { local: 'here' });
  const intel = readings.find(reading => reading.host === 'gy-compute@intel')!;
  assert.equal(intel.turboOff, true);
  delete process.env.GRAPHYARD_CPU_SYSFS;
  const page = renderToStaticMarkup(createElement(WorkersPage, { work: [], observedAt: new Date().toISOString(), setSelected: () => {}, setView: () => {}, token: 'fixture',
    status: { hosts: loopHosts(encodeLoopHosts([intel, { ...intel, host: 'gy-compute@amd', turboOff: false }, { host: 'gy-compute@plain', away: false, cores: 2, celsius: null, steal: null, runs: 0 }])) } } as never));
  assert.match(page, /data-host="gy-compute@intel"[^]*?data-host-turbo="true">Turbo off</);
  assert.match(page, /data-host="gy-compute@amd"[^]*?data-host-turbo="true">Turbo on</);
  assert.doesNotMatch(/data-host="gy-compute@plain"[^]*$/.exec(page)![0], /data-host-turbo/);
});

test(`${proof} — the compute machines docs name keeping turbo or boost off across reboots`, async () => {
  const docs = await readFile('docs/reference.md', 'utf8');
  assert.match(/^## Compute machines\n[^]*?(?=\n## )/m.exec(docs)?.[0] ?? '', /keep turbo or boost off across reboots/);
});
