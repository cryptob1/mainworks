import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeHosts } from './helpers/fake-hosts.js';
import { readHostReadings } from '../src/hosts.js';
import { incidentsFromStatus } from '../src/model/incidents.js';

// GY-3697 AC-2: a host that answers the probe without Docker says, from one extra probe line, whether
// rootless Docker's user unit is not enabled or failed; the loop's reading carries that reason and
// Home shows the host as an incident once it has been away 5 minutes.

let hosts: Awaited<ReturnType<typeof fakeHosts>>, savedPath: string | undefined;
before(async () => {
  hosts = await fakeHosts('host-probe-docker-unit', [{ name: 'off', docker: false }, { name: 'broke', docker: false }]);
  savedPath = process.env.PATH;
  process.env.PATH = `${hosts.bin}:${process.env.PATH}`;
});
after(() => { process.env.PATH = savedPath; });

test('e2e:verification-uses-remote-hosts — a host without Docker reads away with whether its unit is not enabled or failed, and Home shows it after 5 minutes', async () => {
  await writeFile(join(hosts.host('off'), 'unit-enabled'), 'disabled\n');
  await writeFile(join(hosts.host('off'), 'unit-active'), 'inactive\n');
  await writeFile(join(hosts.host('broke'), 'unit-active'), 'failed\n');
  const file = join(hosts.root, 'hosts.json');
  await writeFile(file, JSON.stringify([{ target: 'gy-compute@off', addedAt: '2026-11-22T00:00:00Z' }, { target: 'gy-compute@broke', addedAt: '2026-11-22T00:00:00Z' }]));
  const readings = await readHostReadings([], { file, local: 'here' });
  const off = readings.find(reading => reading.host === 'gy-compute@off')!, broke = readings.find(reading => reading.host === 'gy-compute@broke')!;
  assert.equal(off.away, true);
  assert.match(off.reason!, /gy-compute@off answers but its Docker is not enabled \(docker\.service is disabled\), so it stops at reboot/);
  assert.equal(broke.away, true);
  assert.match(broke.reason!, /gy-compute@broke answers but its Docker failed \(docker\.service failed\)/);

  const now = Date.now();
  assert.deepEqual(incidentsFromStatus({ hosts: [{ ...off, since: new Date(now - 4 * 60_000).toISOString() }] }, [], now), [], 'not before 5 minutes');
  const [card] = incidentsFromStatus({ hosts: [{ ...off, since: new Date(now - 6 * 60_000).toISOString() }] }, [], now);
  assert.equal(card?.kind, 'machine-away');
});
