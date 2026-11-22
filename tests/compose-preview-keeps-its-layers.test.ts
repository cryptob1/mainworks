import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { composeBounds, composeBuildLabels, composeDownArgs, composeImageKeepHours, composeImageLabel, composeOwnerLabel, composePreviewConfig, composeProjectName, removeComposeProject, sweepComposePreviews, type Docker } from '../src/compose-preview.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { openPreview } from '../src/merge-writer/preview.js';
import { keptBaseBuild, keptBaseBuildMarker } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3679: a preview reuses what was already built. A static preview serves the trial's kept built
// tree of its commit, with no second checkout or build. A Compose preview's build carries no label
// that changes between runs, so a second preview of the same commit finds every layer cached; its
// teardown keeps the images, and the periodic sweep removes those older than a day.

const proof = 'unit:compose-preview-keeps-its-layers';
const file = { services: { web: { build: { context: '.', labels: { team: 'site' } }, labels: { tier: 'web' } }, db: { image: 'postgres:16' } } };
const configured = (run: string, pid: number) => composePreviewConfig(file, { project: composeProjectName('GY-1', run), service: 'web', port: 8080, bounds: composeBounds(),
  variables: { GRAPHYARD_PREVIEW_SHA: 'a'.repeat(40) }, owner: { pid, startedAt: String(pid), at: new Date(pid).toISOString() } as never });

test(`${proof} — two runs of one preview build with the same labels: the file's own and one constant`, () => {
  const first = configured('11111111-run', 100), second = configured('22222222-run', 200);
  assert.deepEqual(first.services.web.build.labels, { team: 'site', [composeImageLabel]: 'kept' });
  assert.deepEqual(second.services.web.build.labels, first.services.web.build.labels, 'no build label changes between runs');
  assert.deepEqual(composeBuildLabels(), { [composeImageLabel]: 'kept' });
  // The containers still name their owner, so an abandoned project is still found and removed.
  assert.notEqual(first.services.web.labels[composeOwnerLabel], second.services.web.labels[composeOwnerLabel]);
  assert.equal(first.services.db.build, undefined);
});

test(`${proof} — teardown keeps the images and the sweep removes those older than 24 hours`, async () => {
  const project = composeProjectName('GY-1', '11111111-run'), calls: string[][] = [];
  const docker: Docker = async args => { calls.push(args); return ''; };
  assert.deepEqual(composeDownArgs(project), ['compose', '-p', project, 'down', '--volumes', '--remove-orphans', '--timeout', '5']);
  await removeComposeProject(project, { docker, env: {} });
  assert.deepEqual(calls[0], composeDownArgs(project));
  assert.ok(!calls.flat().includes('--rmi') && !calls.some(args => args[0] === 'image'), `teardown removes no image: ${JSON.stringify(calls)}`);

  calls.length = 0;
  assert.equal(composeImageKeepHours, 24);
  assert.deepEqual(await sweepComposePreviews({ docker, env: {} }), []);
  assert.deepEqual(calls.filter(args => args[0] === 'image'), [['image', 'prune', '--all', '--force', '--filter', `label=${composeImageLabel}`, '--filter', 'until=24h']]);
});

const made: string[] = [];
after(async () => { for (const directory of made) await rm(directory, { recursive: true, force: true }); });

test(`${proof} — a static preview of a commit the trial built serves that built tree: no checkout, no build`, { timeout: 60_000 }, async () => {
  const root = await realpath(await temporaryDirectory('preview-kept-tree')); made.push(root);
  const repo = join(root, 'repo'), base = join(root, 'worktrees');
  await mkdir(base);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 'T');
  await mkdir(join(repo, 'site')); await mkdir(join(repo, 'e2e', 'cases'), { recursive: true });
  await writeFile(join(repo, 'site', 'index.html'), '<h1>Play</h1>');
  await writeFile(join(repo, 'e2e', 'cases', 'home.json'), JSON.stringify({ id: 'home', title: 'The home page answers', tags: ['api'], target: 'any', required: true,
    steps: [{ kind: 'http', name: 'read /', method: 'GET', path: '/', status: 200, expect: [] }] }));
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'site');
  const sha = git(repo, 'rev-parse', 'HEAD');
  // The trial's base pass left this commit's built tree: checked out, its output built, marked built.
  const tree = keptBaseBuild(base, sha);
  git(repo, 'worktree', 'add', '-q', '--detach', tree, sha);
  execFileSync('sh', ['-c', 'mkdir -p dist && cp -R site/. dist/'], { cwd: tree });
  await writeFile(keptBaseBuildMarker(tree), '');

  const calls: string[] = [], builds: string[] = [];
  const run: ChildRun = (command, args, options) => { calls.push([command, ...args].join(' ')); return defaultChildRun(command, args, options); };
  const opened = await openPreview({ root: repo, base, mergeSha: sha, timeoutMs: 30_000, run, application: { id: 'site', kind: 'static', directory: 'dist', build: 'mkdir -p dist && cp -R site/. dist/' },
    shell: async command => { builds.push(command); return { ok: true, output: '' }; } }, { keep: true, cases: ['home'] });
  try {
    assert.equal(opened.verdict.result, 'pass', opened.verdict.detail);
    assert.equal(opened.site, join(tree, 'dist'), 'the preview serves the trial\'s built output');
    assert.ok(!calls.some(call => call.includes('worktree add')), `no second checkout: ${JSON.stringify(calls)}`);
    assert.deepEqual(builds, [], 'no second build');
    assert.equal((await fetch(`${opened.url}/`).then(response => response.text())), '<h1>Play</h1>');
  } finally { await opened.close(); }
  assert.ok(existsSync(join(tree, 'dist', 'index.html')), 'closing the preview leaves the trial\'s tree in place');
});
