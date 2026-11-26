// Generates the README's real-dashboard media files under docs/media/:
//   - docs/media/work.png   (1600x900, Work page with changes across stages)
//   - docs/media/change.png (1600x900, one change with goal, green proofs, diff summary, reviewer verdict)
//   - docs/media/lead.png   (1600x900, Lead page with plain-language status and one Needs you item)
//   - docs/media/hero.gif + docs/media/hero.mp4 (1600x900, ~18s lifecycle recording, < 4 MB)
//
// Usage: npm run docs:media
// Serves the built dist/ dashboard on a local loopback port with seeded demo data only.
// Nothing leaves the machine and no real project, person, token, host or internal id is used.

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOW, at, buildDemoState } from './docs-media-demo.mjs';

if (existsSync('/etc/graphyard-trial')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/graphyard-browsers';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const outDir = join(root, 'docs', 'media');

const min = 60_000;

function startDemoServer() {
  let state = buildDemoState('static');
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
      if (route === 'status') return res.end(JSON.stringify(state.status));
      if (route === 'work-snapshot') return res.end(JSON.stringify({ work: state.work, jobs: [], now: at(0) }));
      if (route === 'board') return res.end(JSON.stringify(state.board));
      if (route === 'flow') return res.end(JSON.stringify(state.flow));
      if (route === 'work') return res.end(JSON.stringify(state.work));
      if (route === `work/${state.item103.id}/timings`) return res.end(JSON.stringify(state.item103Timings));
      if (route === `work/${state.item103.id}/diff`) return res.end(JSON.stringify(state.item103Diff));
      if (route.startsWith('work/') && route.endsWith('/timings')) return res.end(JSON.stringify({ releasedAt: at(-10 * min), checkout: '/srv/acme-storefront', trial: null }));
      if (route.startsWith('work/') && route.endsWith('/diff')) return res.end(JSON.stringify({ files: [] }));
      if (route.startsWith('work/')) {
        const id = route.slice('work/'.length);
        const found = state.work.find((w) => w.id === id);
        return res.end(JSON.stringify(found ?? state.work[0]));
      }
      if (route === 'costs') return res.end(JSON.stringify({ builder: { model: 'claude-sonnet-4-6', accountModel: 'claude-sonnet-4-6', differs: false } }));
      if (route === 'events') return res.end(JSON.stringify(state.leadEvents));
      if (route === 'typed-input') return res.end(JSON.stringify({ typed: state.typed }));
      if (route === 'team-access') return res.end(JSON.stringify({ teammates: [] }));
      if (route === 'master/messages') return res.end(JSON.stringify({ messages: [] }));
      if (route === 'agent-registry/history') return res.end(JSON.stringify([]));
      if (route === 'delivery') return res.end(JSON.stringify({ environments: [], releases: [], rollbacks: [], now: at(0) }));
      if (route.startsWith('validation')) return res.end(JSON.stringify({ requests: [], candidates: [], nextCursor: null }));
      if (route === 'operator-agents') return res.end(JSON.stringify([]));
      return res.end(JSON.stringify([]));
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
    setPhase(phase) {
      state = buildDemoState(phase);
    },
  };
}

