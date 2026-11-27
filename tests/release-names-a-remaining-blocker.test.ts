import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterConfigSchema, type MasterConfig } from '../src/master/profiles.js';
import { intentCommand } from '../src/cli/master/intent.js';
import type { MasterSession } from '../src/cli/master/session.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-3996 AC-1: releasing an item, or releasing its hold, when the item still has an open recorded
// blocker succeeds as today and prints exactly one extra line: the blocker's text (first 120 chars),
// who recorded it and when, and the command that clears it.

const proof = 'unit:release-names-a-remaining-blocker';
const blockedAt = '2026-11-27T02:48:00.000Z';
const longBlocker = 'Legacy pin in deploy/pins.json still points to the old image tag; drift check stopped the build before verification could finish and needs an operator pin update.';
assert.ok(longBlocker.length > 120, 'fixture blocker exceeds 120 characters');

async function runRelease(work: Work) {
  const root = await temporaryDirectory('release-blocker-root');
  const creds = await temporaryDirectory('release-blocker-creds');
  try {
    execFileSync('git', ['init', '-q', root]);
    await writeFile(join(root, '.gitignore'), '.graphyard/\n');
    const coordToken = join(creds, 'coordinator.token');
    const opToken = join(creds, 'operator.token');
    await writeFile(coordToken, 'c'.repeat(40), { mode: 0o600 });
    await writeFile(opToken, 'o'.repeat(40), { mode: 0o600 });
    const master: MasterConfig = masterConfigSchema.parse({
      version: 1, url: 'https://mainworks.example', repository: 'owner/repo',
      credentialFile: coordToken, cliPath: '/bin/mainworks', hostId: 'test-host',
      baseBranch: 'main', githubAppId: 1234, masterAgentName: 'master',
      operatorAgent: { id: 'lead-operator', credentialFile: opToken },
    });
    const released: Work = { ...work, ready: true, hold: undefined, holdReason: undefined, heldBy: undefined, revision: work.revision + 1 };
    const printed: unknown[] = [];
    const extraLines: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      assert.ok(url.endsWith(`/api/work/${work.id}/ready`), `expected ready endpoint, got ${url}`);
      return new Response(JSON.stringify(released), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { extraLines.push(args.map(String).join(' ')); };
    try {
      const session = {
        id: 'release',
        args: [work.key, 'Releasing for the next cycle'],
        print: (value: unknown) => { printed.push(value); },
        root,
        master,
        masterToken: 'c'.repeat(40),
        masterApi: async (path: string) => {
          assert.equal(path, 'work-snapshot');
          return { work: [work], now: '2026-11-27T06:15:00.000Z' };
        },
        masterMutation: async () => { throw new Error('unexpected masterMutation'); },
      } as unknown as MasterSession;
      await intentCommand(session);
    } finally {
      console.log = originalLog;
      globalThis.fetch = originalFetch;
    }
    return { printed, extraLines, released };
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(creds, { recursive: true, force: true });
  }
}

test(`${proof} — releasing a held item that still has a blocker succeeds and prints exactly one extra line naming the blocker, author, time and unblock command`, async () => {
  const item = workFixture({
    id: 'w-218', key: 'GY-218', stage: 'ready', ready: true, hold: true, holdReason: 'Paused during migration', heldBy: 'lead-operator',
    blocker: longBlocker, blockedAt, blockedBy: 'builder-claude-2',
  });
  const { printed, extraLines } = await runRelease(item);
  assert.equal(printed.length, 1, 'release still prints the released work JSON');
  assert.equal((printed[0] as Work).ready, true);
  assert.equal((printed[0] as Work).hold, undefined);
  assert.equal(extraLines.length, 1, `expected exactly one extra line, got ${JSON.stringify(extraLines)}`);
  const line = extraLines[0]!;
  assert.equal(line.includes('\n'), false, 'extra output must be a single line');
  assert.ok(line.includes(longBlocker.slice(0, 120)), `line names the first 120 characters of the blocker: ${line}`);
  assert.equal(line.includes(longBlocker), false, 'blocker text is capped at 120 characters');
  assert.ok(line.includes('builder-claude-2'), `line names who recorded the blocker: ${line}`);
  assert.ok(line.includes(blockedAt), `line names when the blocker was recorded: ${line}`);
  assert.ok(line.includes('mainworks master unblock GY-218'), `line names the command that clears the blocker: ${line}`);
});

test(`${proof} — releasing a held item with no blocker prints no extra line`, async () => {
  const item = workFixture({
    id: 'w-219', key: 'GY-219', stage: 'ready', ready: true, hold: true, holdReason: 'Paused during migration', heldBy: 'lead-operator',
    blocker: null, blockedAt: null,
  });
  const { printed, extraLines } = await runRelease(item);
  assert.equal(printed.length, 1, 'release succeeds and prints the released work JSON');
  assert.deepEqual(extraLines, [], 'no extra line when the item has no blocker');
});

test(`${proof} — releasing a backlog item that carries only a blocker prints exactly one extra line`, async () => {
  const item = workFixture({
    id: 'w-220', key: 'GY-220', stage: 'backlog', ready: false, hold: undefined,
    blocker: 'Drift check failed on main', blockedAt,
    pipeline: {
      attempts: [{ epoch: 1, owner: 'builder-codex-1', claimedAt: '2026-11-27T02:30:00.000Z', endedAt: blockedAt, end: 'released' }],
      submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 1, requirements: 0 },
    },
  });
  const { printed, extraLines } = await runRelease(item);
  assert.equal(printed.length, 1, 'release succeeds and prints the released work JSON');
  assert.equal(extraLines.length, 1, `expected exactly one extra line, got ${JSON.stringify(extraLines)}`);
  const line = extraLines[0]!;
  assert.equal(line.includes('\n'), false, 'extra output must be a single line');
  assert.ok(line.includes('Drift check failed on main'), `line names the blocker text: ${line}`);
  assert.ok(line.includes('builder-codex-1'), `line falls back to attempt owner when blockedBy is absent: ${line}`);
  assert.ok(line.includes(blockedAt), `line names when the blocker was recorded: ${line}`);
  assert.ok(line.includes('mainworks master unblock GY-220'), `line names the command that clears the blocker: ${line}`);
});
