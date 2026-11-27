import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterConfigSchema, type MasterConfig } from '../src/master/profiles.js';
import { intentCommand } from '../src/cli/master/intent.js';
import type { MasterSession } from '../src/cli/master/session.js';
import type { Work } from '../src/model.js';
import { describeHumanRequest } from '../src/model/human-request.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-3996 AC-1: releasing an item, or releasing its hold, when the item still has an open recorded
// blocker succeeds as today and prints exactly one extra line: the blocker's text (first 120 chars),
// who recorded it and when, and the command that clears it.

const proof = 'unit:release-names-a-remaining-blocker';
const blockedAt = '2026-11-27T02:48:00.000Z';
const longBlocker = 'Legacy pin in deploy/pins.json still points to the old image tag; drift check stopped the build before verification could finish and needs an operator pin update.';
assert.ok(longBlocker.length > 120, 'fixture blocker exceeds 120 characters');
/** The record `mainworks blocked` leaves on the item in the same write as the blocker (engine/commands/blocked.ts). */
const blockedReport = (profile: string) => ({
  exhaustions: [{ role: 'worker' as const, cause: 'interrupted' as const, epoch: 1, profile, account: null, runtime: null, reason: `blocked attempt 1: ${longBlocker}`.slice(0, 500), resetsAt: null, partialWork: { state: 'not-applicable' as const }, at: blockedAt, owner: profile, recordedBy: profile }],
  spent: [],
});
/** The record a typed blocker request leaves in the same write as the blocker (engine/commands/request.ts). */
const blockerRequest = (requestedBy: string) => ({
  agentRequests: [{ id: 'r-1', type: 'blocker' as const, epoch: 1, requestedBy, at: blockedAt, reason: 'Drift check failed on main',
    decider: { kind: 'follow-up' as const, who: 'a tracked follow-up work item', command: 'mainworks master create — a follow-up item naming GY-220 and the external cause' }, releasedLease: true, state: 'open' as const }],
});

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

/** The release succeeded and printed its one result; the extra lines are returned for the case to read. */
async function releasedLines(work: Work) {
  const { printed, extraLines } = await runRelease(work);
  assert.equal(printed.length, 1, 'release still prints the released work JSON');
  assert.equal((printed[0] as Work).ready, true);
  assert.equal((printed[0] as Work).hold, undefined);
  assert.equal(extraLines.length, 1, `expected exactly one extra line, got ${JSON.stringify(extraLines)}`);
  const line = extraLines[0]!;
  assert.equal(line.includes('\n'), false, 'extra output must be a single line');
  return line;
}

test(`${proof} — releasing a held item that still has a blocker succeeds and prints exactly one extra line naming the blocker, author, time and unblock command`, async () => {
  const item = workFixture({
    id: 'w-218', key: 'GY-218', stage: 'ready', ready: true, hold: true, holdReason: 'Paused during migration', heldBy: 'lead-operator',
    blocker: longBlocker, blockedAt, capacity: blockedReport('builder-claude-2'),
  });
  const line = await releasedLines(item);
  assert.equal(line, `Note: GY-218 still has an open blocker (recorded by builder-claude-2 at ${blockedAt}): ${longBlocker.slice(0, 120)} — clear it with: mainworks master unblock GY-218 REASON`);
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

test(`${proof} — releasing a backlog item that carries only a blocker prints exactly one extra line, naming who asked it`, async () => {
  const item = workFixture({ id: 'w-220', key: 'GY-220', stage: 'backlog', ready: false, hold: undefined, blocker: 'Drift check failed on main', blockedAt, ...blockerRequest('builder-codex-1') });
  const line = await releasedLines(item);
  assert.equal(line, `Note: GY-220 still has an open blocker (recorded by builder-codex-1 at ${blockedAt}): Drift check failed on main — clear it with: mainworks master unblock GY-220 REASON`);
});

test(`${proof} — a blocker the loop wrote itself names no author: the ended attempt's owner did not record it`, async () => {
  const item = workFixture({
    id: 'w-222', key: 'GY-222', stage: 'ready', ready: true, blocker: 'Workers keep failing to start: the agent process exited (code 1) while its lease was live', blockedAt,
    pipeline: { attempts: [{ epoch: 1, owner: 'builder-claude-2', claimedAt: blockedAt, endedAt: blockedAt, end: 'expired' }], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
  });
  const line = await releasedLines(item);
  assert.equal(line, `Note: GY-222 still has an open blocker (recorded at ${blockedAt}): Workers keep failing to start: the agent process exited (code 1) while its lease was live — clear it with: mainworks master unblock GY-222 REASON`);
});

test(`${proof} — an item waiting on a human decision names the owner's answer as what clears it, not the Lead's unblock`, async () => {
  const request = { id: 'hr-1', kind: 'goals-and-priorities' as const, reason: 'The two fixes conflict', needed: 'Choose which fix ships first', requestedBy: 'builder-claude-2', epoch: 1, at: blockedAt, recommendation: 'Ship the export fix first' };
  const item = workFixture({ id: 'w-221', key: 'GY-221', stage: 'ready', ready: true, hold: true, holdReason: 'Paused during migration', heldBy: 'lead-operator', humanRequest: request, blocker: describeHumanRequest(request), blockedAt });
  const line = await releasedLines(item);
  assert.equal(line, `Note: GY-221 still has an open blocker (recorded by builder-claude-2 at ${blockedAt}): ${describeHumanRequest(request)} — the owner answers it with: mainworks answer GY-221 hr-1 ANSWER`);
});
