import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headlessReviewAnswer, reviewPrompt } from '../src/reviewer.js';
import { reviewStandards } from '../src/review-prompt.js';
import { emptyProjectMemory, projectMemoryDigest } from '../src/project-memory.js';
import { verificationMapDigest } from '../src/verification-maps.js';

// GY-3490: reviewer prompts state their verdict choices once, up front, delete repeated copies,
// report an unusable product-review environment as COULD_NOT_RUN, and stay at most 700 fixed words.

const cli = '/srv/graphyard/bin/graphyard.mjs';
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const config = { repository: 'owner/project', cliPath: cli };
const binding = { key: 'GY-9', pr: 7, sha: head, baseSha: base, policyRevision: 1 };
const criteria = [
  { id: 'AC-1', text: 'The export button downloads every row', proofs: ['e2e:export-run'] },
  { id: 'AC-2', text: 'Empty states say what to do next', proofs: ['unit:empty-state'] },
];
const memory = {
  ...emptyProjectMemory('2026-11-18T10:00:00.000Z'),
  notes: [{ id: 'n1', kind: 'decision', key: 'GY-1', text: 'Keep prompts concise.', at: '2026-11-18T10:00:00.000Z', by: 'master' }],
};
const maps = [{
  path: 'verification/app.md',
  paths: ['src/app.ts'],
  sections: { Tests: 'tests/app.test.ts', Drive: 'cli', Invariants: 'Pure prompts.', Gotchas: 'Grep tests.' },
}];
const verification = { maps, paths: ['src/app.ts'] };

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const once = (text: string, piece: string) => text.split(piece).length - 1;

const productVerdicts = 'APPROVE (ship as is), REQUEST_CHANGES (each as BLOCKING: SCREEN OR FLOW - FINDING), REJECT (should not ship), COULD_NOT_RUN (you could not open the app: GRAPHYARD_URL unset, no browser, unreachable; no worker can fix that, so it is never a change request)';
const envFailurePhrase = 'GRAPHYARD_URL unset, no Mainworks CLI, no browser tool, or an app you cannot reach';
const noWeakenPhrase = 'Never weaken a requirement to let it pass, and never hold a change that meets its criteria over a FOLLOW-UP';

test('e2e:review-verdict-first AC-1 — product review opens with the verdict choices once and names the unreachable-environment list once, headless and interactive alike', () => {
  const modes = [
    { name: 'preview', plane: { head, baseTip: base, product: true, previewUrl: 'https://graphyard.example/preview/GY-9/' } },
    { name: 'served', plane: { head, baseTip: base, product: true, servedUrl: 'http://127.0.0.1:4397' } },
    { name: 'default', plane: { head, baseTip: base, product: true } },
  ];
  for (const { name, plane } of modes) {
    for (const [label, answer] of [['interactive', undefined], ['headless', headlessReviewAnswer(binding.key, true, '/screenshots')]] as const) {
      const prompt = reviewPrompt(config, binding, undefined, undefined, criteria, undefined, ['src/app.ts'], null, null, null, { ...plane, ...(answer ? { answer } : {}) });
      assert.equal(once(prompt, productVerdicts), 1, `${name} ${label}: verdict choices appear once`);
      assert.ok(prompt.indexOf(productVerdicts) < prompt.indexOf(`Work item ${binding.key}`), `${name} ${label}: verdict choices open the request`);
      assert.equal(once(prompt, envFailurePhrase), 1, `${name} ${label}: environment-failure phrase appears once`);
    }
  }
});

test('e2e:review-verdict-first AC-2 — an install that serves an app but cannot be reached says COULD_NOT_RUN; the noApp rule is unchanged', () => {
  const served = reviewPrompt(config, binding, undefined, undefined, criteria, undefined, ['src/app.ts'], null, null, null, { head, baseTip: base, product: true });
  assert.match(served, /an app you cannot reach — report that as COULD_NOT_RUN with the reason, never as a change request/);
  assert.doesNotMatch(served, /no walkthrough is required and none is owed/);

  const noApp = reviewPrompt(config, binding, undefined, undefined, criteria, undefined, ['src/app.ts'], null, null, null, { head, baseTip: base, product: true, noApp: true });
  assert.ok(
    noApp.includes(`This install serves no app and declares no serve command, so no walkthrough is required and none is owed: judge the change from the head's diff (git diff ${base} ${head}), the criteria and the trial evidence, and say in your findings that no app was there to walk — the absence of an app is never a reason to request changes.`),
    'the existing noApp rule is unchanged',
  );
  assert.equal(once(noApp, productVerdicts), 1, 'noApp still opens with the verdict choices once');
});

test('e2e:review-verdict-first AC-3 — code review states no-weaken and autonomy once, and both reviewer requests stay at most 700 fixed words', () => {
  const diff = ` The change, git diff ${base} ${head}:\ndiff --git a/src/app.ts b/src/app.ts\n+export const x = 1;\n`;
  const criteriaData = [
    ...criteria.map(criterion => `[${criterion.id}] ${criterion.text}`),
    ...criteria.map(criterion => reviewStandards({ key: binding.key, criteria: [criterion], scenarioRequirements: [] }, head).criteria.match(/\[AC-\d\] proofs: \[[^\]]*\]/)![0]),
  ];
  const memoryText = projectMemoryDigest(memory, 'reviewer', { baseSha: base });
  const mapText = verificationMapDigest(verification.maps, verification.paths, 'reviewer');
  const stripFixtureData = (text: string) => {
    let fixed = text;
    for (const piece of [diff, memoryText, mapText, ...criteriaData]) if (piece) fixed = fixed.split(piece).join(' ');
    return fixed;
  };

  for (const [label, answer] of [['interactive', undefined], ['headless', `${diff}\n${headlessReviewAnswer(binding.key, false)}`]] as const) {
    const code = reviewPrompt(config, binding, undefined, undefined, criteria, undefined, ['src/app.ts'], null, memory, verification, { head, baseTip: base, ...(answer ? { answer } : {}) });
    assert.equal(once(code, noWeakenPhrase), 1, `code ${label}: no-weaken rule appears once`);
    assert.equal(once(code, 'Decide and act on your own'), 1, `code ${label}: autonomy lead appears once`);
    assert.equal(code.match(/never ask a human/gi)?.length ?? 0, 1, `code ${label}: never-ask-a-human appears once`);
    assert.ok(!code.includes('without asking for confirmation'), `code ${label}: duplicate confirmation text is deleted`);
    const count = words(stripFixtureData(code));
    assert.ok(count <= 700, `code ${label} has ${count} fixed words, at most 700`);
  }

  for (const [label, answer] of [['interactive', undefined], ['headless', `${diff}\n${headlessReviewAnswer(binding.key, true, '/screenshots')}`]] as const) {
    const product = reviewPrompt(config, binding, undefined, undefined, criteria, undefined, ['src/app.ts'], null, memory, verification, { head, baseTip: base, product: true, previewUrl: 'https://graphyard.example/preview/GY-9/', ...(answer ? { answer } : {}) });
    const count = words(stripFixtureData(product));
    assert.ok(count <= 700, `product ${label} has ${count} fixed words, at most 700`);
  }
});
