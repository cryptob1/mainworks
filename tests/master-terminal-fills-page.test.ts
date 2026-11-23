import test from 'node:test';
import assert from 'node:assert/strict';
import { fillsThePage, type FillSample } from '../browser-tests/terminal-fill.js';
import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { terminalStream } from '../src/master/terminal-session.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/** A screen that fills its container: the pane's last column is at the right edge, its rows fill the height. */
const filled: FillSample = { right: 0.2, bottom: 0.3, drawnRows: 24, rows: 24, documentScrolls: false };

/** A page whose measurements follow SCRIPT and then hold LAST forever, as the Master page's terminal does. */
const scripted = (script: (FillSample | null)[], last: FillSample | null) => ({
  page: {
    evaluate: async () => script.length ? script.shift()! : last,
    waitForTimeout: (ms: number) => new Promise<void>(done => setTimeout(done, ms)),
  } as unknown as Page,
});

test(`unit:test-browser-tests-master-terminal-fills-page-spec-ts-pinned — the fill check waits for the fill to hold
across a reconnect's asynchronous buffer rewrite instead of measuring one instant, and still fails a pane that does not fill its page`, async () => {
  // The reconnect race (GY-3372): the pane still shows the pre-drop screen (filled), then the
  // reattach's scrollback rewrite blanks it mid-render (null) before the live redraw repaints it.
  // Measuring one instant passed on the stale screen and then crashed reading the null sample.
  const raced = scripted([filled, null, null, filled], filled);
  await fillsThePage(raced.page, 2_000, 60, 1);
  // A pane whose drawing leaves a gap, or a page whose document scrolls, never holds the window,
  // so the check still fails on a pane that does not fill its page.
  const gapped = scripted([], { ...filled, right: 5 });
  await assert.rejects(fillsThePage(gapped.page, 150, 60, 1), /does not fill its container/);
  const scrolling = scripted([], { ...filled, documentScrolls: true });
  await assert.rejects(fillsThePage(scrolling.page, 150, 60, 1), /does not fill its container/);
});

const setEnv = (overrides: Record<string, string>) => {
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
};

test(`unit:test-browser-tests-master-terminal-fills-page-spec-ts-pinned — a read-only viewer whose control request meets a stream
that is just leaving asks once more and sizes the pane to its page, instead of watching it at the pane's old layout for good`, async () => {
  const site = await temporaryDirectory('gy-3372');
  const stub = 'fixtures/herdr-terminal-stub';
  const restoreEnv = setEnv({ PATH: `${resolve(stub)}${delimiter}${process.env.PATH}`, HERDR_STUB_LOG: join(site, 'herdr.log'), HERDR_STUB_STATE: join(site, 'state.json'), GRAPHYARD_HERDR_CONFIG_HOME: '', HERDR_SOCKET_PATH: '' });
  // The pane Herdr laid out at 70 columns, and a previous stream (a reconnect's own, or a closed page's)
  // still holding its control for the moment detach takes to end it.
  await writeFile(join(site, 'state.json'), JSON.stringify({ pane: { cols: 70, rows: 20 } }));
  const leaving = spawn('sleep', ['1.5']);
  await writeFile(join(site, 'herdr.log.w1:master.control'), String(leaving.pid));
  // The width the pane's ruler is drawn at: its first row runs to the pane's last column.
  const widths: number[] = [];
  const stream = terminalStream({ control: false, pane: 'w1:master', cols: '100', rows: '30' }, {
    line: line => { const message = JSON.parse(line); if (message.type === 'terminal.frame') widths.push(/row 1 =*\|/.exec(Buffer.from(message.bytes, 'base64').toString())![0].length); },
    exit: reason => { throw new Error(reason); },
  }, undefined, null);
  try {
    for (const deadline = Date.now() + 8_000; !widths.length && Date.now() < deadline;) await new Promise(done => setTimeout(done, 50));
    assert.deepEqual(widths, [100], 'the pane is drawn at the viewer\'s 100 columns, not watched at its 70-column layout');
  } finally {
    await stream.end(); leaving.kill(); restoreEnv();
    await rm(site, { recursive: true, force: true });
  }
});

test('unit:master-terminal-fills-page-pinned — stream.end() waits for the detached herdr child to finish closing before teardown removes its directory', async () => {
  const site = await temporaryDirectory('gy-3736');
  const stub = 'fixtures/herdr-terminal-stub';
  const restoreEnv = setEnv({
    PATH: `${resolve(stub)}${delimiter}${process.env.PATH}`,
    HERDR_STUB_LOG: join(site, 'herdr.log'),
    HERDR_STUB_STATE: join(site, 'state.json'),
    GRAPHYARD_HERDR_CONFIG_HOME: '',
    HERDR_SOCKET_PATH: '',
  });
  await writeFile(join(site, 'state.json'), JSON.stringify({ pane: { cols: 70, rows: 20 } }));
  let framed = false;
  const stream = terminalStream({ control: false, pane: 'w1:master', cols: '100', rows: '30' }, {
    line: line => { if (JSON.parse(line).type === 'terminal.frame') framed = true; },
    exit: reason => { throw new Error(reason); },
  }, undefined, null);
  try {
    for (const deadline = Date.now() + 8_000; !framed && Date.now() < deadline;) await new Promise(done => setTimeout(done, 20));
    assert.equal(framed, true, 'the terminal stream opened and drew a frame');
    await stream.end();
    const log = await readFile(join(site, 'herdr.log'), 'utf8');
    assert.match(log, /"detached":true/, 'stream.end() waits for the detached herdr child to finish its shutdown write');
    await rm(site, { recursive: true, force: true });
  } finally {
    await stream.end();
    restoreEnv();
  }
});
