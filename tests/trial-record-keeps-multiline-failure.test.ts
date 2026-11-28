import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertionsByFile } from '../src/merge-writer/executor.js';
import { repositoryCheckFailure } from '../src/merge-writer/trial.js';
import { mergeRecordBodySchema } from '../src/server/merge-record.js';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { mergeLedgerKinds, mergeTrialKind } from '../src/model/merge-ledger.js';
import { flowItems } from '../src/server/flow.js';
import { flowNumbers } from '../src/flow-numbers.js';

// GY-4089: trial records keep the whole failing assertion message (including Playwright's
// Locator, Expected, Received and spec line after the first newline) up to a cap >= 2 KB,
// in the record flaky-check items and master status read.

const playwrightMessageLines = [
  'a run of master-page-ux failed; 20 of 20 must pass:',
  'Error: expect(locator).toHaveAttribute(expected) failed',
  '',
  "Locator: locator('.live-terminal')",
  'Expected: "control"',
  'Received: "reconnecting"',
  '  at browser-tests/master-page-ux.spec.ts:212:55',
];

const tapFor = (file: string, lines: readonly string[]) => [
  'TAP version 13',
  `# Subtest: ${file}`,
  '    not ok 1 - unit:master-page-ux-stable — master-page-ux passes 20 of 20 runs on 4 workers',
  '      ---',
  `      location: '/checkout/${file}:184:1'`,
  '      failureType: \'testCodeFailure\'',
  '      error: |-',
  ...lines.map(line => (line ? `        ${line}` : '')),
  "      code: 'ERR_ASSERTION'",
  '      ...',
  '    1..1',
  `not ok 1 - ${file}`,
  '  ---',
  "  error: '1 subtest failed'",
  '  ...',
  '1..1',
].join('\n');

