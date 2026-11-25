import { test as base, expect, type Browser, type Page } from '@playwright/test';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, symlink } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { temporaryDirectory } from '../tests/helpers/temp-dirs';
import { serveXterm } from './xterm';
import { saveMasterState } from './master-state';

const settled = { timeout: 15_000 };
const fastPoll = { intervals: [50] };
const initialMaster = () => ({ master: { agentName: 'master', pane: 'w1:master' as string | null, account: 'test-account', runtime: 'codex' }, status: 'idle', gap: '' });

// GY-3818: share one Postgres database, forked terminal-server and terminal bridge per Playwright
// worker via a worker-scoped fixture, and keep src/ imports inside the forked tsx server so
// Playwright's Babel transformer does not compile the whole repository per worker.
interface SharedServer { site: string; url: string; child: ChildProcess; run: number }
const test = base.extend<{}, { server: SharedServer }>({
  server: [async ({}, use) => {
    const site = await temporaryDirectory('master-ux');
    await symlink(process.env.GRAPHYARD_BROWSER_DIST!, join(site, 'dist'));
    const stateFile = join(site, 'master.daemon.json');
    await saveMasterState(stateFile, initialMaster());
    const child = fork(resolve('tests/helpers/terminal-server.ts'), ['new', site], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: {
        ...process.env,
        PATH: `${resolve('fixtures/herdr-terminal-stub')}${delimiter}${process.env.PATH}`,
        HOME: site,
        HERDR_STUB_LOG: join(site, 'herdr-0.log'),
        HERDR_STUB_STATE: stateFile,
        GRAPHYARD_TEST_BRIDGE_STATE: stateFile,
        GRAPHYARD_HERDR_CONFIG_HOME: '',
        GRAPHYARD_HERDR_SESSION: '',
      },
    });
    const [{ url }] = await once(child, 'message') as [{ url: string }];
    try {
      await use({ site, url, child, run: 0 });
    } finally {
      const ended = once(child, 'exit'); child.send('stop'); await ended;
    }
  }, { scope: 'worker' }],
});

