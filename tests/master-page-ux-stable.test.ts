import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { loopPanesRegistry } from '../src/model/loop-presence.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { bridgeTerminals } from '../src/master/terminal-bridge.js';
import type { SessionReader, TerminalStream, terminalStream } from '../src/master/terminal-session.js';
import type { Principal } from '../src/model.js';
import { withDatabase } from './helpers/postgres.js';
import { ensureDashboardBuilt, runTests } from './helpers/run-tests.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { lifecycle } from './helpers/work-lifecycle.js';

const workers = 4;
const thousandLines = Array.from({ length: 1000 }, (_, i) => `earlier line ${String(i).padStart(4, '0')}\n`).join('');
const initialMaster = () => ({ master: { agentName: 'master', pane: 'w1:master', account: 'test-account', runtime: 'codex' }, status: 'idle', gap: '' });

/**
 * In-process equivalent of fixtures/herdr-terminal-stub/herdr.cjs (GY-3856): produces the exact
 * same scrollback, session headers, live frames, resize and input echo/logging without spawning
 * ~240 Node.js subprocesses across 40 test runs under trial CPU contention.
 */
function inProcessHerdrStream(stateFile: string, getLogFile: () => string): typeof terminalStream {
  return (request, handlers, session, _instance, refreshMs = 1_000): TerminalStream => {
    let stopped = false, previous = '', pane: string | null | undefined, activePane: string | null = null;
    let cols = Number(request.cols) || 80, rows = Number(request.rows) || 24;
    const mode = request.control ? 'control' : 'observe';
    const pendingInput: unknown[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const log = (entry: unknown) => { const file = getLogFile(); if (file) appendFileSync(file, `${JSON.stringify(entry)}\n`); };
    const emit = (value: unknown) => { if (!stopped) handlers.line(JSON.stringify(value)); };
    const frame = (text: string) => emit({ type: 'terminal.frame', seq: 0, encoding: 'ansi', width: cols, height: rows, full: false, bytes: Buffer.from(text).toString('base64') });
    const readState = async () => { try { return JSON.parse(await readFile(stateFile, 'utf8')); } catch { return {}; } };
    const handleCommand = (command: any) => {
      if (!activePane || stopped) return;
      log({ mode, pane: activePane, command });
      if (command.type === 'terminal.input') frame(String(command.text).replace(/\r/g, '\r\n'));
      if (command.type === 'terminal.resize' && mode !== 'observe') { cols = Number(command.cols); rows = Number(command.rows); log({ pane: activePane, size: { cols, rows } }); }
      if (command.type === 'terminal.release') { stopped = true; clearTimeout(timer); }
    };
    const refresh = async () => {
      try {
        const current = request.master && session ? await session() : { pane: request.pane, account: null, runtime: null, state: request.pane ? 'unknown' : 'absent' };
        if (stopped) return;
        const serialized = JSON.stringify(current);
        if (serialized !== previous) { emit({ type: previous ? 'session' : 'hello', session: current, pane: current.pane, mode }); previous = serialized; }
        if (pane !== current.pane) {
          pendingInput.length = 0;
          if (activePane) { log({ mode, pane: activePane, detached: true }); activePane = null; }
          pane = current.pane;
          if (pane) {
            const state = await readState();
            if (stopped) return;
            log({ args: ['pane', 'read', pane, '--source', 'recent', '--lines', '1000', '--ansi'] });
            emit({ type: 'scrollback', data: state.gap ? `${thousandLines}${state.gap}\r\n` : thousandLines });
            activePane = pane;
            log({ args: ['terminal', 'session', mode, pane, '--cols', String(cols), '--rows', String(rows)] });
            const master = state.master ?? { account: 'master-agent', runtime: 'claude', agentName: 'master' };
            emit({ type: 'session', session: { pane, account: master.account ?? null, runtime: master.runtime ?? null, state: state.status ?? 'working', since: state.since ?? null } });
            frame(`\x1b[?2004hscreen of ${pane}\r\n`);
            for (const command of pendingInput.splice(0)) handleCommand(command);
          }
        }
      } catch (error) { if (!stopped) handlers.exit(error instanceof Error ? error.message : String(error)); }
      if (!stopped && request.master) timer = setTimeout(refresh, refreshMs);
    };
    void refresh();
    return {
      send: (command: any) => {
        if (command.type === 'terminal.resize') { cols = Number(command.cols); rows = Number(command.rows); }
        if (activePane) handleCommand(command);
        else if (pane && !stopped && command.type === 'terminal.input') pendingInput.push(command);
      },
      end: () => {
        stopped = true;
        clearTimeout(timer);
        if (activePane) { log({ mode, pane: activePane, detached: true }); activePane = null; }
        return Promise.resolve();
      },
    };
  };
}

/**
 * GY-3856: start one shared Postgres database + Engine and `count` isolated HTTP/bridge slots
 * in-process so 8 Playwright workers do not each fork `tsx` and migrate their own database.
 */
async function startSharedMasterUxServers(count: number) {
  setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
  const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
  const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
  const coordinator: Principal = { id: 'executor-a', role: 'coordinator' };
  const store: Store = await withDatabase('master_ux');
  await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  loopPanesRegistry(engine).observe({ configHome: null, session: null, host: 'host-1', running: true, master: 'w1:master' });
  let item = await lifecycle(engine, operator, { type: 'chore', title: 'Watch a worker', criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['e2e:fixture'] }] }, { claim: worker });
  await engine.execute(coordinator, 'session', item.id, { id: 'worker-1', kind: 'implementation', runtime: 'claude', host: 'host-1', workspace: 'w1', agentName: 'work-claude',
    pane: 'w1:worker', attach: 'herdr pane attach w1:worker --workspace w1', subject: `${item.key}: Watch a worker`, state: 'running', observed: 'working', observedAt: new Date().toISOString() }, randomUUID());

  const principals = [
    { ...operator, token: 'test-human-operator' } as any,
    { id: 'watcher', role: 'reader', team: 'viewer', token: 'test-reader' } as any,
    { ...worker, token: 'test-worker' } as any,
    { ...coordinator, token: 'test-coordinator' } as any,
    { id: 'install-a', role: 'reporter', token: 'test-install-a' },
  ];

  interface Slot { site: string; url: string; http: Server; sockets: Set<Duplex>; stopBridge(): void; reset(logFile: string): Promise<void>; dropTerminals(): void }
  const slots: Slot[] = [];
  for (let index = 0; index < count; index++) {
    const site = await temporaryDirectory(`master-ux-s${index}`);
    const stateFile = join(site, 'master.daemon.json');
    await writeFile(stateFile, JSON.stringify(initialMaster()));
    let logFile = join(site, 'herdr-0.log');
    const http = server(engine, principals);
    const sockets = new Set<Duplex>();
    http.on('upgrade', (req, socket) => { if (req.url?.startsWith('/api/terminal?')) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); } });
    await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const readSession: SessionReader = async () => {
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      const master = state.master ?? {};
      return { account: master.account ?? null, runtime: master.runtime ?? null, pane: master.pane ?? null, state: master.pane ? (state.status ?? 'idle') : 'absent', since: master.startedAt ?? null };
    };
    const openStream = inProcessHerdrStream(stateFile, () => logFile);
    let bridgeStopping: AbortController | undefined;
    const startBridge = async () => {
      bridgeStopping?.abort();
      bridgeStopping = new AbortController();
      await new Promise<void>(done => bridgeTerminals(url, 'test-coordinator', bridgeStopping!.signal, done, readSession, undefined, 50, openStream));
    };
    await startBridge();
    slots.push({
      site, url, http, sockets,
      stopBridge: () => { bridgeStopping?.abort(); },
      dropTerminals: () => { for (const socket of sockets) socket.destroy(); },
      reset: async (nextLogFile: string) => {
        for (const socket of sockets) socket.destroy();
        logFile = nextLogFile;
        await startBridge();
      },
    });
  }

  const control = createServer(async (req, res) => {
    const match = req.url?.match(/^\/slot\/(\d+)\/(reset|drop-terminals)$/);
    const slot = match ? slots[Number(match[1])] : undefined;
    if (!match || !slot || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (match[2] === 'drop-terminals') slot.dropTerminals();
    else await slot.reset(String(JSON.parse(raw).logFile));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
  });
  await new Promise<void>(done => control.listen(0, '127.0.0.1', done));
  const controlUrl = `http://127.0.0.1:${(control.address() as { port: number }).port}`;

  return {
    config: JSON.stringify({ controlUrl, slots: slots.map(({ site, url }) => ({ site, url })) }),
    close: async () => {
      await new Promise<void>(done => { control.close(() => done()); control.closeAllConnections(); });
      for (const slot of slots) {
        slot.stopBridge();
        slot.dropTerminals();
        await new Promise<void>(done => { slot.http.close(() => done()); slot.http.closeAllConnections(); });
      }
      await store.close();
    },
  };
}

