import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { guideList, guideText, guideTopicList, guideTopics } from '../src/guide.js';

// GY-3708: each guide topic's text lives in its own file under src/guide/<topic>.ts,
// and src/guide.ts only maps topic names to those files so edits to different topics never conflict.
const root = fileURLToPath(new URL('..', import.meta.url));
const guideDir = join(root, 'src', 'guide');
const guideIndex = join(root, 'src', 'guide.ts');

const runGuide = (...args: string[]): Buffer =>
  execFileSync(process.execPath, ['bin/graphyard.mjs', 'guide', ...args], { cwd: root });

test('unit:guide-one-file-per-topic — each topic lives in its own file under src/guide/, src/guide.ts only maps topic names to them, and guide TOPIC prints each topic byte for byte', async () => {
  assert.ok(existsSync(guideDir), 'src/guide/ directory must exist');

  const files = readdirSync(guideDir).filter(name => name.endsWith('.ts')).sort();
  const expectedFiles = [...guideTopicList].map(topic => `${topic}.ts`).sort();
  assert.deepEqual(files, expectedFiles, 'src/guide/ must contain one <topic>.ts file per guide topic and no others');

  const indexSource = readFileSync(guideIndex, 'utf8');
  for (const topic of guideTopicList) {
    assert.match(
      indexSource,
      new RegExp(`from\\s+['"]\\.\\/guide\\/${topic}\\.js['"]`),
      `src/guide.ts must import topic ${topic} from ./guide/${topic}.js`,
    );
    assert.doesNotMatch(
      indexSource,
      new RegExp(`\\b${topic}\\s*:\\s*[\`'"']`),
      `src/guide.ts must not define topic ${topic} text inline`,
    );
  }

  for (const topic of guideTopicList) {
    const mod = await import(pathToFileURL(join(guideDir, `${topic}.ts`)).href) as { default?: unknown };
    assert.equal(typeof mod.default, 'string', `src/guide/${topic}.ts must default-export its topic text string`);
    const fileBytes = Buffer.from(mod.default as string, 'utf8');
    assert.ok(fileBytes.length > 0, `src/guide/${topic}.ts must be non-empty`);
    assert.ok(fileBytes.equals(Buffer.from(guideTopics[topic], 'utf8')), `guideTopics.${topic} must match src/guide/${topic}.ts byte for byte`);
    assert.ok(fileBytes.equals(Buffer.from(guideText(topic), 'utf8')), `guideText(${topic}) must match src/guide/${topic}.ts byte for byte`);

    const cliBytes = runGuide(topic);
    const expectedCliBytes = Buffer.from(`${mod.default as string}\n`, 'utf8');
    assert.ok(cliBytes.equals(expectedCliBytes), `guide ${topic} CLI output must match src/guide/${topic}.ts byte for byte`);
  }

  const listBytes = runGuide();
  assert.ok(listBytes.equals(Buffer.from(`${guideList()}\n`, 'utf8')), 'guide with no topic must print guideList() byte for byte');
  assert.throws(() => guideText('no-such-topic'), /Unknown guide topic/);
});
