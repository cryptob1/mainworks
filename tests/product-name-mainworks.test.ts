import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const exec = promisify(execFile);

// GY-3572: package.json installs both command names for the one CLI; each prints the Mainworks help.
test('e2e:product-name-mainworks — mainworks and graphyard are the same CLI and print Mainworks help', async () => {
  const bin = JSON.parse(await readFile('package.json', 'utf8')).bin as Record<string, string>;
  assert.equal(bin.mainworks, bin.graphyard, 'both names point at the same file');
  const dir = await temporaryDirectory('product-name');
  try {
    // Each command name on PATH, as npm links a package's bin entries.
    for (const name of ['mainworks', 'graphyard']) await writeFile(join(dir, name), `#!/bin/sh\nexec "${process.execPath}" "${resolve(bin[name])}" "$@"\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
    for (const name of ['mainworks', 'graphyard']) {
      const help = await exec(name, ['--help'], { env, cwd: dir });
      assert.match(help.stdout, /^Mainworks /, `${name} --help names Mainworks`);
      assert.match(help.stdout, /Usage: mainworks COMMAND/, `${name} --help shows mainworks usage`);
      assert.doesNotMatch(help.stdout, /Graphyard/, `${name} --help never names Graphyard as the product`);
      const guide = await exec(name, ['guide'], { env, cwd: dir });
      assert.match(guide.stdout, /^Mainworks guide topics/, `${name} guide names Mainworks`);
      assert.match(guide.stdout, /mainworks guide TOPIC/, `${name} guide shows mainworks usage`);
      const setup = await exec(name, ['guide', 'setup'], { env, cwd: dir });
      assert.match(setup.stdout, /^Mainworks runs on a Linux host\./, `${name} guide setup names Mainworks`);
      assert.doesNotMatch(setup.stdout, /Graphyard/, `${name} guide setup never names Graphyard as the product`);
      const infra = await exec(name, ['guide', 'infra'], { env, cwd: dir });
      assert.match(infra.stdout, /Mainworks's files/, `${name} guide infra names Mainworks`);
      assert.doesNotMatch(infra.stdout, /Graphyard/, `${name} guide infra never names Graphyard as the product`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
