import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ChildRun } from '../../src/child-runner.js';

// A real interactive shell and PTY. Only Herdr's transport is substituted; screen,
// foreground group and argv come from the actual launched processes. Process-info is
// queried synchronously on demand so `pane process-info` never returns a stale shell_pid
// snapshot after `pane read` has already observed the child's output.
const terminal = String.raw`
import json, os, pty, select, signal, sys
pid, master = pty.fork()
if pid == 0:
    os.execv('/bin/bash', ['bash', '--noprofile', '--rcfile', sys.argv[1], '-i'])
def stop(*args):
    try:
        os.killpg(os.tcgetpgrp(master), signal.SIGKILL)
    except OSError:
        pass
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    sys.exit(0)
def process_info():
    group = os.tcgetpgrp(master)
    processes = []
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        try:
            if os.getpgid(int(entry)) == group:
                with open('/proc/' + entry + '/cmdline', 'rb') as handle:
                    argv = handle.read().decode(errors='replace').strip('\0').split('\0')
                processes.append({'argv': argv})
        except (OSError, UnicodeError):
            pass
    return {'shell_pid': pid, 'foreground_process_group_id': group, 'foreground_processes': processes}
signal.signal(signal.SIGTERM, stop)
stdin_buf = b''
while True:
    ready, _, _ = select.select([master, sys.stdin], [], [])
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            stop()
        if not data:
            stop()
        os.write(sys.stdout.fileno(), data)
    if sys.stdin in ready:
        chunk = os.read(sys.stdin.fileno(), 65536)
        if not chunk:
            stop()
        stdin_buf += chunk
        while b'\n' in stdin_buf:
            raw, stdin_buf = stdin_buf.split(b'\n', 1)
            if not raw:
                continue
            message = json.loads(raw.decode())
            if message['op'] == 'write':
                os.write(master, message['data'].encode())
            elif message['op'] == 'process-info':
                try:
                    info = process_info()
                except OSError:
                    stop()
                print(json.dumps({'id': message['id'], 'process_info': info}), file=sys.stderr, flush=True)
`;

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

export async function runtimeLaunchTerminal(cwd: string, rc: string, environment: NodeJS.ProcessEnv) {
  const child = spawn('/usr/bin/python3', ['-I', '-S', '-c', terminal, rc], { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  let screen = '', pending = '', nextRequestId = 0;
  const waiters = new Map<number, (info: unknown) => void>();
  const settleAll = (value: unknown) => {
    for (const resolve of waiters.values()) resolve(value);
    waiters.clear();
  };
  child.stdout.on('data', data => { screen += data; });
  child.stderr.on('data', data => {
    pending += data;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.id === 'number' && waiters.has(parsed.id)) {
          const resolve = waiters.get(parsed.id)!;
          waiters.delete(parsed.id);
          resolve(parsed.process_info ?? null);
          continue;
        }
      } catch { /* fall through to screen */ }
      screen += line;
    }
  });
  child.once('close', () => settleAll(null));
  const queryProcessInfo = () => {
    if (child.exitCode !== null) return Promise.resolve(null);
    const id = ++nextRequestId;
    return new Promise<unknown>(resolve => {
      waiters.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ op: 'process-info', id })}\n`);
    });
  };
  const until = async (predicate: () => boolean, label: string, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`${label}: ${screen}`);
      await sleep(25);
    }
  };
  await until(() => screen.includes('GY-PTY>'), 'interactive shell startup');
  const calls: string[][] = [];
  const run: ChildRun = async (_command, args) => {
    calls.push(args);
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'pane' && args[1] === 'run') { child.stdin.write(`${JSON.stringify({ op: 'write', data: `${args[3]}\n` })}\n`); return ''; }
    if (args[0] === 'pane' && args[1] === 'read') return stripAnsi(screen);
    if (args[0] === 'pane' && args[1] === 'process-info') return json({ process_info: await queryProcessInfo() });
    // Deliberately reproduce the incident: the shell already carries an agent name.
    if (args[0] === 'agent' && args[1] === 'get') return json({ agent: { agent: 'codex', agent_status: 'idle' } });
    if (args[0] === 'agent' && args[1] === 'rename') return json({});
    throw new Error(`Unexpected transport call ${args.join(' ')}`);
  };
  return { run, calls, until, screen: () => stripAnsi(screen), close: async () => {
    if (child.exitCode !== null) return;
    await new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill('SIGTERM'); });
  } };
}
