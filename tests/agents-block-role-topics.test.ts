import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { managedInstructions } from '../src/repository-setup.js';
import { guideList, guideText, guideTopicList } from '../src/guide.js';

// GY-3493: the AGENTS.md block names the guide topics each role needs, and guide claim is short.
const roleLine = '(worker: claim, sync, complete, park, blocked; reviewer: review; producer: proof; `guide` alone lists the rest).';
const norm = (text: string) => text.split(/\s+/).filter(Boolean).join(' ');
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

test('e2e:agents-block-role-topics — the block names role topics, guide lists every topic, the checked-in block matches', () => {
  const block = managedInstructions('');
  assert.ok(block.includes(roleLine), 'the block carries the role topics line');
  assert.ok(!block.includes('(topics: claim'), 'the old topics line is gone');
  for (const topic of guideTopicList) assert.ok(guideList().includes(topic), `guide alone lists ${topic}`);
  assert.ok(readFileSync('AGENTS.md', 'utf8').includes(block.trim()), 'AGENTS.md holds the regenerated block');
});

test('e2e:agents-block-role-topics — guide claim is at most 90 words and keeps the lease rules; manual startup moved to guide setup', () => {
  const claim = norm(guideText('claim'));
  assert.ok(words(claim) <= 90, `guide claim is ${words(claim)} words`);
  for (const rule of [/dependencies/, /lease epoch/, /every 30 seconds/, /Stop editing on lease loss/, /Do not reuse another assignment's worktree/, /Never use an operator\/producer token for implementation/]) assert.match(claim, rule);
  const setup = norm(guideText('setup'));
  assert.ok(!claim.includes('watch GY-N EPOCH') && setup.includes('Run agents through `watch GY-N EPOCH -- YOUR_AGENT_COMMAND`.'));
  assert.ok(!claim.includes('handoff GY-N') && setup.includes('Use `handoff GY-N` to obtain the workspace and launch command for this machine.'));
  assert.ok(setup.includes('For manual startup, use the CLI path printed by `init` or Herdr\'s handoff command.'));
  // Word-neutral move: before GY-3493, claim, setup and blocked rendered 254 + 565 + 182 = 1001 words.
  const moved = words(claim) + words(setup) + words(guideText('blocked'));
  assert.ok(moved <= 1001, `claim + setup + blocked is ${moved} words; src/guide.ts does not grow from the move`);
});
