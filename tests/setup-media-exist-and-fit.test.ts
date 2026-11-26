import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDemoState } from '../scripts/docs-media-demo.mjs';
import { setupChecklist } from '../src/model/setup-checklist';

// GY-3940: the getting-started guide's two captures come from `npm run docs:media` on the README's
// demo data: 1600 px wide, light theme, and showing what docs/setup.md says they show.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url));

test('unit:setup-media-exist-and-fit — setup-connect.png and setup-first-goal.png exist at 1600 px, are linked from docs/setup.md, and npm run docs:media draws them from the demo data', () => {
  const setup = read('docs/setup.md').toString();
  const script = read('scripts/docs-media.mjs').toString();
  for (const name of ['setup-connect.png', 'setup-first-goal.png']) {
    const bytes = read(`docs/media/${name}`);
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG', `${name} is a PNG`);
    assert.equal(bytes.readUInt32BE(16), 1600, `${name} is 1600 px wide`);
    assert.ok(bytes.readUInt32BE(20) >= 400 && bytes.length < 4 * 1024 * 1024, `${name} is a full screen under 4 MB`);
    assert.ok(setup.includes(`](media/${name})`), `docs/setup.md shows ${name}`);
    assert.ok(script.includes(`join(outDir, '${name}')`), `npm run docs:media writes ${name}`);
  }
  assert.match(script, /colorScheme: 'light'/, 'captured in the light theme');
  assert.match(script, /fill\('Add a \/health page that returns ok\.'\)/, 'the first goal is the one the guide names');

  // The Setup capture: the writing account connected, the reviewing one not yet, on the demo project.
  const { status } = buildDemoState('setup');
  const accounts = setupChecklist(status).filter(item => item.id.startsWith('account:')).map(item => [item.id, item.done]);
  assert.deepEqual(accounts, [['account:worker', true], ['account:reviewer', false]]);
  assert.equal(status.repository, 'acme/storefront', 'no real project');
});
