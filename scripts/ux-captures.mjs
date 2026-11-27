// GY-3962: every dashboard page and state, captured at 390 and 1280 px from the demo data
// (scripts/docs-media-demo.mjs), for the newcomer pass in docs/ux-findings.md.
//
// Usage: npm run ux:captures [-- OUT_DIR]   (default .graphyard/ux-captures, not committed; the
// ux-rules-hold-at-390-and-1280 case writes them to its E2E_SCREENSHOTS_DIR, so they attach to the run)
// Each capture is a full-page PNG named WIDTH-PAGE.png with its visible text beside it as WIDTH-PAGE.txt; a page that scrolls sideways is listed at the end.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoPage, launchBrowser, startDemoServer } from './demo-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const outDir = resolve(process.argv[2] ?? join(root, '.graphyard', 'ux-captures'));

const nav = (page, name) => page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name, exact: true }).click();
const tab = (page, name) => page.getByRole('tab', { name, exact: true }).click();
const hash = (page, id) => page.evaluate((h) => { location.hash = h; }, id);

/** [name, phase, signed in, how to reach it from a fresh load of #home]. */
const shots = [
  ['sign-in', 'static', false, async () => {}],
  ['first-run', 'empty', true, async () => {}],
  ['error', 'error', true, async () => {}],
  ['home', 'static', true, async () => {}],
  ['work', 'static', true, async (p) => nav(p, 'Work')],
  ...['Checks and diff', 'Live session', 'Lead', 'Details'].map((name) => [`change-${name.toLowerCase().replace(/ /g, '-')}`, 'static', true, async (p) => {
    await nav(p, 'Work');
    await p.getByRole('link', { name: /Rate-limit the login endpoint/ }).click();
    await tab(p, name);
  }]),
  ['change-details-open', 'static', true, async (p) => {
    await nav(p, 'Work');
    await p.getByRole('link', { name: /Rate-limit the login endpoint/ }).click();
    await tab(p, 'Details');
    await p.locator('details.more-details > summary').click();
  }],
  ['new-work-item', 'static', true, async (p) => { await nav(p, 'Work'); await p.getByRole('button', { name: /New work item/ }).click(); }],
  ['needs-you', 'static', true, async (p) => hash(p, 'needs-you')],
  ['tests', 'static', true, async (p) => hash(p, 'tests')],
  ...['Conversation', 'Live session', 'History'].map((name) => [`lead-${name.toLowerCase().replace(/ /g, '-')}`, 'static', true, async (p) => { await nav(p, 'Lead'); await tab(p, name); }]),
  ['product', 'static', true, async (p) => hash(p, 'product')],
  ...['agents', 'workers', 'costs', 'setup', 'delivery', 'guide'].map((id) => [`settings-${id}`, 'static', true, async (p) => hash(p, id)]),
  ['setup-connect', 'setup', true, async (p) => hash(p, 'setup')],
];

async function main() {
  if (!existsSync(join(dist, 'index.html'))) execFileSync('npx', ['vite', 'build', '--configLoader', 'runner'], { cwd: root, stdio: 'inherit' });
  await mkdir(outDir, { recursive: true });
  const { server, setPhase } = startDemoServer(dist);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchBrowser();
  const sideways = [];
  try {
    for (const width of [390, 1280]) {
      for (const [name, phase, signedIn, reach] of shots) {
        setPhase(phase);
        const page = await demoPage(browser, root, { width, height: 900 }, { signedIn });
        await page.goto(`${origin}/${signedIn ? '#home' : '?sign-in'}`);
        await page.waitForTimeout(600);
        await reach(page);
        await page.waitForTimeout(500);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (over > 0) sideways.push(`${width}-${name} (+${over} px)`);
        await page.screenshot({ path: join(outDir, `${width}-${name}.png`), fullPage: true });
        await writeFile(join(outDir, `${width}-${name}.txt`), await page.evaluate(() => document.body.innerText));
        await page.context().close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`wrote ${shots.length * 2} captures to ${outDir}`);
  console.log(sideways.length ? `scrolls sideways: ${sideways.join(', ')}` : 'no page scrolls sideways');
}

await main();
