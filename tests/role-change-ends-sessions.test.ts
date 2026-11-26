import { test } from 'node:test';
import assert from 'node:assert/strict';
import { servedInstall } from './helpers/served-install.js';

// GY-3880: a teammate's role changed by invite (or by the machine's roster, admit) takes effect at
// once: every session they hold ends and their open Lead terminal closes; signing in again gives the new role.

function socket(base: string, token: string) {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/terminal?cols=80&rows=24`, ['mainworks', token]);
  const opened = new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve()); ws.addEventListener('error', () => reject(new Error('refused'))); });
  const closed = new Promise<void>(resolve => ws.addEventListener('close', () => resolve()));
  return { ws, opened, closed };
}
const within = (done: Promise<unknown>, what: string) => Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error(what)), 5_000))]);

test('integration:role-change-ends-sessions — downgrading a maintainer by invite or admit ends their sessions and closes their terminal; signing in again gives the new role', async () => {
  const install = await servedInstall('role_change_sessions');
  const upgraded = new Set<import('node:stream').Duplex>();
  install.http.on('upgrade', (_req, socket) => { upgraded.add(socket); socket.on('close', () => upgraded.delete(socket)); });
  try {
    const as = async (token: string, path: string, body?: unknown) => {
      const response = await fetch(install.base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as any };
    };
    const invite = (name: string, role: string) => as(install.operator, '/api/invites', { name, role, days: 1 });
    const open = async (link: string) => (await as('', '/api/sign-in', { code: new URL(link).hash.replace('#sign-in=', '') })).body as { token: string; actor: { team: string } };
    const typedLines: { pane?: string; text?: string }[] = [];
    const host = new WebSocket(`${install.base.replace('http:', 'ws:')}/api/terminal-host`, ['mainworks', install.loop]);
    await new Promise(resolve => host.addEventListener('open', resolve));
    host.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'open') host.send(JSON.stringify({ id: message.id, line: JSON.stringify({ type: 'session', session: { pane: 'master-pane' } }) }));
      if (message.type === 'command' && message.command.type === 'terminal.input') typedLines.push({ text: message.command.text });
    });

    // By invite: the owner changes mo from maintainer to viewer while mo has the Lead's terminal open.
    const mo = await open((await invite('mo', 'maintainer')).body.link);
    const other = await open((await invite('mo', 'maintainer')).body.link);
    const terminal = socket(install.base, mo.token);
    await terminal.opened;
    await new Promise(resolve => setTimeout(resolve, 200));
    terminal.ws.send(JSON.stringify({ type: 'input', data: 'before\r' }));
    for (let i = 0; i < 40 && !typedLines.length; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(typedLines.map(line => line.text), ['before\r'], 'a maintainer types');
    const downgrade = await invite('mo', 'viewer');
    assert.equal(downgrade.status, 200, JSON.stringify(downgrade.body));
    await within(terminal.closed, 'the downgraded maintainer\'s terminal stayed open');
    for (const token of [mo.token, other.token]) assert.equal((await as(token, '/api/work-snapshot')).status, 401, 'every session of theirs ended');
    try { terminal.ws.send(JSON.stringify({ type: 'input', data: 'after\r' })); } catch { /* closed */ }
    await assert.rejects(socket(install.base, mo.token).opened, 'the old session cannot reopen the terminal');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(typedLines.map(line => line.text), ['before\r'], 'the next typed input is refused');
    const again = await open(downgrade.body.link);
    assert.equal(again.actor.team, 'viewer', 'signing in again gives the new role');
    const watching = socket(install.base, again.token);
    await watching.opened;
    await new Promise(resolve => setTimeout(resolve, 200));
    watching.ws.send(JSON.stringify({ type: 'input', data: 'as viewer\r' }));
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(typedLines.map(line => line.text), ['before\r'], 'as a viewer they only watch');

    // By admit: the machine's roster changes a teammate's role; the same role again ends nothing.
    const kai = await open((await invite('kai', 'maintainer')).body.link);
    const url = 'https://machine.example.ts.net';
    const report = (role: string) => as(install.loop, '/api/team-access/host', { dnsName: 'machine.example.ts.net.', ip: '100.64.0.1', url, team: { installs: { [url]: { name: 'project' } }, members: { kai: { role, installs: [url] } } }, applied: { team: null } });
    assert.equal((await report('maintainer')).status, 200);
    assert.equal((await as(kai.token, '/api/work-snapshot')).status, 200, 'an unchanged role keeps the session');
    const kaiTerminal = socket(install.base, kai.token);
    await kaiTerminal.opened;
    assert.equal((await report('viewer')).status, 200);
    await within(kaiTerminal.closed, 'the admitted role change left the terminal open');
    assert.equal((await as(kai.token, '/api/work-snapshot')).status, 401, 'their session ended');
    watching.ws.close(); host.close();
  } finally { for (const socket of upgraded) socket.destroy(); await install.close(); }
});
