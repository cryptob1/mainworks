import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Engine } from '../../src/engine.js';
import { server } from '../../src/server.js';
import { syncTeamAccess } from '../../src/master/team-access.js';
import { fakeTailscale, onPath } from './fake-tailscale.js';
import { withDatabase } from './postgres.js';
import { temporaryDirectory } from './temp-dirs.js';
import { listen } from './http-server.js';

// GY-3480: a machine whose Tailscale serves the install over HTTPS on another port (:8447 → the
// server's loopback port), with a machine directory written before GY-3294 recorded the node. The
// host loop reads both from the tailscale command, so Setup and invites carry the served https address.
export const servedNode = { ID: 'nVISHROG1CNTRL', DNSName: 'vishrog.tail3739e3.ts.net.', TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'], Online: true };
export const servedUrl = 'https://vishrog.tail3739e3.ts.net:8447';

/** One control plane, its loop credential and a host whose `tailscale` serves it on :8447 over HTTPS; Funnel is refused unless FUNNEL (GY-3514). */
export async function servedInstall(label: string, options: { funnel?: boolean; clock?: () => number; principals?: Parameters<typeof server>[1] } = {}) {
  const host = await temporaryDirectory(label), machineDir = join(host, 'machine');
  await mkdir(machineDir);
  if (!options.funnel) await writeFile(join(host, 'funnel-refused'), '');
  await writeFile(join(machineDir, 'tailnet.json'), '{}\n');
  const store = await withDatabase(label);
  await store.init();
  const engine = new Engine(store, 120, `owner/${label}`);
  engine.gitRunner = null;
  const operator = `test-operator-${label}`, loop = `test-loop-coordinator-${label}-credential-0123456789`, credentialFile = join(host, 'loop.token');
  await writeFile(credentialFile, loop, { mode: 0o600 });
  const { server: http, port, url: base, close } = await listen(server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: operator }, { id: 'loop', role: 'coordinator', token: loop }, ...options.principals ?? []], options.clock ? { clock: options.clock } : {}));
  const restorePath = onPath(await fakeTailscale(host, servedNode));
  const serve = (mapping: Record<string, string>) => writeFile(join(host, 'served-https.json'), JSON.stringify(mapping));
  await serve({ 8447: base });
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${operator}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  return {
    port, base, operator, call, serve, host, engine, store, http, loop,
    sync: (now?: number) => syncTeamAccess({ url: base, credentialFile }, { machineDir, now }),
    close: async () => { restorePath(); await close(); await store.close(); },
  };
}
