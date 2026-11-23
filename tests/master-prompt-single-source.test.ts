import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterPrompt, upstreamRule } from '../src/master/harness.js';
import { masterInstructions } from '../src/master/instructions.js';
import { masterGuide } from '../src/master/guide.js';
import { itemLeadBrief } from '../src/review-prompt.js';
import type { MasterConfig } from '../src/master/profiles.js';

// GY-3491: the master's rules live in one place each — a short first request, the role
// instructions and the operating guide `master guide` prints — instead of three drifting copies.

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const base = { repository: 'owner/project', cliPath: '/bin/graphyard.mjs', url: 'https://graphyard.example', credentialFile: '/credentials/master.token',
  hostId: 'host', baseBranch: 'main', masterAgentName: 'graphyard-master-project', workers: [], reviewers: [], producers: [], run: {} } as unknown as MasterConfig;
// masterInstructions + masterGuide on the base tip (2094e0be2b): 633 + 4686 words.
const baseRuleWords = 633 + 4686;
const count = (text: string, phrase: RegExp) => text.match(new RegExp(phrase.source, 'gi'))?.length ?? 0;

test('unit:master-prompt-single-source — the master prompt is at most 200 words beside the repository name and upstream sentence, and still states its role and boundaries', () => {
  for (const config of [base, { ...base, operatorAgent: { login: 'agent' } } as unknown as MasterConfig, { ...base, repository: 'cryptob1/graphyard' }]) {
    const prompt = masterPrompt(config);
    const counted = prompt.replace(upstreamRule(config.repository), '').replaceAll(config.repository, '');
    assert.ok(words(counted) <= 200, `the ${config.repository} prompt is ${words(counted)} words`);
    assert.match(prompt, /dedicated Graphyard master agent for .*, responsible for the product succeeding/);
    assert.match(prompt, /only goals and priorities, spending money or opening third-party accounts, and issuing credentials to people belong to the human/);
    assert.match(prompt, /Never implement, claim worker leases, review, approve or submit evidence/);
    assert.match(prompt, /Run node \/bin\/graphyard\.mjs master status, then node \/bin\/graphyard\.mjs master guide\./);
    assert.ok(prompt.includes(itemLeadBrief.trim()), 'the prompt asks for why and simplest first');
  }
});

test('unit:master-prompt-single-source — master instructions and guide are at least 25% shorter, and each rule lives in exactly one of prompt, instructions and guide', () => {
  const rules = words(masterInstructions) + words(masterGuide);
  assert.ok(rules <= baseRuleWords * 0.75, `instructions and guide are ${rules} words, at most ${baseRuleWords * 0.75}`);
  const texts = { masterPrompt: masterPrompt(base), masterInstructions, masterGuide };
  const owners: [string, RegExp, keyof typeof texts][] = [
    ['the three human decisions', /credentials (?:to|for) people/, 'masterPrompt'],
    ['review and proof start on their own', /review and proof collection start on their own/, 'masterInstructions'],
    ['never approve or submit evidence', /submit evidence/, 'masterPrompt'],
  ];
  for (const [rule, phrase, owner] of owners) {
    const found = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, count(text, phrase)]));
    assert.deepEqual(found, { masterPrompt: 0, masterInstructions: 0, masterGuide: 0, [owner]: 1 }, `${rule} appears once, in ${owner}`);
  }
});
