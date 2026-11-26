import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { connect } from 'node:net';
import { servedInstall } from './helpers/served-install.js';

// GY-3880: the Lead's terminal shows credentials and takes commands, so only the admin, the loop's
// coordinator and invited teammates open it; only those who may type resize it; the typed-input list
// follows the same rule; and a client message over 32 MB closes the socket.

/** The HTTP status a terminal upgrade with TOKEN gets: 101 when accepted. */
const upgradeStatus = (base: string, token: string) => new Promise<number>((resolve, reject) => {
  const req = request(`${base}/api/terminal?cols=80&rows=24`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Protocol': `mainworks, ${token}` } });
  req.on('upgrade', (_res, socket) => { socket.destroy(); resolve(101); });
  req.on('response', res => { res.resume(); resolve(res.statusCode ?? 0); });
  req.on('error', reject);
  req.end();
});

/** A WebSocket client of the server's terminal routes, with the token as its second subprotocol. */
function socket(base: string, path: string, token: string) {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}${path}`, ['mainworks', token]);
  const opened = new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve()); ws.addEventListener('error', () => reject(new Error(`${path} refused`))); });
  const closed = new Promise<void>(resolve => ws.addEventListener('close', () => resolve()));
  return { ws, opened, closed };
}

/** A raw terminal socket after the handshake, to send frames a browser never would. */
const rawTerminal = (port: number, token: string) => new Promise<import('node:net').Socket>((resolve, reject) => {
  const raw = connect(port, '127.0.0.1');
  raw.once('error', reject);
  raw.write(['GET /api/terminal?cols=80&rows=24 HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, `Sec-WebSocket-Protocol: mainworks, ${token}`, '', ''].join('\r\n'));
  let head = '';
  const onData = (chunk: Buffer) => { head += chunk.toString('latin1'); if (head.includes('\r\n\r\n')) { raw.off('data', onData); assert.match(head, /^HTTP\/1\.1 101/); resolve(raw); } };
  raw.on('data', onData);
});
/** One masked client frame header for a payload of LENGTH bytes (the payload follows, all zeros: the mask is zero). */
const header = (fin: boolean, opcode: number, length: number) => {
  const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(length));
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 127]), size, Buffer.alloc(4)]);
};
const closes = (raw: import('node:net').Socket) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the oversized socket stayed open')), 10_000);
  raw.on('close', () => { clearTimeout(timer); resolve(); }); raw.on('error', () => {});
});
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(check(), what);
};

test('integration:terminal-open-only-to-permitted-roles — worker, reviewer launch and role-less principals are refused 403 before the socket is accepted, only typers resize, typed-input follows the same rule, and a message over 32 MB closes the socket', async () => {
  const install = await servedInstall('terminal_permitted_roles');
  // Upgraded sockets outlive closeAllConnections: drop them before the server closes.
  const upgraded = new Set<import('node:stream').Duplex>();
  install.http.on('upgrade', (_req, socket) => { upgraded.add(socket); socket.on('close', () => upgraded.delete(socket)); });
  try {
    // The loop's host bridge serves every stream, as on a compose install.
    const host = socket(install.base, '/api/terminal-host', install.loop);
    await host.opened;
    const resizes: string[] = [], owners = new Map<string, string>();
    host.ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'open') {
        owners.set(message.id, message.control ? 'typer' : 'watcher');
        host.ws.send(JSON.stringify({ id: message.id, line: JSON.stringify({ type: 'session', session: { pane: 'master-pane' } }) }));
      }
      if (message.type === 'command' && message.command.type === 'terminal.resize') resizes.push(owners.get(message.id)!);
    });
    const as = async (token: string, path: string, body?: unknown) => {
      const response = await fetch(install.base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as any };
    };
    const signIn = async (name: string, role: string) => {
      const invite = await as(install.operator, '/api/invites', { name, role, days: 1 });
      assert.equal(invite.status, 200, JSON.stringify(invite.body));
      const opened = await as('', '/api/sign-in', { code: new URL(invite.body.link).hash.replace('#sign-in=', '') });
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      return opened.body.token as string;
    };
    const maintainer = await signIn('mo', 'maintainer'), viewer = await signIn('vera', 'viewer');
    const worker = (await as(install.loop, '/api/worker-identities', { id: 'worker-1' })).body.token as string;
    const reporter = (await as(install.loop, '/api/reporter-identities', { id: 'install-b' })).body.token as string;
    const caretaker = (await as(install.loop, '/api/caretaker-identity', {})).body.token as string;
    // A durable reviewer launch token, as the loop records one on an item it asks to be reviewed.
    const launch = `review-launch-${randomUUID()}`;
    const item = await install.engine.execute({ id: 'operator', role: 'admin', sessionKind: 'human' }, 'create', null, { type: 'chore', title: 'Reviewed', criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['e2e:fixture'] }] }, randomUUID());
    await install.store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{reviewLaunch}', $2::jsonb) WHERE id=$1`, [item.id, JSON.stringify({ id: 'launch-1', reviewer: 'independent-reviewer', requester: 'loop', head: 'a'.repeat(40), baseTip: 'b'.repeat(40), tokenHash: createHash('sha256').update(launch).digest('hex'), at: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() })]);
    assert.equal((await as(launch, '/api/work-snapshot')).status, 200, 'the launch token authenticates');

    // AC-1: each credential kind without a team role that may view is refused before the upgrade.
    const refused: [string, string][] = [['worker', worker], ['reviewer launch', launch], ['reporter', reporter], ['caretaker', caretaker]];
    for (const [kind, token] of refused) {
      assert.equal(await upgradeStatus(install.base, token), 403, `a ${kind} credential is refused`);
      assert.equal((await as(token, '/api/typed-input')).status, 403, `a ${kind} credential cannot read typed input`);
    }
    assert.equal(await upgradeStatus(install.base, 'not-a-token'), 401);
    for (const [kind, token] of [['admin', install.operator], ['coordinator', install.loop], ['maintainer', maintainer], ['viewer', viewer]] as const) {
      assert.equal(await upgradeStatus(install.base, token), 101, `the ${kind} opens the Lead's pane`);
      assert.equal((await as(token, '/api/typed-input')).status, 200, `the ${kind} reads typed input`);
    }

    // AC-1: only those who may type resize the pane.
    const before = owners.size;
    const typing = socket(install.base, '/api/terminal?cols=80&rows=24', maintainer), watching = socket(install.base, '/api/terminal?cols=80&rows=24', viewer);
    await Promise.all([typing.opened, watching.opened]);
    await until(() => owners.size === before + 2, 'both streams open');
    await new Promise(resolve => setTimeout(resolve, 200));
    watching.ws.send(JSON.stringify({ type: 'resize', cols: 200, rows: 60 }));
    typing.ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    await until(() => resizes.length > 0, 'the typer resized');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(resizes, ['typer'], 'a viewer\'s resize never reaches the pane');
    typing.ws.close(); watching.ws.close();

    // AC-1: a single frame over 32 MB closes the socket before it is buffered.
    const single = await rawTerminal(install.port, install.operator), singleClosed = closes(single);
    single.write(header(true, 1, 33 * 1024 * 1024)); single.write(Buffer.alloc(1024));
    await singleClosed;
    // AC-1: so does a fragmented message whose fragments total over 32 MB.
    const fragmented = await rawTerminal(install.port, install.operator), fragmentedClosed = closes(fragmented);
    const fragment = 12 * 1024 * 1024;
    fragmented.write(Buffer.concat([header(false, 1, fragment), Buffer.alloc(fragment)]));
    fragmented.write(Buffer.concat([header(false, 0, fragment), Buffer.alloc(fragment)]));
    fragmented.write(Buffer.concat([header(true, 0, fragment), Buffer.alloc(fragment)]), () => {});
    await fragmentedClosed;
    host.ws.close();
  } finally { for (const socket of upgraded) socket.destroy(); await install.close(); }
});
