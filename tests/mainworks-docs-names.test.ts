import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// GY-3712: the docs follow the code — README and the CLI guide name the Mainworks settings and
// paths, with one line saying the legacy names are still honoured.
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
// README embeds the "Where things run" diagram, so its paths count as README text.
const diagram = readFileSync(new URL('../docs/diagrams/where-things-run.svg', import.meta.url), 'utf8');
const cli = new URL('../src/cli.ts', import.meta.url);
const guide = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', cli.pathname, 'guide', ...args], { encoding: 'utf8' });
const topics = ['claim', 'sync', 'complete', 'park', 'blocked', 'review', 'proof', 'upgrade', 'master', 'setup', 'infra', 'publishing', 'runtimes'];
const honoured = /The `graphyard` command[^\n]*`GRAPHYARD_\*` settings[^\n]*still work/;
// Names the running apps receive, and the trial image's build argument, are not settings.
const notSettings = /GRAPHYARD_(COMMIT|INSTANCE|RUN_ID|TRIAL_IMAGE)\b/g;

function checkOne(name: string, text: string) {
  const lines = text.split('\n').filter((line) => line.includes('GRAPHYARD_') && line.replace(notSettings, '').includes('GRAPHYARD_'));
  assert.ok(lines.length <= 1, `${name} names GRAPHYARD_* on one line only, got:\n${lines.join('\n')}`);
  for (const line of lines) assert.match(line, honoured, `${name}'s one GRAPHYARD_ line says the legacy names still work`);
  for (const old of [/~\/\.config\/graphyard\//, /(^|[^\w/])\.graphyard\b/]) assert.doesNotMatch(text, old, `${name} names the Mainworks path, not ${old}`);
}

test('e2e:mainworks-docs-names — guide master names MAINWORKS_URL and no GRAPHYARD_URL outside the one honoured line, and README names only the legacy command notice', () => {
  const master = guide('master');
  assert.ok(master.includes('MAINWORKS_URL'), 'guide master names MAINWORKS_URL');
  assert.equal(master.split('\n').filter((line) => line.includes('GRAPHYARD_URL') && !honoured.test(line)).length, 0, 'guide master names GRAPHYARD_URL only in the honoured line');
  assert.equal(master.split('\n').filter((line) => honoured.test(line)).length, 1, 'guide master has exactly one honoured line');
  checkOne('guide master', master);
  checkOne('README.md', readme);
  assert.match(readme, /the `graphyard` command and settings still work/);
});

test('e2e:mainworks-docs-names — every guide topic and the index name only MAINWORKS_* settings and Mainworks paths', () => {
  checkOne('docs/diagrams/where-things-run.svg (embedded in README.md)', diagram);
  checkOne('guide', guide());
  for (const topic of topics) checkOne(`guide ${topic}`, guide(topic));
  checkOne('master guide', execFileSync(process.execPath, ['--import', 'tsx', cli.pathname, 'master', 'guide'], { encoding: 'utf8' }));
});
