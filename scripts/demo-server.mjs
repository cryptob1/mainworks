// The demo dashboard server (GY-3962): the built dist/ bundle plus scripts/docs-media-demo.mjs's
// seeded API, on a loopback port. scripts/docs-media.mjs and scripts/ux-captures.mjs both serve it.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { NOW, at, buildDemoState, demoAnswer } from './docs-media-demo.mjs';

const min = 60_000;

export function startDemoServer(dist) {
  let state = buildDemoState('static'), phase = 'static';
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      const route = url.pathname.slice('/api/'.length);
      res.setHeader('content-type', 'application/json');

      if (req.method === 'POST' && route === 'work') {
        state = buildDemoState('build');
        return res.end(JSON.stringify(state.work[0]));
      }
      if (phase === 'error' && route !== 'status') {
        res.statusCode = 503;
        return res.end(JSON.stringify({ error: 'The control plane is restarting' }));
      }
      return res.end(JSON.stringify(demoAnswer(state, route, url.searchParams)));
    }

    const file = join(dist, url.pathname === '/' ? 'index.html' : url.pathname);
    try {
      const body = await readFile(extname(file) ? file : join(dist, 'index.html'));
      res.setHeader('content-type', types[extname(file)] ?? 'text/html; charset=utf-8');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });

  return {
    server,
    setPhase(next) {
      phase = next;
      state = buildDemoState(next === 'error' ? 'static' : next);
    },
  };
}

/** Chromium from Playwright, else the system's. */
export async function launchBrowser() {
  if (existsSync('/etc/graphyard-trial')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/graphyard-browsers';
  const { chromium } = await import('@playwright/test');
  try {
    return await chromium.launch();
  } catch (err) {
    const systemChromium = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => existsSync(p));
    if (!systemChromium) throw err;
    return chromium.launch({ executablePath: systemChromium });
  }
}

/** A light-theme page at the demo's fixed time, with xterm served locally and a live Lead pane. */
export async function demoPage(browser, root, viewport, { signedIn = true } = {}) {
  const xtermCss = await readFile(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8');
  const xtermJs = await readFile(join(root, 'node_modules/@xterm/xterm/lib/xterm.js'), 'utf8');
  const context = await browser.newContext({ viewport, colorScheme: 'light' });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(NOW));
  await page.route('https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css', (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: xtermCss }),
  );
  await page.route('https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.js', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: xtermJs }),
  );
  await page.routeWebSocket(/\/api\/terminal/, (ws) => {
    ws.send(JSON.stringify({
      type: 'hello',
      mode: 'control',
      session: { account: 'lead-claude', runtime: 'claude', pane: '1', state: 'working', since: at(-6 * min) },
    }));
  });
  // Daylight skips the Night Yard boot veil.
  await page.addInitScript((token) => {
    localStorage.setItem('graphyard.theme', 'daylight');
    if (token) localStorage.setItem('graphyard-token', token);
  }, signedIn ? 'demo-token' : null);
  return page;
}
