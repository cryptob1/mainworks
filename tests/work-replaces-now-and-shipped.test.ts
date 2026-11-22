import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { route, views } from '../web/pages/index.js';

// GY-3600 AC-3: Work replaces the old Work, Now and Shipped pages; their routes open Work with the matching filter.
const removed = ['web/pages/overview.tsx', 'web/pages/now.tsx', 'web/pages/shipped.tsx', 'web/components/work-card.tsx', 'web/components/item-lead.tsx', 'web/components/taste.tsx', 'web/components/work-replay.tsx', 'web/glide.ts', 'web/trust.ts'];

test('unit:work-replaces-now-and-shipped — the old routes redirect to Work with the matching filter', () => {
  assert.deepEqual(route('#now', ''), { view: 'work', filter: 'in-flight' });
  assert.deepEqual(route('#shipped', ''), { view: 'work', filter: 'shipped-today' });
  assert.deepEqual(route('#work', ''), { view: 'work', filter: null });
  assert.deepEqual(route('#work', '?filter=stuck'), { view: 'work', filter: 'stuck' });
  assert.deepEqual(route('#work', '?filter=up-next'), { view: 'work', filter: 'up-next' });
  assert.deepEqual(route('#costs', ''), { view: 'costs', filter: null });
  assert.deepEqual(views.filter(view => ['now', 'shipped'].includes(view.id)), []);
});

test('unit:work-replaces-now-and-shipped — no component of the removed pages is still imported', async () => {
  for (const path of removed) await assert.rejects(access(path), `${path} is removed`);
  const walk = async (dir: string) => (await readdir(dir, { recursive: true })).filter(name => /\.tsx?$/.test(name)).map(name => join(dir, name));
  const names = removed.map(path => path.replace(/^web\//, '').replace(/\.tsx?$/, ''));
  for (const dir of ['web', 'src', 'tests', 'browser-tests']) for (const file of await walk(dir)) {
    const source = await readFile(file, 'utf8');
    for (const name of names) assert.doesNotMatch(source, new RegExp(`from ['"][./]*(?:web/)?(?:\\.\\./)*${name.replace('/', '\\/')}(?:\\.js)?['"]`), `${file} imports ${name}`);
  }
});
