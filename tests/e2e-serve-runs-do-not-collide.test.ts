import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveReviewHead } from '../src/review-serve.js';
import { freePort } from '../src/serve-app.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3751: two runs of one project's e2e serve never collide on its address. Each run is given its
// own free port as PORT and MAINWORKS_SERVE_PORT; a command that binds the declared port anyway is
// detected, and that project's runs then take turns on the declared address instead of failing.

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

const stub = (body: string) => `import { createServer } from 'node:http';
${body}
createServer((_request, response) => response.end(String(port))).listen(port, '127.0.0.1');
`;
async function project(script: string) {
  const root = await temporaryDirectory('e2e-serve-runs-root'), worktree = await temporaryDirectory('e2e-serve-runs-worktree');
  directories.push(root, worktree);
  await writeFile(join(worktree, 'serve-it.mjs'), script);
  return { root, worktree };
}
const answers = (url: string) => fetch(url, { signal: AbortSignal.timeout(2_000) }).then(response => response.ok, () => false);
const env = () => ({ PATH: process.env.PATH ?? '' });

test('unit:e2e-serve-runs-do-not-collide — two concurrent runs of a port-aware serve are both ready, each on its own port', async () => {
  const declaredPort = await freePort(), declared = `http://127.0.0.1:${declaredPort}/healthz`;
  const { root, worktree } = await project(stub(`const port = Number(process.env.PORT) || ${declaredPort};`));
  const serve = { command: 'node serve-it.mjs', url: declared, readySeconds: 30 };
  const [one, two] = await Promise.all(['one', 'two'].map(id => serveReviewHead({ root, id, worktree, serve, env: env(), containment: 'setsid' })));
  try {
    assert.notEqual(one!.url, two!.url, 'each run serves on its own port');
    for (const served of [one!, two!]) {
      assert.notEqual(new URL(served.url).port, String(declaredPort), 'never the declared port');
      assert.ok(await answers(served.url), `${served.url} answers`);
    }
  } finally { await Promise.all([one!.close(), two!.close()]); }
});

test('unit:e2e-serve-runs-do-not-collide — two runs of a fixed-port serve run one after the other, neither refused', async () => {
  const declaredPort = await freePort(), declared = `http://127.0.0.1:${declaredPort}/healthz`;
  const { root, worktree } = await project(stub(`const port = ${declaredPort};`));
  const serve = { command: 'node serve-it.mjs', url: declared, readySeconds: 30 };
  const ready: string[] = [];
  const runs = ['one', 'two'].map(id => serveReviewHead({ root, id, worktree, serve, env: env(), containment: 'setsid' }).then(served => { ready.push(id); return { id, served }; }));
  const earlier = await Promise.race(runs);
  assert.equal(earlier.served.url, new URL(declared).origin, 'a fixed-port command is served on the declared address');
  await new Promise(accept => setTimeout(accept, 1_500));
  assert.deepEqual(ready, [earlier.id], 'the other run waits while the declared address is served');
  await earlier.served.close();
  const later = await runs.find((_run, index) => ['one', 'two'][index] !== earlier.id)!;
  try {
    assert.equal(later.served.url, new URL(declared).origin, 'the later run serves the declared address once it is free');
    assert.ok(await answers(declared), 'the later run is ready');
  } finally { await later.served.close(); }
});
