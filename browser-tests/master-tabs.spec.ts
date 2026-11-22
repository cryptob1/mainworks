import { test, expect, type Page } from '@playwright/test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { symlink, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { withDatabase } from '../tests/helpers/postgres';
import { temporaryDirectory } from '../tests/helpers/temp-dirs';
import { bridgeTerminals } from '../src/master/terminal-bridge';
import { terminalSessionReader } from '../src/master/terminal-session';
import type { MasterConfig } from '../src/master/profiles';
import { terminalInputEvent } from '../src/server/terminal';
import { serveXterm } from './xterm';

const settled = { timeout: 15_000 };

async function assertNoDocumentScroll(page: Page, context: string) {
  const metrics = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollY: window.scrollY,
    scrollX: window.scrollX,
  }));
  expect(metrics.scrollHeight, `${context}: scrollHeight === clientHeight`).toBe(metrics.clientHeight);
  expect(metrics.scrollWidth, `${context}: scrollWidth === clientWidth`).toBe(metrics.clientWidth);
  expect(metrics.scrollY, `${context}: scrollY === 0`).toBe(0);
  expect(metrics.scrollX, `${context}: scrollX === 0`).toBe(0);
}

test('e2e:master-tabs — the Lead page has Conversation, Live session, History and Messages tabs in a keyboard-navigable URL-backed tablist and never scrolls the document at 1280x800 and 390x844', async ({ browser }) => {
  test.setTimeout(180_000);
  const site = await temporaryDirectory('master-tabs');
  await symlink(resolve('.graphyard/browser-dist'), join(site, 'dist'));
  const database = await withDatabase('master_tabs');
  await database.init();

  // Seed 300 typed lines in the events table for the History tab.
  const values: string[] = [];
  const params: unknown[] = [];
  for (let i = 1; i <= 300; i++) {
    const base = (i - 1) * 3;
    values.push(`(NULL, $${base + 1}, $${base + 2}, $${base + 3})`);
    params.push('operator', terminalInputEvent, JSON.stringify({ pane: 'w1:master', line: `seeded command ${String(i).padStart(3, '0')}` }));
  }
  await database.pool.query(`INSERT INTO events(work_id, actor, kind, payload) VALUES ${values.join(',')}`, params);

  const child = fork(resolve('tests/helpers/terminal-server.ts'), [(database.pool.options as { connectionString: string }).connectionString, site], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, PATH: join(site, 'empty'), HOME: site, GRAPHYARD_HERDR_CONFIG_HOME: '', GRAPHYARD_HERDR_SESSION: '' },
  });
  const [{ url }] = await once(child, 'message') as [{ url: string }];

  const original = { ...process.env };
  process.env.PATH = `${resolve('fixtures/herdr-terminal-stub')}${delimiter}${process.env.PATH}`;
  process.env.HERDR_STUB_LOG = join(site, 'herdr.log');
  process.env.HERDR_STUB_STATE = join(site, 'master.daemon.json');
  process.env.GRAPHYARD_HERDR_CONFIG_HOME = '';
  process.env.GRAPHYARD_HERDR_SESSION = '';
  await writeFile(join(site, 'master.daemon.json'), JSON.stringify({
    master: { agentName: 'master', pane: 'w1:master', account: 'test-account', runtime: 'codex' },
    status: 'idle',
  }));
  const stopping = new AbortController();
  await new Promise<void>(done => bridgeTerminals(url, 'test-coordinator', stopping.signal, done, terminalSessionReader(() => ({ credentialFile: join(site, 'master.token') }) as MasterConfig)));

  const post = async (bearer: string, path: string, body: unknown) => {
    const response = await fetch(`${url}/api/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<any>;
  };

  const openPage = async (viewport: { width: number; height: number }, hash = '#master') => {
    const context = await browser.newContext({ viewport });
    await serveXterm(context);
    const page = await context.newPage();
    await page.addInitScript(() => {
      let orig: any;
      Object.defineProperty(window, 'Terminal', {
        configurable: true,
        get: () => orig,
        set: value => {
          orig = class extends value {
            constructor(options: unknown) {
              super(options);
              (window as any).testTerminal = this;
            }
          };
        },
      });
    });
    const { code } = await post('test-human-operator', 'sign-in-links', {});
    await page.goto(`${url}/#sign-in=${code}&master`);
    await expect(page.getByRole('heading', { name: 'Lead', exact: true, level: 1 })).toBeVisible(settled);
    if (hash !== '#master') {
      await page.goto(`${url}/${hash}`);
    }
    return { context, page };
  };

  try {
    // 1. With no messages, Messages tab is hidden; Conversation is selected by default.
    {
      const { context, page } = await openPage({ width: 1280, height: 800 });
      try {
        const tablist = page.getByRole('tablist');
        const conversationTab = tablist.getByRole('tab', { name: 'Conversation' });
        const liveTab = tablist.getByRole('tab', { name: 'Live session' });
        const historyTab = tablist.getByRole('tab', { name: 'History' });
        const messagesTab = tablist.getByRole('tab', { name: 'Messages' });
        await expect(conversationTab).toHaveAttribute('aria-selected', 'true');
        await expect(liveTab).toHaveAttribute('aria-selected', 'false');
        await expect(historyTab).toHaveAttribute('aria-selected', 'false');
        await expect(messagesTab).toHaveCount(0);

        // Conversation tab shows the status line, the message box and no terminal screen.
        await expect(page.locator('.lead-status')).toBeVisible(settled);
        await expect(page.locator('#lead-message')).toBeVisible(settled);
        await expect(page.locator('.xterm-rows')).toHaveCount(0);

        // Keyboard navigation moves through the tablist.
        await conversationTab.focus();
        await page.keyboard.press('ArrowRight');
        await expect(liveTab).toHaveAttribute('aria-selected', 'true');
        await expect(liveTab).toBeFocused();
        await expect(page.locator('.xterm-rows')).toContainText('screen of w1:master', settled);
        await expect(page.locator('.lead-status')).toHaveCount(0);
        await page.keyboard.press('ArrowRight');
        await expect(historyTab).toHaveAttribute('aria-selected', 'true');
        await expect(historyTab).toBeFocused();
        await expect(page.locator('.typed-input')).toBeVisible(settled);
        await expect(page.locator('.typed-input')).toContainText('seeded command 300');
        await expect(page.locator('.terminal-host')).toHaveCount(0);

        // URL keeps the selected tab across reload.
        expect(page.url()).toContain('#master/history');
        await page.reload();
        await expect(page.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true', settled);
        await expect(page.locator('.typed-input')).toContainText('seeded command 300', settled);
        await expect(page.locator('.terminal-host')).toHaveCount(0);

        // Shared link opens the same tab directly.
        const shared = await context.newPage();
        await serveXterm(shared);
        await shared.goto(`${url}/#master/history`);
        await expect(shared.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true', settled);
        await expect(shared.locator('.typed-input')).toContainText('seeded command 300', settled);
        await shared.close();

        // Keyboard ArrowLeft returns to Live session.
        await page.getByRole('tab', { name: 'History' }).focus();
        await page.keyboard.press('ArrowLeft');
        await expect(page.getByRole('tab', { name: 'Live session' })).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.terminal-host')).toBeVisible(settled);
      } finally {
        await context.close();
      }
    }

    // 2. Seed messages so Messages tab appears, then verify all four tabs at 1280x800 and 390x844.
    const msgText = 'Cross-install message for tabs verification.';
    await post('test-install-a', 'master/messages', { text: msgText, thread: 'thread-tabs-1' });

    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }] as const) {
      const label = `${viewport.width}x${viewport.height}`;
      const { context, page } = await openPage(viewport);
      try {
        const tablist = page.getByRole('tablist');
        const conversationTab = tablist.getByRole('tab', { name: 'Conversation' });
        const liveTab = tablist.getByRole('tab', { name: 'Live session' });
        const historyTab = tablist.getByRole('tab', { name: 'History' });
        const messagesTab = tablist.getByRole('tab', { name: 'Messages' });

        await expect(conversationTab).toHaveAttribute('aria-selected', 'true', settled);
        await expect(messagesTab).toBeVisible(settled);
        await expect(page.locator('.lead-feed')).toBeVisible(settled);

        // Conversation tab: no document scroll; the feed scrolls inside its panel.
        await assertNoDocumentScroll(page, `${label} Conversation`);
        const feedMetrics = await page.locator('.lead-feed').evaluate(el => ({
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          scrollTop: el.scrollTop,
        }));
        expect(feedMetrics.scrollHeight, `${label} Conversation panel overflows internally`).toBeGreaterThanOrEqual(feedMetrics.clientHeight);
        const feedBox = (await page.locator('.lead-feed').boundingBox())!;
        await page.mouse.move(feedBox.x + feedBox.width / 2, feedBox.y + feedBox.height / 2);
        await page.mouse.wheel(0, 600);
        expect(await page.evaluate(() => window.scrollY), `${label} Conversation wheel leaves window.scrollY at 0`).toBe(0);
        await assertNoDocumentScroll(page, `${label} Conversation after wheel`);

        // Live session tab: the terminal, no document scroll, >=500 lines of scrollback, wheel scrolls only terminal.
        await liveTab.click();
        await expect(liveTab).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.xterm-rows')).toContainText('screen of w1:master', settled);
        await expect(page.locator('.lead-feed')).toHaveCount(0);
        await assertNoDocumentScroll(page, `${label} Live session`);
        const scrollbackLen = await page.evaluate(() => (window as any).testTerminal.buffer.active.length);
        expect(scrollbackLen).toBeGreaterThanOrEqual(500);
        const beforeViewportY = await page.evaluate(() => (window as any).testTerminal.buffer.active.viewportY);
        const termBox = (await page.locator('.terminal-host').boundingBox())!;
        await page.mouse.move(termBox.x + termBox.width / 2, termBox.y + termBox.height / 2);
        await page.mouse.wheel(0, -600);
        await expect.poll(() => page.evaluate(() => (window as any).testTerminal.buffer.active.viewportY)).toBeLessThan(beforeViewportY);
        expect(await page.evaluate(() => window.scrollY), `${label} Live session wheel leaves window.scrollY at 0`).toBe(0);
        await assertNoDocumentScroll(page, `${label} Live session after wheel`);

        // History tab: no document scroll, 300 seeded lines scroll inside its panel while window.scrollY stays 0.
        await historyTab.click();
        await expect(historyTab).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.typed-input')).toContainText('seeded command 300', settled);
        await expect(page.locator('.typed-input')).toContainText('seeded command 001', settled);
        await expect(page.locator('.terminal-host')).toHaveCount(0);
        await assertNoDocumentScroll(page, `${label} History`);

        const panelMetrics = await page.locator('.typed-input').evaluate(el => ({
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          scrollTop: el.scrollTop,
        }));
        expect(panelMetrics.scrollHeight, `${label} History panel overflows internally`).toBeGreaterThan(panelMetrics.clientHeight);
        const histBox = (await page.locator('.typed-input').boundingBox())!;
        await page.mouse.move(histBox.x + histBox.width / 2, histBox.y + histBox.height / 2);
        await page.mouse.wheel(0, 600);
        await expect.poll(() => page.locator('.typed-input').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
        expect(await page.evaluate(() => window.scrollY), `${label} History wheel leaves window.scrollY at 0`).toBe(0);
        await assertNoDocumentScroll(page, `${label} History after wheel`);

        // Messages tab: shows thread, no document scroll.
        await messagesTab.click();
        await expect(messagesTab).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('article', { name: 'Thread with install-a' })).toContainText(msgText, settled);
        await expect(page.locator('.terminal-host')).toHaveCount(0);
        await expect(page.locator('.typed-input')).toHaveCount(0);
        await assertNoDocumentScroll(page, `${label} Messages`);
      } finally {
        await context.close();
      }
    }
  } finally {
    stopping.abort();
    const ended = once(child, 'exit');
    child.send('stop');
    await ended;
    await database.close();
    process.env = original;
  }
});
