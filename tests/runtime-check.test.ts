import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { checkRuntime, listedNames } from '../src/runtime-check.js';
import { parseRepositoryConfig } from '../src/model-boundary/documentation.js';

const runtime = (environments: object) => ({ runtime: { platform: 'railway', secrets: 'Railway variables, copied from AWS SSM', environments } });

test('unit:runtime-check — each environment names the required variables its listing lacks, and never a value', async () => {
  const root = await temporaryDirectory('runtime-check');
  await writeFile(join(root, 'graphyard.json'), JSON.stringify(runtime({
    staging: { variables: 'printf "DATABASE_URL=postgres://staging-secret\\nexport SENDGRID_API_KEY=sg-staging-secret\\n"', required: ['DATABASE_URL', 'SENDGRID_API_KEY'] },
    production: { variables: `echo '{"DATABASE_URL":"postgres://production-secret"}'`, required: ['DATABASE_URL', 'SENDGRID_API_KEY'] },
    preview: { variables: 'echo listed-secret >&2; exit 3', required: ['DATABASE_URL'] },
  })));
  const results = await checkRuntime(root);
  assert.deepEqual(results, [
    { environment: 'staging', missing: [], fault: null },
    { environment: 'production', missing: ['SENDGRID_API_KEY'], fault: null },
    { environment: 'preview', missing: [], fault: 'its variables command failed (exit 3); run it by hand to see why' },
  ]);
  assert.doesNotMatch(JSON.stringify(results), /secret/);
  assert.deepEqual((await checkRuntime(root, ['production'])).map(result => result.environment), ['production']);
  await assert.rejects(checkRuntime(root, ['uat']), /No runtime environment uat; graphyard\.json declares staging, production, preview/);
});

test('unit:runtime-check — names come from lines or JSON keys; a malformed declaration is refused', async () => {
  assert.deepEqual([...listedNames('A\n  B=1\nnot a name\nC = x\n')], ['A', 'B', 'C']);
  assert.deepEqual([...listedNames('{"A":"1","B":"2"}')], ['A', 'B']);
  assert.throws(() => parseRepositoryConfig(JSON.stringify(runtime({ staging: { variables: 'true', required: ['bad-name'] } }))), /letters, digits and _/);
  assert.throws(() => parseRepositoryConfig(JSON.stringify(runtime({}))), /at least one environment/);
  const root = await temporaryDirectory('runtime-check-none');
  await writeFile(join(root, 'graphyard.json'), '{}');
  await assert.rejects(checkRuntime(root), /declares no runtime environments/);
});
