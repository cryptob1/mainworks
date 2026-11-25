import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Store } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { server } from '../../src/server.js';
import { loopPanesRegistry } from '../../src/model/loop-presence.js';
import { repositoryPolicy, setRepositoryPolicy } from '../../src/model-boundary/repository-policy.js';
import { bridgeTerminals } from '../../src/master/terminal-bridge.js';
import type { SessionReader } from '../../src/master/terminal-session.js';
import type { Principal } from '../../src/model.js';
import { withDatabase } from './postgres.js';

/**
 * The real control plane e2e:master-page-terminal drives (GY-3211), forked with the stub herdr
 * first on PATH: argv is the database URL, the directory whose dist/ holds the built dashboard, and
 * optionally the port to listen on — a successor plane can take the same port a predecessor left,
 * as one URL does across a deploy. The loop has named its master pane `w1:master`, and one item
 * records a running worker session in pane `w1:worker`. Credentials: the human operator
 * (test-human-operator), a reader (test-reader) and another install's reporter (test-install-a).
 */
const [database, site, port] = process.argv.slice(2) as [string, string, string?];
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
const coordinator: Principal = { id: 'executor-a', role: 'coordinator' };
const store = database === 'new' ? await withDatabase('master_ux') : new Store(database);
if (database === 'new') await store.init();
const engine = new Engine(store, 120, 'owner/project');
engine.gitRunner = null;
const http = server(engine, [
  { ...operator, token: 'test-human-operator' } as any,
  { id: 'watcher', role: 'reader', token: 'test-reader' },
  { ...worker, token: 'test-worker' } as any,
  { ...coordinator, token: 'test-coordinator' } as any,
  // GY-3345: another install's Master, messaging this one.
  { id: 'install-a', role: 'reporter', token: 'test-install-a' },
]);
loopPanesRegistry(engine).observe({ configHome: null, session: null, host: 'host-1', running: true, master: 'w1:master' });
let item = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Watch a worker', criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['e2e:fixture'] }] }, randomUUID());
item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
await engine.execute(coordinator, 'session', item.id, { id: 'worker-1', kind: 'implementation', runtime: 'claude', host: 'host-1', workspace: 'w1', agentName: 'work-claude',
  pane: 'w1:worker', attach: 'herdr pane attach w1:worker --workspace w1', subject: `${item.key}: Watch a worker`, state: 'running', observed: 'working', observedAt: new Date().toISOString() }, randomUUID());
// The dashboard is served from ./dist, as an install serves it.
process.chdir(site);
const bridgeState = process.env.GRAPHYARD_TEST_BRIDGE_STATE;
const readSession: SessionReader | undefined = bridgeState ? async () => {
  const state = JSON.parse(await readFile(bridgeState, 'utf8'));
  const master = state.master ?? {};
  return { account: master.account ?? null, runtime: master.runtime ?? null, pane: master.pane ?? null, state: master.pane ? (state.status ?? 'idle') : 'absent', since: master.startedAt ?? null };
} : undefined;
let bridgeStopping: AbortController | undefined;
let listeningUrl = '';
const startBridge = async () => {
  if (!readSession) return;
  bridgeStopping?.abort();
  bridgeStopping = new AbortController();
  await new Promise<void>(done => bridgeTerminals(listeningUrl, 'test-coordinator', bridgeStopping!.signal, done, readSession, undefined, 50));
};
http.listen(port ? Number(port) : 0, '127.0.0.1', () => {
  listeningUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  void startBridge().then(() => process.send!({ url: listeningUrl }));
});
const sockets = new Set<import('node:stream').Duplex>();
http.on('upgrade', (req, socket) => { if (req.url?.startsWith('/api/terminal?')) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); } });
// A stop drops any live terminal socket too — an upgraded connection survives closeAllConnections, and a
// page still open would hold the server open; its terminal reconnects, as it does across a real deploy.
process.on('message', (message: any) => {
  if (message === 'drop-terminals') { for (const socket of sockets) socket.destroy(); return; }
  if (message && typeof message === 'object' && message.type === 'reset') {
    for (const socket of sockets) socket.destroy();
    process.env.HERDR_STUB_LOG = String(message.logFile);
    void startBridge().then(() => process.send!({ reset: true }));
    return;
  }
  bridgeStopping?.abort();
  for (const socket of sockets) socket.destroy();
  http.close(() => { void store.close().finally(() => process.exit(0)); }); http.closeAllConnections();
});