async function main() {
  if (!existsSync(join(dist, 'index.html'))) {
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  }
  await mkdir(outDir, { recursive: true });

  const { chromium } = await import('@playwright/test');
  const { server, setPhase } = startDemoServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const xtermCss = await readFile(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8');
  const xtermJs = await readFile(join(root, 'node_modules/@xterm/xterm/lib/xterm.js'), 'utf8');

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    const systemChromium = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => existsSync(p));
    if (!systemChromium) throw err;
    browser = await chromium.launch({ executablePath: systemChromium });
  }
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(NOW));

  // Serve xterm locally so Lead page works offline and connects to mocked terminal WebSocket.
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

  // Sign in once in light theme (Daylight skips the Night Yard boot veil).
  await page.addInitScript(() => {
    localStorage.setItem('graphyard.theme', 'daylight');
    localStorage.setItem('graphyard-token', 'demo-token');
  });
  await page.goto(`${origin}/#work`);
  await page.getByRole('heading', { name: 'Work', level: 1 }).waitFor();
  await page.waitForTimeout(400);

  // 1. work.png — Work page with changes across Building, In review, Testing, Shipped.
  await page.screenshot({ path: join(outDir, 'work.png'), fullPage: false });
  console.log('wrote docs/media/work.png');

  // 2. change.png — Rate-limit the login endpoint: goal in plain words, green checks, diff summary, and the dashboard's own Product review verdict (Checks and diff tab, no internal UUID).
  await page.getByRole('link', { name: /Rate-limit the login endpoint/ }).click();
  await page.getByRole('heading', { name: 'Rate-limit the login endpoint', level: 1 }).waitFor();
  await page.getByRole('heading', { name: /Product review/ }).waitFor();
  await page.waitForTimeout(350);
  await page.setViewportSize({ width: 1600, height: 1030 });
  await page.screenshot({ path: join(outDir, 'change.png'), fullPage: false });
  await page.setViewportSize({ width: 1600, height: 900 });
  console.log('wrote docs/media/change.png');

  // 3. lead.png — Lead page with plain-language status and one Needs you item.
  await page.goto(`${origin}/#lead`);
  await page.getByRole('heading', { name: 'Lead', level: 1 }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, 'lead.png'), fullPage: false });
  console.log('wrote docs/media/lead.png');

  // 4. hero.gif + hero.mp4 — ~18s recording: type goal -> appears on Work -> review -> testing -> Merged -> Live.
  const framesDir = await mkdtemp(join(tmpdir(), 'mainworks-hero-'));
  const fps = 4;
  let frameIndex = 0;
  const hold = async (seconds) => {
    const count = Math.max(1, Math.round(seconds * fps));
    const first = join(framesDir, `f${String(frameIndex).padStart(5, '0')}.png`);
    await page.screenshot({ path: first, fullPage: false });
    frameIndex++;
    if (count > 1) {
      const buf = await readFile(first);
      const { writeFile } = await import('node:fs/promises');
      for (let i = 1; i < count; i++) {
        await writeFile(join(framesDir, `f${String(frameIndex++).padStart(5, '0')}.png`), buf);
      }
    }
  };

  try {
    setPhase('before-create');
    await page.goto(`${origin}/#work`);
    await page.reload();
    await page.getByRole('heading', { name: 'Work', level: 1 }).waitFor();
    await page.getByText('Export monthly invoices as CSV').waitFor({ state: 'detached' });
    await page.waitForTimeout(350);
    await hold(1.5);

    // Open New work item dialog and type the goal cleanly in steps.
    await page.getByRole('button', { name: '＋ New work item' }).click();
    await page.getByRole('dialog', { name: 'New work item' }).waitFor();
    await hold(0.75);

    const titleField = page.locator('input[name="title"]');
    const whyField = page.locator('input[name="why"]');
    const simplestField = page.locator('input[name="simplest"]');

    for (const part of ['Export monthly ', 'Export monthly invoices as CSV']) {
      await titleField.fill(part);
      await hold(0.5);
    }
    for (const part of ['Customers can download their ', 'Customers can download their billing history for accounting.']) {
      await whyField.fill(part);
      await hold(0.5);
    }
    await simplestField.fill('One CSV button on the Billing page using existing invoice rows.');
    await hold(1.0);

    // Submit -> return to Work showing Building.
    await page.getByRole('button', { name: 'Create work item' }).click();
    await page.waitForTimeout(350);
    await page.getByRole('button', { name: '← Back' }).click();
    await page.getByRole('heading', { name: 'Work', level: 1 }).waitFor();
    await page.getByText('Export monthly invoices as CSV').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await hold(2.5);

    // Advance through Review -> Testing -> Merged -> Shipped (Live).
    for (const [phase, seconds] of [
      ['review', 2.5],
      ['test', 2.5],
      ['merged', 2.25],
      ['live', 3.0],
    ]) {
      setPhase(phase);
      await page.reload();
      await page.getByRole('heading', { name: 'Work', level: 1 }).waitFor();
      await page.waitForTimeout(350);
      await hold(seconds);
    }

    // Encode MP4 (1600x900) and GIF (1600x900, < 4 MB).
    const mp4Path = join(outDir, 'hero.mp4');
    const gifPath = join(outDir, 'hero.gif');
    execFileSync('ffmpeg', [
      '-y', '-framerate', String(fps), '-i', join(framesDir, 'f%05d.png'),
      '-vf', 'scale=1600:900:flags=lanczos,format=yuv420p',
      '-c:v', 'libx264', '-crf', '24', '-preset', 'slow', '-movflags', '+faststart',
      mp4Path,
    ], { stdio: 'inherit' });

    execFileSync('uv', [
      'run', '--no-project', '--with', 'pillow', 'python3', '-I',
      join(root, 'scripts/walkthrough/makegif.py'),
      framesDir, String(fps), '1600', gifPath,
    ], { stdio: 'inherit' });

    const gifSize = (await stat(gifPath)).size;
    console.log(`wrote docs/media/hero.mp4 and docs/media/hero.gif (${(gifSize / 1024 / 1024).toFixed(2)} MB)`);
  } finally {
    await rm(framesDir, { recursive: true, force: true });
    await browser.close();
    server.close();
  }
}

await main();
