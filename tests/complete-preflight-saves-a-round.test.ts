import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listen } from './helpers/http-server.js';
import { git, gitRepo } from './helpers/git-repo.js';

// GY-3638 AC-2: a stub Builder submits a head whose proof id is missing from its test title.
// complete refuses within 10 seconds naming the proof id, the item stays in build with the same
// lease and epoch, and no review or trial is requested; after the title is fixed, the same
// complete is accepted.

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const proofId = 'unit:stub-builder-proof';

async function stubPlane() {
  const item = {
    id: 'id-1',
    key: 'GY-1',
    type: 'bug',
    stage: 'build',
    lease: { epoch: 1, owner: 'stub-builder' },
    submission: null as null | { epoch: number; head: string },
    criteria: [{ id: 'AC-1', text: 'Stub builder proof', proofs: [proofId] }],
  };
  const requests: { method: string; url: string; body?: any }[] = [];
  const { url, close } = await listen(async (req, res) => {
    res.on('error', () => {});
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/healthz') return send(200, {});
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const parsed = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method ?? '', url: req.url ?? '', body: parsed });
    if (req.method === 'GET' && req.url === '/api/work/GY-1') return send(200, item);
    if (req.method === 'POST' && req.url === '/api/work/id-1/submit') {
      item.stage = 'review';
      item.submission = { epoch: parsed.epoch, head: parsed.head };
      item.lease = null as any;
      return send(200, item);
    }
    return send(404, {});
  });
  return {
    url: url,
    item,
    requests,
    close: close,
  };
}

async function runComplete(url: string, root: string, head: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_URL: url, GRAPHYARD_TOKEN: 'stub-builder-token-0123456789abcdef' };
  delete env.GRAPHYARD_TOKEN_FILE;
  delete env.GRAPHYARD_REQUEST_ID;
  try {
    const out = await exec(process.execPath, [launcher, 'complete', 'GY-1', '1', '--head', head], { cwd: root, env, timeout: 15_000 });
    return { ok: true as const, stdout: out.stdout, stderr: out.stderr };
  } catch (error: any) {
    return { ok: false as const, code: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

test('e2e:complete-preflight-saves-a-round — complete refuses a head missing its proof id within 10s without touching lease or requesting review/trial, and accepts once the title is fixed', async () => {
  const { root, head } = await gitRepo({ label: 'complete-preflight-e2e', files: { '.gitignore': '.graphyard/\n' } });
  git(root, 'update-ref', 'refs/remotes/origin/main', head);

  git(root, 'checkout', '--quiet', '-b', 'graphyard/gy-1-1');
  await mkdir(join(root, 'tests'), { recursive: true });
  await writeFile(join(root, 'tests', 'stub.test.ts'), "import { test } from 'node:test';\ntest('missing the proof id', () => {});\n");
  git(root, 'add', 'tests/stub.test.ts');
  git(root, 'commit', '--quiet', '-m', 'unlabeled test');
  const badHead = git(root, 'rev-parse', 'HEAD');

  const plane = await stubPlane();
  try {
    // 1. Submit with missing proof id -> refused within 10s, proof id named, lease/epoch intact, no submit/review/trial.
    const started = performance.now();
    const refused = await runComplete(plane.url, root, badHead);
    const elapsedMs = performance.now() - started;

    assert.equal(refused.ok, false, 'complete must refuse a head missing its proof id');
    assert.ok(elapsedMs < 10_000, `refusal took ${Math.round(elapsedMs)}ms, expected < 10000ms`);
    assert.ok(`${refused.stdout}\n${refused.stderr}`.includes(proofId), `refusal must name ${proofId}: ${refused.stderr}`);
    assert.equal(plane.item.stage, 'build', 'item stays in build');
    assert.deepEqual(plane.item.lease, { epoch: 1, owner: 'stub-builder' }, 'same lease and epoch kept');
    assert.equal(plane.item.submission, null, 'no submission recorded');
    assert.equal(plane.requests.filter(req => req.method === 'POST').length, 0, 'no submit, review, or trial requested');

    // 2. Fix the test title, commit, and run complete again -> accepted.
    await writeFile(join(root, 'tests', 'stub.test.ts'), `import { test } from 'node:test';\ntest('${proofId} — works', () => {});\n`);
    git(root, 'add', 'tests/stub.test.ts');
    git(root, 'commit', '--quiet', '-m', 'add proof id to test title');
    const goodHead = git(root, 'rev-parse', 'HEAD');

    const accepted = await runComplete(plane.url, root, goodHead);
    assert.equal(accepted.ok, true, `complete should accept fixed head: ${accepted.ok ? '' : accepted.stderr}`);
    assert.equal(plane.item.stage, 'review', 'accepted submission moves item to review');
    assert.deepEqual(plane.item.submission, { epoch: 1, head: goodHead });
  } finally { await plane.close(); } });
