import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3670: the pipeline world's loop serves an item preview of every open item that cites a fixture
// case. A preview that opened (its trials directory already there) kept its static server listening
// after the test passed, so the test file's process never exited and the 300 s file timeout failed it.

test('unit:pipeline-gate-known-red-pinned — a static site served and never closed does not keep its process alive', { timeout: 60_000 }, async () => {
  const site = await temporaryDirectory('static-site-unref');
  await mkdir(site, { recursive: true });
  await writeFile(join(site, 'index.html'), '<!doctype html><title>site</title>\n');
  const module = new URL('../src/merge-writer/serve-head.ts', import.meta.url).href;
  const script = `const { serveStaticSite } = await import(${JSON.stringify(module)});
const served = await serveStaticSite(${JSON.stringify(site)}, '${'a'.repeat(40)}');
const answer = await fetch(served.url, { headers: { connection: 'close' } });
console.log(answer.status);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = await new Promise<boolean>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 20_000);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
  assert.match(output, /^200$/m, output);
  assert.ok(exited, 'the process exits on its own while the static site is still served');
});
