import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeLaunchProvider } from './helpers/runtime-launch-provider.js';
import { resolverEnvironment } from './helpers/runtime-launch-session.js';
import { runtimeLaunchTerminal } from './helpers/runtime-launch-terminal.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

test('unit:runtime-launch-real-progress-e2e-pinned — PTY process-info is queried live after output, provider binds explicit IPv4 loopback, and repaired DNS is not capped to 1 attempt / 1s', async () => {
  // 1. Provider base_url must target the explicit IPv4 loopback address its server listens on,
  // never `localhost` (which resolves to ::1 as well in the fixture's /etc/hosts with 0 retries).
  const provider = await runtimeLaunchProvider();
  try {
    const baseUrlArg = provider.args.find(arg => arg.includes('base_url='));
    assert.ok(baseUrlArg, 'provider args declare base_url');
    assert.match(baseUrlArg, /base_url="http:\/\/127\.0\.0\.1:\d+\/v1"/, 'provider base_url matches its 127.0.0.1 listener');
  } finally {
    await provider.close();
  }

  // 2. Only the expected-failure DNS probe caps glibc to 1 attempt / 1s; the repaired DNS probe
  // keeps retries so a >1s cold lookup does not spuriously fail.
  assert.equal(resolverEnvironment('fail', {}).RES_OPTIONS, 'attempts:1 timeout:1');
  assert.notEqual(resolverEnvironment('succeed', {}).RES_OPTIONS, 'attempts:1 timeout:1');

  // 3. `pane process-info` must query the PTY's live foreground process group on demand rather than
  // returning a stale background snapshot from before the launched command produced output.
  const dir = await temporaryDirectory('runtime-launch-pinned');
  const rc = join(dir, 'bashrc');
  await writeFile(rc, "PS1='GY-PTY> '\n");
  const terminal = await runtimeLaunchTerminal(dir, rc, { ...process.env, TERM: 'dumb' });
  try {
    for (let i = 0; i < 10; i++) {
      const marker = `LIVE-FG-${i}`;
      await terminal.run('herdr', ['pane', 'run', 'pty', `sh -c 'echo ${marker}; sleep 0.2'`]);
      await terminal.until(() => terminal.screen().includes(marker), `child output ${marker}`, 5_000);
      const raw = JSON.parse(String(await terminal.run('herdr', ['pane', 'process-info', '--pane', 'pty'])));
      const info = raw.result.process_info;
      assert.ok(info && info.shell_pid > 0, 'process-info reports the shell pid');
      assert.notEqual(info.foreground_process_group_id, info.shell_pid,
        `process-info must report the live foreground group after child output (${marker}), not a stale shell_pid`);
      await terminal.until(() => terminal.screen().trimEnd().endsWith('GY-PTY>') && terminal.screen().lastIndexOf('GY-PTY>') > terminal.screen().indexOf(marker), `shell prompt after ${marker}`, 5_000);
    }
  } finally {
    await terminal.close();
  }
});
