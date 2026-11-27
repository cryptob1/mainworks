import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveReviewHead, ServeTurnTakenError } from '../src/review-serve.js';
import { freePort } from '../src/serve-app.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3751: two runs of one project's e2e serve never collide on its address. Each run is given its
// own free port as PORT and MAINWORKS_SERVE_PORT; a command that binds the declared port anyway is
// detected, and that project's runs then take turns on the declared address: a later run is told to wait its turn.

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

test('unit:e2e-serve-runs-do-not-collide — two runs of a fixed-port serve run one after the other: the later one is told to take its turn, never parked', async () => {
  const declaredPort = await freePort(), declared = `http://127.0.0.1:${declaredPort}/healthz`;
  const { root, worktree } = await project(stub(`const port = ${declaredPort};`));
  const serve = { command: 'node serve-it.mjs', url: declared, readySeconds: 30 };
  const runs = ['one', 'two'].map(id => serveReviewHead({ root, id, worktree, serve, env: env(), containment: 'setsid' }).then(served => ({ id, served }), error => ({ id, error })));
  const [first, second] = await Promise.all(runs);
  const earlier = 'served' in first! ? first : second!, turned = earlier === first ? second! : first!;
  assert.ok('served' in earlier, 'one run serves');
  assert.equal(earlier.served.url, new URL(declared).origin, 'a fixed-port command is served on the declared address');
  assert.ok('error' in turned && turned.error instanceof ServeTurnTakenError, 'the other run is told to take its turn while the declared address is served');
  assert.ok((turned as { error: Error }).error.message.includes(declared), 'the turn names the served address');
  await earlier.served.close();
  const later = await serveReviewHead({ root, id: turned.id, worktree, serve, env: env(), containment: 'setsid' });
  try {
    assert.equal(later.url, new URL(declared).origin, 'the later run serves the declared address once it is free');
    assert.ok(await answers(declared), 'the later run is ready');
  } finally { await later.close(); }
});
