// A stand-in for Slack: the Web API methods the factory's Slack app calls (apps.connections.open,
// users.info, chat.postMessage) and a Socket Mode WebSocket the test pushes envelopes down. The
// app only ever dials out to it, as it dials out to Slack.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export interface SlackPost { channel: string; text: string; thread_ts?: string; blocks?: any[] }

/** One unmasked server-to-client text frame. */
function frame(text: string) {
  const body = Buffer.from(text);
  const head = body.length < 126 ? Buffer.from([0x81, body.length])
    : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([head, body]);
}

/** Every complete masked client frame in `buffer`, and what is left over. */
function readFrames(buffer: Buffer): { texts: string[]; rest: Buffer; closed: boolean } {
  const texts: string[] = [];
  let closed = false;
  for (;;) {
    if (buffer.length < 2) break;
    let length = buffer[1] & 127, offset = 2;
    if (length === 126) { if (buffer.length < 4) break; length = buffer.readUInt16BE(2); offset = 4; }
    if (buffer.length < offset + 4 + length) break;
    const mask = buffer.subarray(offset, offset + 4), body = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    if ((buffer[0] & 15) === 1) texts.push(body.toString());
    if ((buffer[0] & 15) === 8) closed = true;
    buffer = buffer.subarray(offset + 4 + length);
  }
  return { texts, rest: buffer, closed };
}

export async function fakeSlack(options: { appToken: string; botToken: string; names: Record<string, string>; channels?: { id: string; name: string; is_member: boolean }[] }) {
  const posts: SlackPost[] = [], acks: string[] = [], opened: string[] = [];
  let socket: Duplex | null = null;
  let connected: () => void = () => {};
  let ready = new Promise<void>(resolve => { connected = resolve; });
  const server = createServer(async (req: IncomingMessage, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const params = Object.fromEntries(new URLSearchParams(body));
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    const answer = (value: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const method = req.url!.replace(/^\/api\//, '').split('?')[0];
    if (method === 'apps.connections.open') {
      if (bearer !== options.appToken) return answer({ ok: false, error: 'invalid_auth' });
      opened.push(method);
      return answer({ ok: true, url: `ws://127.0.0.1:${(server.address() as any).port}/socket` });
    }
    if (bearer !== options.botToken) return answer({ ok: false, error: 'invalid_auth' });
    if (method === 'auth.test') return answer({ ok: true, team: 'Factory Team', user: 'mainworks', user_id: 'UAPP' });
    if (method === 'conversations.list') return answer({ ok: true, channels: options.channels ?? [] });
    if (method === 'users.list') return answer({ ok: true, members: Object.entries(options.names).map(([id, name]) => ({ id, name: name.toLowerCase(), profile: { display_name: name } })) });
    if (method === 'users.info') return answer({ ok: true, user: { id: params.user, name: params.user.toLowerCase(), profile: { display_name: options.names[params.user] ?? '', real_name: params.user } } });
    if (method === 'chat.postMessage') {
      posts.push({ channel: params.channel, text: params.text, ...(params.thread_ts ? { thread_ts: params.thread_ts } : {}), ...(params.blocks ? { blocks: JSON.parse(params.blocks) } : {}) });
      return answer({ ok: true, ts: `${Date.now() / 1000}` });
    }
    answer({ ok: false, error: 'unknown_method' });
  });
  server.on('upgrade', (req, upgraded) => {
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    upgraded.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket = upgraded;
    let pending: Buffer = Buffer.alloc(0);
    upgraded.on('data', (chunk: Buffer) => {
      const { texts, rest, closed } = readFrames(Buffer.concat([pending, chunk]));
      pending = rest;
      // The closing handshake: echo the close frame and end the connection.
      if (closed) { upgraded.end(Buffer.from([0x88, 0])); return; }
      for (const text of texts) { const parsed = JSON.parse(text); if (parsed.envelope_id) acks.push(parsed.envelope_id); }
    });
    upgraded.on('error', () => {});
    upgraded.write(frame(JSON.stringify({ type: 'hello' })));
    connected();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let envelopes = 0;
  /** Push one Socket Mode envelope to the connected app; resolves with its envelope id. */
  const push = (type: 'events_api' | 'interactive', payload: unknown) => {
    const id = `envelope-${++envelopes}`;
    socket!.write(frame(JSON.stringify({ envelope_id: id, type, payload, accepts_response_payload: false })));
    return id;
  };
  return {
    api: `http://127.0.0.1:${(server.address() as any).port}/api`, posts, acks, opened, push,
    connected: () => ready,
    message: (event: Record<string, unknown>) => push('events_api', { type: 'event_callback', event: { type: 'message', ...event } }),
    click: (user: string, channel: string, ts: string, value: string) => push('interactive', { type: 'block_actions', user: { id: user }, channel: { id: channel }, message: { ts }, actions: [{ action_id: 'answer-0', value }] }),
    close: async () => { socket?.destroy(); ready = Promise.resolve(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** Polls `check` until it returns a truthy value, failing after `ms`. */
export async function eventually<T>(check: () => T | Promise<T>, label: string, ms = 10_000): Promise<NonNullable<T>> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
