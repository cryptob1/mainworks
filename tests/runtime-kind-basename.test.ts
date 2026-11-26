import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { Engine } from '../src/engine.js';
import { setupMaster } from '../src/master.js';
import { awaitRuntimeStart, launchSession, observeStart, SessionStartError } from '../src/master/launch.js';
import type { Principal } from '../src/model.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';

const herdrStub = (reportedAgent: string, status: string, argv: string[], screen = `${reportedAgent} ready\n`) => (_command: string, args: string[]) => {
  const json = (result: unknown) => JSON.stringify({ result });
  if (args[0] === 'agent' && args[1] === 'get') return json({ agent: { agent: reportedAgent, agent_status: status, pane_id: args[2] } });
  if (args[0] === 'pane' && args[1] === 'read') return screen;
  if (args[0] === 'pane' && args[1] === 'process-info') return json({ process_info: { shell_pid: 100, foreground_process_group_id: 200, foreground_processes: [{ argv }] } });
  throw new Error(`Unexpected Herdr args: ${args.join(' ')}`);
};

test('integration:runtime-kind-basename — observeStart matches runtime kind by basename and still refuses a different runtime', async () => {
  const absoluteKind = '/usr/local/bin/node';
  const command = `${absoluteKind} /opt/custom-agent.mjs`;

  for (const status of ['idle', 'working']) {
    const run = herdrStub('node', status, [absoluteKind, '/opt/custom-agent.mjs']);
    const observed = await observeStart('w1:p1', absoluteKind, command, run);
    assert.equal(observed.state, 'ready', observed.detail);
  }

  const wrongRuntime = herdrStub('codex', 'working', ['codex'], 'Codex ready\n');
  const refused = await observeStart('w1:p1', absoluteKind, command, wrongRuntime);
  assert.equal(refused.state, 'absent', refused.detail);
  assert.equal(refused.detail, `the pane holds codex, not ${absoluteKind}`);

  let now = 0;
  await assert.rejects(
    awaitRuntimeStart('w1:p1', absoluteKind, command, wrongRuntime, {
      timeoutMs: 1000, ceilingMs: 2000, pollMs: 100, clock: () => now, wait: ms => { now += ms; },
    }),
    (error: unknown) => error instanceof SessionStartError && error.startCase === 'never started' && error.message.includes(`the pane holds codex, not ${absoluteKind}`),
  );
  assert.ok(now <= 1000, 'a different runtime is refused at the start bound without extending to the ceiling');
});

test('e2e:runtime-kind-basename — on a running test install a session launched by absolute path reads as started when Herdr reports its basename', async () => {
  const root = await temporaryDirectory('runtime-kind-basename-repo');
  const installDir = await temporaryDirectory('runtime-kind-basename-install');
  const coordinator: Principal = { id: 'master', role: 'coordinator' };
  const token = `coordinator-${'t'.repeat(32)}`;
  let store: Store | null = null;
  let http: ReturnType<typeof server> | null = null;

  try {
    store = await withDatabase('runtime-kind-basename');
    await store.init();
    const engine = new Engine(store, 120, 'owner/project');
    http = server(engine, [{ ...coordinator, token }]);
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;

    const { git } = await gitRepo({ root, files: { '.gitignore': '.mainworks/\n' } });
    git('remote', 'add', 'origin', 'https://github.com/owner/project.git');

    await setupMaster(root, {
      url,
      token,
      cliPath: join(process.cwd(), 'bin', 'mainworks.mjs'),
      hostId: 'fixture-host',
      herdrWorkspace: 'wTest',
      credentialDirectory: installDir,
    });

    const script = join(installDir, 'agent.mjs');
    writeFileSync(script, 'console.log("ready");\n');
    const reportedName = basename(process.execPath);
    const run = async (_command: string, args: string[]) => {
      const json = (result: unknown) => JSON.stringify({ result });
      if (args[0] === 'tab' && args[1] === 'create') return json({ root_pane: { pane_id: 'wTest:p1', tab_id: 'wTest:t1' } });
      if (args[0] === 'pane' && args[1] === 'run') return '';
      if (args[0] === 'agent' && args[1] === 'get') return json({ agent: { agent: reportedName, agent_status: 'idle', pane_id: args[2] } });
      if (args[0] === 'pane' && args[1] === 'read') return `${reportedName} ready\n`;
      if (args[0] === 'pane' && args[1] === 'process-info') return json({ process_info: { shell_pid: 100, foreground_process_group_id: 200, foreground_processes: [{ argv: [process.execPath, script] }] } });
      if (args[0] === 'agent' && args[1] === 'rename') return json({ agent: { agent: reportedName, agent_status: 'idle', name: args[3] } });
      if (args[0] === 'pane' && args[1] === 'close') return json({});
      if (args[0] === 'tab' && args[1] === 'close') return json({});
      throw new Error(`Unexpected Herdr args: ${args.join(' ')}`);
    };

    let now = 0;
    const launched = await launchSession({
      name: 'fixture-agent',
      kind: process.execPath,
      args: [script, '{request}'],
      text: 'Verify runtime kind basename matching.',
      workspace: 'wTest',
      label: 'Runtime kind basename test',
      run,
      onPane: () => undefined,
      start: {
        directory: root,
        cwd: root,
        confinement: false,
        contract: { args: [script, '{request}'] },
        timeoutMs: 1000,
        ceilingMs: 2000,
        pollMs: 100,
        clock: () => now,
        wait: ms => { now += ms; },
      },
    });

    assert.equal(launched.started.state, 'started', launched.started.detail);
  } finally {
    if (http) {
      (http as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>(resolve => http!.close(() => resolve()));
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  }
});
