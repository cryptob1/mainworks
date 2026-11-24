import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { withDatabase } from './helpers/postgres.js';
import { checkRuntime, listedNames, runCommand, setVariable, type RunCommand } from '../src/runtime-check.js';
import { parseRepositoryConfig } from '../src/model-boundary/documentation.js';
import { applyRuntimeVariables } from '../src/master/runtime-variables.js';
import { hostKeyPair } from '../src/master/connect-accounts.js';
import { sealForHost } from '../web/seal.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

const runtime = (environments: object) => ({ runtime: { platform: 'railway', secrets: 'Railway variables, copied from AWS SSM', environments } });
/** An install directory whose runtime.json holds `environments`, at `mode`. */
const install = async (label: string, environments: object, mode = 0o600) => {
  const directory = await temporaryDirectory(label);
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({ environments }), { mode });
  return directory;
};

test('unit:runtime-check — each environment names the required variables its listing lacks; the commands come only from the install, and no value is kept', async () => {
  const root = await temporaryDirectory('runtime-check');
  await writeFile(join(root, 'graphyard.json'), JSON.stringify(runtime({ staging: { required: ['DATABASE_URL', 'SENDGRID_API_KEY'] }, production: { required: ['DATABASE_URL', 'SENDGRID_API_KEY'] }, preview: { required: ['DATABASE_URL'] } })));
  const directory = await install('runtime-check-install', {
    staging: { list: 'printf "DATABASE_URL=postgres://staging-secret\\nexport SENDGRID_API_KEY=sg-staging-secret\\n"', set: 'true' },
    production: { list: `echo '{"DATABASE_URL":"postgres://production-secret"}'`, set: 'true' },
  });
  const results = await checkRuntime(root, directory);
  assert.deepEqual(results, [
    { environment: 'staging', missing: [], fault: null },
    { environment: 'production', missing: ['SENDGRID_API_KEY'], fault: null },
    { environment: 'preview', missing: [], fault: `${join(directory, 'runtime.json')} has no list command for it` },
  ]);
  assert.doesNotMatch(JSON.stringify(results), /secret/);
  assert.deepEqual((await checkRuntime(root, directory, ['production'])).map(result => result.environment), ['production']);
  await assert.rejects(checkRuntime(root, directory, ['uat']), /No runtime environment uat; graphyard\.json declares staging, production, preview/);
  // A command in the repository's file is refused: the candidate writes it, and it would run with the platform login.
  assert.throws(() => parseRepositoryConfig(JSON.stringify(runtime({ staging: { required: [], variables: 'railway variables --json' } }))));
  await assert.rejects(checkRuntime(root, await install('runtime-check-open', { staging: { list: 'true', set: 'true' } }, 0o644)), /readable by others: chmod 600 it/);
  const failing = await install('runtime-check-failing', { staging: { list: 'echo listed-secret >&2; exit 3', set: 'true' } });
  assert.deepEqual((await checkRuntime(root, failing, ['staging']))[0], { environment: 'staging', missing: [], fault: 'its list command failed (exit 3); run it by hand to see why' });
});

test('unit:runtime-check — names come from lines or JSON keys; a malformed declaration is refused', async () => {
  assert.deepEqual([...listedNames('A\n  B=1\nnot a name\nC = x\n')], ['A', 'B', 'C']);
  assert.deepEqual([...listedNames('{"A":"1","B":"2"}')], ['A', 'B']);
  assert.throws(() => parseRepositoryConfig(JSON.stringify(runtime({ staging: { required: ['bad-name'] } }))), /letters, digits and _/);
  assert.throws(() => parseRepositoryConfig(JSON.stringify(runtime({}))), /at least one environment/);
  const root = await temporaryDirectory('runtime-check-none');
  await writeFile(join(root, 'graphyard.json'), '{}');
  await assert.rejects(checkRuntime(root, await install('runtime-check-none-install', { staging: { list: 'true', set: 'true' } })), /declares no runtime environments/);
});

test('unit:runtime-variable-set — the set command gets the value only as $VALUE, with no credential from the caller\'s environment, and each environment is confirmed by its listing', async () => {
  const store = await temporaryDirectory('runtime-variable-set-store');
  const directory = await install('runtime-variable-set', Object.fromEntries(['staging', 'production'].map(environment => [environment, {
    set: `env > "${store}/${environment}.env"; printf '%s=%s\\n' "$NAME" "$VALUE" >> "${store}/${environment}.vars"`,
    list: `cat "${store}/${environment}.vars" 2>/dev/null || true`,
  }])));
  process.env.GRAPHYARD_TOKEN = 'caller-credential';
  try { assert.deepEqual(await setVariable(directory, 'SENDGRID_API_KEY', 'sg-value', runCommand), { environments: ['staging', 'production'], error: null }); }
  finally { delete process.env.GRAPHYARD_TOKEN; }
  const seen = await readFile(join(store, 'production.env'), 'utf8');
  assert.match(seen, /^VALUE=sg-value$/m);
  assert.doesNotMatch(seen, /caller-credential/);
  const unconfirmed = await install('runtime-variable-unconfirmed', { staging: { set: 'true', list: 'echo OTHER=1' } });
  assert.deepEqual(await setVariable(unconfirmed, 'SENDGRID_API_KEY', 'sg-value'), { environments: [], error: 'staging: its list command does not show SENDGRID_API_KEY after setting it' });
});

