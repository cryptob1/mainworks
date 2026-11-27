// Generates the README's and docs/setup.md's real-dashboard media files under docs/media/:
//   - docs/media/work.png   (1600x900, Work page with changes across stages)
//   - docs/media/change.png (1600x900, one change with goal, green proofs, diff summary, reviewer verdict)
//   - docs/media/lead.png   (1600x900, Lead page with plain-language status and one Needs you item)
//   - docs/media/hero.gif + docs/media/hero.mp4 (1600x900, ~18s lifecycle recording, < 4 MB)
//   - docs/media/setup-connect.png and docs/media/setup-first-goal.png (1600x900, the getting-started steps 3 and 4)
//
// Usage: npm run docs:media
// Serves the built dist/ dashboard on a local loopback port with seeded demo data only.
// Nothing leaves the machine and no real project, person, token, host or internal id is used.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoPage, launchBrowser, startDemoServer } from './demo-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const outDir = join(root, 'docs', 'media');

async function main() {
  if (!existsSync(join(dist, 'index.html'))) {
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  }
  await mkdir(outDir, { recursive: true });

  const { server, setPhase } = startDemoServer(dist);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchBrowser();
  const page = await demoPage(browser, root, { width: 1600, height: 900 });

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

  // 4. setup-connect.png — the Setup page with one agent account connected and one not yet (docs/setup.md step 3).
  setPhase('setup');
  await page.goto(`${origin}/#setup`);
  await page.reload();
  await page.getByRole('heading', { name: 'Set up Mainworks', level: 1 }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, 'setup-connect.png'), fullPage: false });
  console.log('wrote docs/media/setup-connect.png');

  // 5. setup-first-goal.png — the New work item box with a one-sentence goal typed in (docs/setup.md step 4).
  setPhase('before-create');
  await page.goto(`${origin}/#work`);
  await page.reload();
  await page.getByRole('heading', { name: 'Work', level: 1 }).waitFor();
  await page.getByRole('button', { name: '＋ New work item' }).click();
  await page.getByRole('dialog', { name: 'New work item' }).waitFor();
  await page.locator('input[name="title"]').fill('Add a /health page that returns ok.');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, 'setup-first-goal.png'), fullPage: false });
  console.log('wrote docs/media/setup-first-goal.png');
  setPhase('static');

  // 6. hero.gif + hero.mp4 — ~18s recording: type goal -> appears on Work -> review -> testing -> Merged -> Live.
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
