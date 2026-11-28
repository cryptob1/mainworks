import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { useTestStore } from './helpers/test-store.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { api, apiOk } from './helpers/api.js';
import { registryCommand } from '../src/cli/master-registry.js';
import { plannerPrompt } from '../src/daemon/planner.js';
import { masterGuide } from '../src/master/guide.js';
import type { Principal } from '../src/model.js';

const admin: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const principals = [admin, worker];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(40)}`]));
const tokenOf = (p: Principal) => tokens.get(p.id)!;
const HOST = 'onboarding-host-1';

let url = '';
useTestStore(
  'onboarding-small-fixes',
  {
    repository: 'owner/ohuck',
    principals,
    credentials: principals.map(p => ({ ...p, token: tokenOf(p) })),
  },
  ctx => { url = ctx.url; },
);

const call = (path: string, actor: Principal, body?: unknown) => api(url, tokenOf(actor), path, body === undefined ? undefined : { body });
const ok = (path: string, actor: Principal, body?: unknown) => apiOk(url, tokenOf(actor), path, body === undefined ? undefined : { body });

test('integration:onboarding-small-fixes — account set @FILE, unique open backlog titles, system-filed item criteria, plain no-waiver product-review refusal, and planner deploy SHA guidance', async () => {
  const scratch = await temporaryDirectory('onboarding-small-fixes');

  // 1. account set @FILE accepts flat host/home and observed document fields.
  await ok('agent-registry/runtimes', admin, {
    runtime: { name: 'claude', launch: { kind: 'claude' } },
    reason: 'setup runtime',
  });
  await ok('agent-registry/models', admin, {
    model: { name: 'opus', id: 'claude-opus-4-6' },
    reason: 'setup model',
  });

  const registryApi = {
    read: async (path: string) => ok(path, admin),
    write: async (path: string, data: unknown) => ok(path, admin, data),
  };

  const flatFile = join(scratch, 'account-flat.json');
  await writeFile(flatFile, JSON.stringify({
    name: 'claude-ohuck',
    runtime: 'claude',
    model: 'opus',
    host: HOST,
    home: '/home/ohuck/.claude',
    quota: { state: 'available' },
    eligible: true,
    note: null,
  }), 'utf8');

  const stored = await registryCommand({ hostId: HOST }, ['account', 'set', `@${flatFile}`, '--reason', 'configure ohuck account'], registryApi);
  assert.ok(stored, 'account set @FILE succeeds');
  const doc = await ok('agent-registry/document', admin);
  const account = doc.accounts.find((entry: { name: string }) => entry.name === 'claude-ohuck');
  assert.ok(account, 'account stored in registry');
  assert.equal(account.credential.host, HOST);
  assert.equal(account.credential.home, '/home/ohuck/.claude');

  // 2. Creating an item whose title matches an open item is refused with the existing key.
  const first = await ok('work', admin, {
    title: 'Deploy landing page',
    why: 'Ship the landing page so users can visit it.',
    simplest: 'Deploy the static build and verify its served SHA.',
    type: 'chore',
    priority: 1,
    criteria: [{ id: 'AC-1', text: 'Health route serves the deployed SHA', proofs: ['e2e:smoke'] }],
  });
  assert.ok(first.key, 'first item created');

  const duplicate = await call('work', admin, {
    title: '  deploy landing page  ',
    why: 'Duplicate filing should be refused.',
    simplest: 'Refuse duplicate open titles.',
    type: 'chore',
    priority: 2,
    criteria: [{ id: 'AC-1', text: 'Duplicate', proofs: ['e2e:smoke'] }],
  });
  assert.equal(duplicate.status, 409, 'duplicate open title is refused with 409');
  assert.ok(String(duplicate.body?.error ?? '').includes(first.key), `refusal names existing key ${first.key}, got: ${duplicate.body?.error}`);

  // Once the open item is closed, reusing the title is allowed.
  await ok(`work/${first.key}/close`, admin, { reason: 'superseded in test' });
  const reopened = await ok('work', admin, {
    title: 'Deploy landing page',
    why: 'Re-filed after prior item closed.',
    simplest: 'Allowed because no open item holds this title.',
    type: 'chore',
    priority: 2,
    criteria: [{ id: 'AC-1', text: 'Health route serves the deployed SHA', proofs: ['e2e:smoke'] }],
  });
  assert.notEqual(reopened.key, first.key);

  // 3. System-filed items get at least one criterion even when filed with criteria: [].
  const systemFiled = await ok('work', admin, {
    title: 'Tighten deploy health check',
    why: 'Verify the served commit after each deploy.',
    simplest: 'Check the health route returns the deployed SHA.',
    type: 'chore',
    priority: 2,
    criteria: [],
    faultKey: 'loop-step-stall:deploy',
    reason: 'Loop-filed fault.',
  });
  assert.ok(Array.isArray(systemFiled.criteria) && systemFiled.criteria.length >= 1, 'system-filed item gets at least one criterion');
  assert.equal(systemFiled.criteria[0].id, 'AC-1');
  assert.ok(systemFiled.criteria[0].text.length > 0, 'criterion has text');
  const draft = await ok('work', admin, { title: 'Planner draft', why: 'Idea.', simplest: 'Small.', type: 'feature', priority: 2, criteria: [], origin: 'planner', reason: 'Empty-board planner draft.' });
  assert.deepEqual(draft.criteria, [], 'a planner draft stays without criteria until the Lead writes them');

  // 4. Product-review refusal for a static page says in one line that product review is not waived.
  const productRefusal = await call(`work/${reopened.key}/product-review`, worker, {
    sha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    verdict: 'approved',
    reviewer: 'self',
    findings: 'Static page, waive product review',
  });
  assert.equal(productRefusal.status, 403);
  const refusalText = String(productRefusal.body?.error ?? '');
  assert.ok(!refusalText.includes('\n'), 'product-review refusal is one line');
  assert.match(refusalText, /product review is not waived/i, 'refusal says product review is not waived');
  assert.match(masterGuide, /product review is not waived/i, 'master guide says product review is not waived');

  // 5. Planner guide says a deploy item's criteria prove the served SHA from the project's health or version route, not a merged config.
  const prompt = plannerPrompt({ brief: 'Ship OHuck.', flow6h: null, slowestTrialFiles: [], openTitles: [] });
  assert.match(prompt, /deploy.*served SHA.*health or version route.*not a merged config/i, 'planner prompt requires deploy items to prove served SHA from health or version route');
  assert.match(masterGuide, /deploy.*served SHA.*health or version route.*not a merged config/i, 'master guide requires deploy items to prove served SHA from health or version route');
});
