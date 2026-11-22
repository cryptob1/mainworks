import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeBounds, composeBuildLabels, composeDownArgs, composeImageKeepHours, composeImageLabel, composeOwnerLabel, composePreviewConfig, composeProjectName, removeComposeProject, sweepComposePreviews, type Docker } from '../src/compose-preview.js';

// GY-3640: a Compose preview's build carries no label that changes between runs, so a second
// preview of the same commit finds every layer cached; its teardown keeps the images, and the
// periodic sweep removes those older than a day.

const proof = 'unit:compose-preview-keeps-its-layers';
const file = { services: { web: { build: { context: '.', labels: { team: 'site' } }, labels: { tier: 'web' } }, db: { image: 'postgres:16' } } };
const configured = (run: string, pid: number) => composePreviewConfig(file, { project: composeProjectName('GY-1', run), service: 'web', port: 8080, bounds: composeBounds(),
  variables: { GRAPHYARD_PREVIEW_SHA: 'a'.repeat(40) }, owner: { pid, start: String(pid), at: new Date(pid).toISOString() } as never });

test(`${proof} — two runs of one preview build with the same labels: the file's own and one constant`, () => {
  const first = configured('11111111-run', 100), second = configured('22222222-run', 200);
  assert.deepEqual(first.services.web.build.labels, { team: 'site', [composeImageLabel]: 'kept' });
  assert.deepEqual(second.services.web.build.labels, first.services.web.build.labels, 'no build label changes between runs');
  assert.deepEqual(composeBuildLabels(), { [composeImageLabel]: 'kept' });
  assert.ok(!(composeOwnerLabel in first.services.web.build.labels), 'the owner stays off the image');
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