const repository = 'owner/runtime-variable';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const lead: Principal = { id: 'lead', role: 'operator-agent', sessionKind: 'ai' };
const worker: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const loop: Principal = { id: 'loop', role: 'coordinator' };
const credentials = [operator, lead, worker, loop].map(principal => ({ ...principal, token: `runtime-variable-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const HOST = 'loop-host';
let db: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
before(async () => {
  db = await withDatabase('runtime-variable'); await db.init();
  engine = new Engine(db, 120, repository);
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (db) await db.close(); });
const call = async (principal: Principal, path: string, body: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const reload = async (id: string) => (await db.list()).find(item => item.id === id)!;

test('integration:runtime-variable-flow — a parked variable is pasted, sealed in the browser to the loop host, set by the loop in every environment and never readable by an agent', async () => {
  const scratch = await temporaryDirectory('runtime-variable-flow');
  const credentialFile = join(scratch, 'loop.token');
  await writeFile(credentialFile, token(loop), { mode: 0o600 });
  const { publicKey } = await hostKeyPair(credentialFile);
  const directory = await install('runtime-variable-flow-install', { staging: { list: 'true', set: 'true' }, production: { list: 'true', set: 'true' } });
  const set: { command: string; env: Record<string, string> }[] = [];
  const run: RunCommand = async (command, env) => { set.push({ command, env }); return set.some(entry => entry.env.NAME) ? 'SENDGRID_API_KEY=x\n' : ''; };
  const config = { url, hostId: HOST, credentialFile, repository } as const;

  const park = async () => {
    let work: Work = await engine.execute(operator, 'create', null, { type: 'chore', title: `Send email ${randomUUID().slice(0, 4)}`, criteria: [{ id: 'AC-1', text: 'Sends', proofs: ['unit:sends', 'e2e:fixture'] }] }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
    const parked = await call(worker, `work/${work.id}/park`, { epoch: work.lease!.epoch, kind: 'money-or-accounts', variable: 'SENDGRID_API_KEY', sealHost: HOST,
      needed: 'A SendGrid API key with Mail Send only, as SENDGRID_API_KEY in staging and production', reason: 'The notice email needs it to send', ask: 'Create a SendGrid API key and paste it here', recommendation: 'A restricted key with Mail Send permission only', why: 'A leaked key then cannot change the account' });
    assert.equal(parked.status, 200, JSON.stringify(parked.body));
    return reload(work.id);
  };
  let work = await park();
  const request = work.humanRequest!;
  assert.deepEqual(request.choices ?? null, null);
  const answer = (principal: Principal, body: object) => call(principal, `work/${work.id}/answer`, { request: request.id, choice: 'provide', ...body });
  assert.equal((await answer(operator, { secret: 'sg-plain' })).status, 422, 'a plaintext value is refused');
  assert.equal((await answer(lead, { ownerSaid: 'the owner gave it in chat', sealedValue: await sealForHost(publicKey, 'sg-relayed') })).status, 403, 'a relay is refused');
  assert.equal((await answer(operator, { sealedValue: await sealForHost(publicKey, 'sg-value') })).status, 200);
  work = await reload(work.id);
  assert.match(work.blocker!, /^Waiting for the loop to set SENDGRID_API_KEY in every environment/);
  assert.doesNotMatch(JSON.stringify(work), /sg-value/);
  assert.equal((await call(worker, `work/${work.id}/variable-applied`, { request: request.id, environments: [] })).status, 403, 'only the loop records it');

  assert.deepEqual(await applyRuntimeVariables(config, { installDirectory: directory, run }), [{ work: work.key, variable: 'SENDGRID_API_KEY', environments: ['staging', 'production'], error: null }]);
  assert.deepEqual(set.filter(entry => entry.env.NAME).map(entry => entry.env), [{ NAME: 'SENDGRID_API_KEY', VALUE: 'sg-value' }, { NAME: 'SENDGRID_API_KEY', VALUE: 'sg-value' }]);
  work = await reload(work.id);
  assert.equal(work.blocker, null);
  const answered = work.humanRequests!.at(-1)!.answer!;
  assert.equal(answered.sealedValue, null);
  assert.deepEqual(answered.applied?.environments, ['staging', 'production']);
  assert.deepEqual(await applyRuntimeVariables(config, { installDirectory: directory, run }), [], 'a set variable is set once');

  // A value the platform refuses opens the request again, naming why.
  work = await park();
  const second = work.humanRequest!;
  assert.equal((await call(operator, `work/${work.id}/answer`, { request: second.id, choice: 'provide', sealedValue: await sealForHost(publicKey, 'sg-other') })).status, 200);
  const refusing = await install('runtime-variable-flow-refusing', { staging: { list: 'true', set: 'exit 2' } });
  assert.deepEqual((await applyRuntimeVariables(config, { installDirectory: refusing })).map(report => report.error), ['staging: its set command failed (exit 2); run it by hand to see why']);
  work = await reload(work.id);
  assert.notEqual(work.humanRequest?.id, second.id);
  assert.match(work.humanRequest!.reason, /The last value was not set: staging: its set command failed/);
  assert.equal(work.humanRequests!.at(-1)!.answer!.sealedValue, null);
});