// GY-3731: e2e:master-page-ux failed merge trials and batch gates on changes that never touched the
// Lead page: "Expected: ArrayContaining [...] Received: []" at the native-input step — no typed key
// reached the pane. The pane mounts hidden under the Conversation tab; when its hello lands before
// the spec switches to #master/live, its focus() finds a hidden element and the keys go to the page
// body. The spec now focuses the pane as a user does and waits for it. This proof runs the spec 20
// times across 4 workers; any failing run fails it.
test('unit:master-page-ux-stable — master-page-ux passes 20 of 20 runs on 4 workers', async () => {
  // Reuse the already-built dashboard bundle, skip the unused vite preview server (GY-3818), and
  // share one started Postgres/Engine server with in-process terminal streams across workers (GY-3856).
  await ensureDashboardBuilt(process.cwd());
  const shared = await startSharedMasterUxServers(workers);
  try {
    const finished = await runTests({
      browser: true,
      args: [`--workers=${workers}`, 'browser-tests/master-page-ux.spec.ts'],
      environment: {
        ...process.env,
        GRAPHYARD_BROWSER_DIST: resolve('dist'),
        GRAPHYARD_PLAYWRIGHT_NO_WEBSERVER: '1',
        MASTER_UX_SHARED_SERVERS: shared.config,
        MASTER_UX_REPEAT: '20',
      },
      stdio: 'pipe',
    });
    assert.equal(finished.code, 0, `a run of master-page-ux failed; 20 of 20 must pass:\n${finished.stderr.slice(-4_000)}\n${finished.stdout.slice(-6_000)}`);
  } finally {
    await shared.close();
  }
});