test('integration:trial-record-keeps-multiline-failure — failed trial step keeps multiline Error, Locator, Expected, Received and spec line up to >= 2 KB in trial records and master status flow', () => {
  const file = 'tests/master-page-ux-stable.test.ts';
  const tap = tapFor(file, playwrightMessageLines);
  const extracted = assertionsByFile(tap, [file])[file];
  assert.ok(extracted, 'extracts the failing assertion for the test file');
  assert.match(extracted, /Error: expect\(locator\)\.toHaveAttribute\(expected\) failed/);
  assert.match(extracted, /Locator: locator\('\.live-terminal'\)/);
  assert.match(extracted, /Expected: "control"/);
  assert.match(extracted, /Received: "reconnecting"/);
  assert.match(extracted, /browser-tests\/master-page-ux\.spec\.ts:212:55/);
  assert.ok(extracted.includes('\n'), 'preserves newlines in the assertion message');

  // Verify messages >= 2 KB (2048+ chars) are kept whole, and oversized messages are bounded cleanly.
  const paddingLine = 'detail: ' + 'x'.repeat(120);
  const longLines = [...playwrightMessageLines, ...Array.from({ length: 18 }, () => paddingLine)];
  const longMessage = longLines.join('\n');
  assert.ok(longMessage.length > 2048, `fixture message exceeds 2 KB (${longMessage.length})`);
  const longExtracted = assertionsByFile(tapFor(file, longLines), [file])[file]!;
  assert.ok(longExtracted.length >= 2048, `keeps at least 2 KB of the failing assertion message (got ${longExtracted.length})`);
  assert.match(longExtracted, /Expected: "control"/);
  assert.match(longExtracted, /Received: "reconnecting"/);

  const hugeLines = [...playwrightMessageLines, ...Array.from({ length: 80 }, () => paddingLine)];
  const hugeExtracted = assertionsByFile(tapFor(file, hugeLines), [file])[file]!;
  assert.ok(hugeExtracted.length >= 2048 && hugeExtracted.length <= 4096, `caps oversized message to a modest bound (got ${hugeExtracted.length})`);

  // Verify the control-plane merge-record schema and merge-ledger fold accept and retain the >= 2 KB multiline message
  // on both flaked.assertions and tests.assertions, and flowNumbers (what master status reads) surfaces it intact.
  const head = 'a'.repeat(40), baseTip = 'b'.repeat(40), mergeSha = 'c'.repeat(40);
  const now = Date.parse('2026-11-28T06:00:00.000Z');
  const at = new Date(now - 60_000).toISOString();

  const flakedRecord = {
    kind: 'trial' as const, head, baseTip, mergeSha, outcome: 'verdict' as const, build: 'pass' as const,
    tests: { passed: 1, failed: [], files: 1 },
    files: [file], proofs: {}, durationMs: 5_000, attempts: [],
    flaked: { files: [file], tests: ['unit:master-page-ux-stable'], assertions: { [file]: longExtracted }, at },
  };
  const parsedFlaked = mergeRecordBodySchema.safeParse(flakedRecord);
  assert.ok(parsedFlaked.success, `mergeRecordBodySchema accepts >= 2 KB multiline flaked assertion: ${parsedFlaked.success ? '' : parsedFlaked.error.message}`);

  const failedRecord = {
    kind: 'trial' as const, head, baseTip, mergeSha, outcome: 'verdict' as const, build: 'pass' as const,
    tests: { passed: 0, failed: [file], files: 1, assertions: { [file]: longExtracted } },
    files: [file], proofs: {}, durationMs: 5_000, attempts: [],
  };
  const parsedFailed = mergeRecordBodySchema.safeParse(failedRecord);
  assert.ok(parsedFailed.success, `mergeRecordBodySchema accepts >= 2 KB multiline failed assertion: ${parsedFailed.success ? '' : parsedFailed.error.message}`);

  const folded = foldMergeLedger([
    { work: 'GY-4089', kind: mergeLedgerKinds.intent, payload: { key: 'GY-4089', head, baseTip, mergeSha, risk: 'sensitive', at } },
    { work: 'GY-4089', kind: mergeTrialKind, payload: flakedRecord },
  ]);
  const storedFlake = folded['GY-4089']?.flakes?.[0]?.assertions?.[file];
  assert.equal(storedFlake, longExtracted, 'folded merge ledger keeps the full multiline assertion on flakes');

  const items = flowItems(
    [{ id: 'w1', key: 'GY-4089', title: 'Keep multiline failure', stage: 'test', stageEnteredAt: at } as any],
    [
      { work_id: 'w1', seq: 1, kind: mergeTrialKind, created_at: at, stage: null, head, duration_ms: 5_000, flaked: true,
        trial: { flaked: flakedRecord.flaked, failed: [], assertions: null } },
      { work_id: 'w1', seq: 2, kind: mergeTrialKind, created_at: at, stage: null, head, duration_ms: 5_000, flaked: false,
        trial: { flaked: null, failed: [file], assertions: failedRecord.tests.assertions } },
    ],
    new Map(), new Map(), now,
  );
  const flow = flowNumbers(items, 6, now);
  assert.equal(flow.flakyChecks[0]?.assertion, longExtracted, 'master status flakyChecks keeps the full multiline assertion');
  assert.equal(flow.trialFailures[0]?.assertion, longExtracted, 'master status trialFailures keeps the full multiline assertion');

  // Verify Playwright summary parsing also keeps Locator, Expected, Received and spec line after the first newline.
  const pwLog = [
    '  1) [chromium] › browser-tests/master-page-ux.spec.ts:137:1 › e2e:master-page-ux — reconnect',
    '',
    '    Error: expect(locator).toHaveAttribute(expected) failed',
    '',
    "    Locator: locator('.live-terminal')",
    '    Expected: "control"',
    '    Received: "reconnecting"',
    '      at browser-tests/master-page-ux.spec.ts:212:55',
    '',
    '  1 failed (5.0s)',
  ].join('\n');
  const checkFailure = repositoryCheckFailure(pwLog);
  assert.ok(checkFailure.firstCase, 'Playwright check failure names the first failing case');
  assert.match(checkFailure.firstCase, /Error: expect\(locator\)\.toHaveAttribute\(expected\) failed/);
  assert.match(checkFailure.firstCase, /Locator: locator\('\.live-terminal'\)/);
  assert.match(checkFailure.firstCase, /Expected: "control"/);
  assert.match(checkFailure.firstCase, /Received: "reconnecting"/);
  assert.match(checkFailure.firstCase, /browser-tests\/master-page-ux\.spec\.ts:212:55/);
  assert.equal(checkFailure.timedOut, false, 'assertion failure is not misclassified as a timeout');
});
