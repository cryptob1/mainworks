import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo, Server as NetServer } from 'node:net';

// GY-3906: the one way a test binds an HTTP server on a free loopback port and closes it.
export async function listen<S extends NetServer = Server>(target: S | RequestListener, opt?: number | { after(fn: () => unknown): void }) {
  const server = (typeof target === 'function' ? createServer(target) : target) as S;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(typeof opt === 'number' ? opt : 0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const port = (server.address() as AddressInfo).port;
  const close = () => new Promise<void>(resolve => { server.close(() => resolve()); if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') server.closeAllConnections(); });
  if (opt && typeof opt === 'object') opt.after(close);
  return { server, port, url: `http://127.0.0.1:${port}`, close };
}

export async function freePort() { const { port, close } = await listen(createServer()); await close(); return port; }