async function fixture(browser: Browser, shared: SharedServer, phone = false) {
  const { site, url, child } = shared;
  const logFile = join(site, `herdr-${++shared.run}.log`);
  const current = initialMaster();
  const save = () => saveMasterState(join(site, 'master.daemon.json'), current);
  await save();
  const reset = once(child, 'message');
  child.send({ type: 'reset', logFile });
  await reset;
  const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await serveXterm(context);
  const page = await context.newPage();
  // Capture the real xterm instance for buffer/dimension assertions, without replacing its behavior.
  await page.addInitScript(() => {
    let original: any;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => original, set: value => {
      original = class extends value { constructor(options: unknown) { super(options); (window as any).testTerminal = this; } };
    } });
    // GY-3368: 'reconnecting' lasts one 250 ms retry delay, shorter than expect's polling gaps, so
    // every state the terminal enters is recorded and the test reads the record, not one sample.
    const states: string[] = (window as any).terminalStates = [];
    new MutationObserver(changes => { for (const change of changes) states.push((change.target as Element).getAttribute('data-terminal')!); })
      .observe(document, { subtree: true, attributes: true, attributeFilter: ['data-terminal'] });
  });
  const { code } = await (await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
  await page.goto(`${url}/#sign-in=${code}&master`);
  await openLiveSession(page);
  const calls = async () => (await readFile(logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const inputs = async () => (await calls()).filter(entry => entry.command?.type === 'terminal.input').map(entry => entry.command.text);
  await expect(page.locator('.xterm-rows')).toContainText('screen of w1:master', settled);
  const reconnects = () => page.evaluate(() => (window as any).terminalStates.filter((state: string) => state === 'reconnecting').length);
  return { page, child, current, save, calls, inputs, reconnects, stop: async () => {
    await context.close();
  } };
}


/** The sign-in link opens the Lead page on its conversation; its live session is its own address. */
const openLiveSession = async (page: Page) => {
  await expect(page.getByRole('heading', { name: 'Lead', exact: true })).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => { location.hash = '#master/live'; });
};

test('e2e:master-page-ux — history, fitting, native input, clipboard, reconnect and pane changes', async ({ browser, server }) => {
  // Includes server startup, two reconnects and two pane changes under the parallel browser suite.
  test.setTimeout(60_000);
  const f = await fixture(browser, server), { page } = f;
  try {
    await expect(page.getByRole('status')).toContainText('Idle · test-account');
    await expect(page.locator('.terminal-session')).toHaveAttribute('title', 'codex · w1:master');
    await expect(page.getByRole('status')).toContainText('You can type here');
    const layout = () => page.evaluate(() => {
      const terminal = (window as any).testTerminal, box = document.querySelector('.terminal-host')!.getBoundingClientRect();
      return { cols: terminal.cols, rows: terminal.rows, bottom: box.bottom, height: box.height, viewport: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    const before = await layout(); expect(before.height).toBeGreaterThan(600); expect(before.overflow).toBe(false);
    // The terminal ends at the page's bottom padding: the document never scrolls (GY-3308), so the
    // gap below it is that padding (32 px on a desktop main) rather than a fixed 12 px, and at least the version-label strip (GY-3310).
    expect(before.viewport - before.bottom).toBeLessThan(40);
    await page.setViewportSize({ width: 1050, height: 720 });
    await expect.poll(async () => (await layout()).cols, fastPoll).not.toBe(before.cols);
    const after = await layout();
    await expect.poll(async () => (await f.calls()).filter(entry => entry.size).at(-1)?.size, fastPoll).toEqual({ cols: after.cols, rows: after.rows });
    // History is actually in xterm's scrollback, not just a hidden JSON frame.
    await page.evaluate(() => (window as any).testTerminal.scrollToTop());
    await expect(page.locator('.xterm-rows')).toContainText('earlier line 0000');
    expect(await page.evaluate(() => {
      const buffer = (window as any).testTerminal.buffer.active;
      return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString()).filter(line => String(line).startsWith('earlier line ')).length;
    })).toBe(1000);
    await page.evaluate(() => (window as any).testTerminal.scrollToBottom());
    // GY-3731: the pane mounts hidden under the Conversation tab; a hello that lands before the switch
    // to #master/live cannot focus it, so keys went to the page body. Focus it as a user does, and wait.
    await page.locator('.terminal-host').click();
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await page.keyboard.type('hello master'); await page.keyboard.press('Enter');
    for (const key of ['Control+c', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape', 'Alt+x']) await page.keyboard.press(key);
    await expect.poll(f.inputs, fastPoll).toEqual(expect.arrayContaining(['\x03', '\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C', '\x1b', '\x1bx']));
    await expect(page.locator('.xterm-rows')).toContainText('hello master');
    await page.evaluate(() => navigator.clipboard.writeText('first line\nsecond line'));
    await page.keyboard.press('Control+Shift+V');
    await expect.poll(f.inputs, fastPoll).toContain('\x1b[200~first line\rsecond line\x1b[201~');
    await page.evaluate(() => (window as any).testTerminal.select(0, (window as any).testTerminal.buffer.active.baseY, 6));
    const selected = await page.evaluate(() => (window as any).testTerminal.getSelection());
    await page.keyboard.press('Control+Shift+C');
    expect(selected).not.toBe('');
    // Copy writes asynchronously; key dispatch can finish before the native clipboard write.
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), fastPoll).toBe(selected);
    await page.evaluate(() => navigator.clipboard.writeText('right click paste'));
    await page.locator('.terminal-host').click({ button: 'right' });
    await expect.poll(f.inputs, fastPoll).toContain('\x1b[200~right click paste\x1b[201~');
    await page.evaluate(() => (window as any).survivedDrop = true);
    // The pane's output changes before the drop: the reconnect re-reads it 250 ms later, and output
    // written after the drop could miss that read (GY-3261).
    f.current.gap = 'output produced during the gap'; await f.save();
    f.child.send('drop-terminals');
    await expect.poll(f.reconnects, settled).toBe(1);
    await expect(page.locator('.xterm-rows')).toContainText(f.current.gap, settled);
    expect(await page.evaluate(() => (window as any).survivedDrop)).toBe(true);
    // GY-3813: Chromium holds a WebSocket frame that arrives while offline, and the dropped socket's
    // close waits behind it: the reconnect's live screen, its last frame, lands before the network goes.
    await expect(page.locator('.xterm-rows')).toContainText('screen of w1:master');
    // A failed reconnect while offline must keep retrying once the network returns.
    await page.context().setOffline(true);
    f.current.gap = 'output while offline'; await f.save();
    f.child.send('drop-terminals');
    await expect.poll(f.reconnects, settled).toBe(2);
    await page.waitForTimeout(300);
    await page.context().setOffline(false);
    await expect(page.locator('.xterm-rows')).toContainText(f.current.gap, settled);
    f.current.master.pane = 'w1:replacement'; f.current.master.account = 'second-account'; f.current.status = 'working'; await f.save();
    await expect(page.locator('.xterm-rows')).toContainText('screen of w1:replacement');
    await expect(page.getByRole('status')).toContainText('Working · second-account');
    await expect(page.locator('.terminal-session')).toHaveAttribute('title', 'codex · w1:replacement');
    f.current.master.pane = null; f.current.master.agentName = ''; await f.save();
    await expect(page.getByRole('status')).toContainText('Lead is restarting…');
    f.child.send('drop-terminals');
    await expect(page.locator('.live-terminal')).toHaveAttribute('data-terminal', 'control');
    await expect(page.getByRole('status')).toContainText('Lead is restarting…');
    await expect(page.locator('.terminal-session')).toHaveAttribute('title', 'codex · No pane');
    f.current.master.pane = 'w1:returned'; f.current.master.agentName = 'master'; await f.save();
    await expect(page.locator('.xterm-rows')).toContainText('screen of w1:returned');
  } finally { await f.stop(); }
});

test('e2e:master-page-phone — fits 390x844 and phone keys reach the pane', async ({ browser, server }) => {
  const f = await fixture(browser, server, true), { page } = f;
  try {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = await page.locator('.terminal-host').boundingBox(); expect(box!.width).toBeLessThan(390); expect(box!.height).toBeGreaterThan(300);
    const keys = page.getByRole('group', { name: 'Terminal keys' });
    for (const name of ['Esc', 'Tab', 'Ctrl-C', '←', '↓', '↑', '→', 'Enter']) await keys.getByRole('button', { name, exact: true }).click();
    await expect.poll(f.inputs, fastPoll).toEqual(['\x1b', '\t', '\x03', '\x1b[D', '\x1b[B', '\x1b[A', '\x1b[C', '\r']);
  } finally { await f.stop(); }
});
