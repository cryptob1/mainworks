import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { server, assembleServices } from '../../src/server/index.js';
import { requestHumanDecision } from '../../src/server/waits.js';
import { ProductionWatch, INCIDENT_EVENT } from '../../src/production-watch.js';
import { loopPanesRegistry } from '../../src/model/loop-presence.js';
import { proposedRuntimes } from '../../src/model/registry-proposal.js';
import { terminalInputEvent } from '../../src/server/terminal.js';
import type { Principal } from '../../src/model.js';

/**
 * The real control plane e2e:lead-conversation drives (GY-3602), forked with the stub herdr first on
 * PATH: argv is the database URL and the directory whose dist/ holds the built dashboard. The world
 * holds two typed messages, an open spend approval, a priority decision, a worker-role pause, a
 * message to a builder, two filed items and an open deployment incident. Credentials: the human
 * operator (test-human-operator), a worker (test-worker), the loop's coordinator
 * (test-coordinator), another install's reporter (test-install-a), a Watch-role viewer (test-watch)
 * and a Steer-role maintainer (test-steer).
 */
const [database, site] = process.argv.slice(2) as [string, string];
const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
const coordinator: Principal = { id: 'executor-a', role: 'coordinator' };
const store = new Store(database);
const engine = new Engine(store, 120, 'owner/project');
engine.gitRunner = null;
const watch = new ProductionWatch(store, { provider: null, build: { commit: 'leadconversationbuild', protocol: 1, source: null }, baseBranch: 'main' });
const credentials = [
  { ...operator, token: 'test-human-operator' } as any,
  { id: 'watcher', role: 'reader', team: 'viewer', displayName: 'Watcher', token: 'test-watch' },
  { id: 'steerer', role: 'reader', team: 'maintainer', displayName: 'Steerer', token: 'test-steer' },
  { ...worker, token: 'test-worker' } as any,
  { ...coordinator, token: 'test-coordinator' } as any,
  { id: 'install-a', role: 'reporter', token: 'test-install-a' },
];
const services = assembleServices(engine, credentials, { production: watch });
loopPanesRegistry(engine).observe({ configHome: null, session: null, host: 'host-1', running: true, master: 'w1:master' });

const iso = (at: number) => new Date(at).toISOString();
const start = Date.now();
const create = async (title: string, priority: number) => {
  let item = await engine.execute(operator, 'create', null, { type: 'chore', title, priority, criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['e2e:fixture'] }] }, randomUUID());
  item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  return item!;
};
const watchItem = await create('Watch a worker', 1);
const fixItem = await create('Fix the flaky release check', 2);
await engine.execute(worker, 'claim', watchItem.id, {}, randomUUID());

// The conversation's own records, in the order the feed must show them: a typed message from the
// operator, the open deployment incident, then (by their own instants) the filed items, the spend
// approval, the priority decision, the pause, the Lead's message to a builder, and a typed message
// from the maintainer.
const insert = async (actor: string, kind: string, payload: unknown, at: number, workId: string | null = null) =>
  store.pool.query('INSERT INTO events(work_id,actor,kind,payload,created_at) VALUES($1,$2,$3,$4,$5)', [workId, actor, kind, JSON.stringify(payload), iso(at)]);
await insert('operator', terminalInputEvent, { pane: 'w1:master', line: 'Why has nothing gone live since this afternoon?' }, start - 90_000);
await insert('graphyard', INCIDENT_EVENT, { incident: { id: randomUUID(), workId: fixItem.id, key: fixItem.key, mergeSha: 'f'.repeat(40), status: 'missing', provider: null, deploymentId: null, serving: 'leadconversationbuild', reason: `merged 2h ago and still not served: ${fixItem.key}'s change waits at Deploy`, since: iso(start - 60_000), at: iso(start - 60_000) } }, start - 60_000, fixItem.id);
await requestHumanDecision(services, worker, watchItem.id, {
  epoch: 1, kind: 'money-or-accounts',
  reason: `Two builders idle while the release fix waits: ${fixItem.key} needs a second seat to land inside the hour`,
  needed: 'Two more agent seats on the current plan, about 40 dollars a month',
  ask: 'Approve 2 more agent seats so more builders can work — same plan, 2 more seats.',
  why: 'The release fix ships an hour earlier with a second builder on it.',
  recommendation: 'Approve 2 more seats',
  choices: [{ id: 'approve-2', label: 'Approve 2 more seats', outcome: 'provided', input: 'none' }, { id: 'approve-other', label: 'Approve a different number…', outcome: 'provided', input: 'text' }, { id: 'keep-9', label: 'Keep 9 accounts', outcome: 'declined', input: 'none' }],
}, randomUUID());
await engine.execute(operator, 'priority', fixItem.id, { priority: 0, reason: 'the release fix outranks new pages.' }, randomUUID());
await services.agentRegistry.mutate(operator, 'apply', { runtimes: [proposedRuntimes.find(runtime => runtime.name === 'claude')!], models: [{ name: 'opus', id: 'claude-opus-5' }], accounts: [{ name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host: 'host-1', home: '/home/agent/.claude' } }], roles: [{ name: 'worker', accounts: ['claude-a'], concurrency: 2 }], reason: 'The fleet at the start of the run' }, randomUUID());
await services.agentRegistry.mutate(operator, 'role.set', { role: { name: 'worker', accounts: ['claude-a'], concurrency: 0 }, reason: 'No new builders until the spend approval is answered' }, randomUUID());
await engine.execute(operator, 'message', watchItem.id, { text: 'Priority stays on the release fix until it is live.' }, randomUUID());
await insert('steerer', terminalInputEvent, { pane: 'w1:master', line: 'The staging deploy looks fine from here.' }, Date.now() + 1_500);
await insert('install-a', 'master.message', { text: 'Cross-install note for the Lead conversation.', thread: 'from-install-a' }, Date.now());
await store.pool.query("INSERT INTO team_members(name, team, invited_by, invited_at) VALUES('steerer','maintainer','operator',now())");

// The Lead pane's stub state: working for the last four minutes (the status line's words and age).
await writeFile(join(site, 'master.daemon.json'), JSON.stringify({
  master: { agentName: 'master', pane: 'w1:master', account: 'master-agent', runtime: 'claude' },
  status: 'working', since: iso(Date.now() - 4 * 60_000),
}));
await watch.load();
// The dashboard is served from ./dist, as an install serves it.
process.chdir(site);
const http = server(engine, credentials, { production: watch });
// Upgraded connections survive closeAllConnections; a page still open must not hold the server open.
const sockets = new Set<import('node:stream').Duplex>();
http.on('upgrade', (request, socket) => { if (request.url?.startsWith('/api/terminal')) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); } });
http.listen(0, '127.0.0.1', () => process.send!({ url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, items: { watch: watchItem.id, fix: fixItem.id, fixKey: fixItem.key } }));
process.on('message', message => { if (message !== 'stop') return; console.log('[lead-conversation-server] stop received'); for (const socket of sockets) socket.destroy(); http.closeAllConnections(); http.close(() => { void store.close().finally(() => process.exit(0)); }); });
