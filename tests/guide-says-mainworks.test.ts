import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const renderGuide = (topic: string) =>
  execFileSync(process.execPath, ['--import', 'tsx', cli, 'guide', topic], { cwd: root, encoding: 'utf8' });

function withoutCompatLine(text: string): string {
  const compatLines = text.split('\n').filter(line => /graphyard.*still work|GRAPHYARD_\*.*still work/i.test(line));
  assert.ok(compatLines.length <= 1, `at most one compatibility line, found ${compatLines.length}`);
  return text.split('\n').filter(line => !/graphyard.*still work|GRAPHYARD_\*.*still work/i.test(line)).join('\n');
}

test('unit:guide-says-mainworks — setup, master, runtimes and infra say Mainworks, use mainworks, describe the caretaker in master in at most 3 lines, and state tests run on compute machines first', () => {
  for (const topic of ['setup', 'master', 'runtimes', 'infra'] as const) {
    const text = renderGuide(topic);
    assert.ok(text.includes('Mainworks'), `guide ${topic} says Mainworks`);
    assert.match(text, /\bmainworks\b/, `guide ${topic} uses the mainworks command`);
  }

  for (const topic of ['setup', 'master'] as const) {
    const text = renderGuide(topic);
    const cleaned = withoutCompatLine(text);
    assert.doesNotMatch(cleaned, /\bGraphyard\b/, `guide ${topic} contains no 'Graphyard' outside the one compatibility line`);
  }

  const setup = renderGuide('setup');
  const master = renderGuide('master');
  const infra = renderGuide('infra');

  for (const [name, text] of [['setup', setup], ['master', master], ['infra', infra]] as const) {
    assert.match(text, /compute machines? first/i, `guide ${name} states test runs go to compute machines first`);
  }

  const caretakerParagraphs = master.split(/\n\n+/).filter(paragraph => /\bcaretaker\b/i.test(paragraph));
  assert.equal(caretakerParagraphs.length, 1, 'guide master has one caretaker description');
  const caretakerLines = caretakerParagraphs[0]!.trim().split('\n');
  assert.ok(caretakerLines.length <= 3, `caretaker description in guide master is at most 3 lines (got ${caretakerLines.length})`);
});
