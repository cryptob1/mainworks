import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cliEvidenceSubmit, piProducerPrompt, producerPrompt, producerRequest, toolEvidenceSubmit } from '../src/producer.js';

// GY-3492: one producer request for every runtime; only the submit-evidence instruction differs.
const head = 'a'.repeat(40), base = 'b'.repeat(40), cli = '/srv/bin/graphyard.mjs';
const checkout = { directory: '/srv/worktrees/proof/GY-1', worktree: '/srv/worktrees/proof/GY-1/checkout' };
const criteria = [{ id: 'AC-1', text: 'The board shows each item exactly once whatever its stage.', proofs: ['unit:board-once'] }];
const render = (proofs: string[]) => {
  const binding = { key: 'GY-1', pr: 7, sha: head, baseSha: base, policyRevision: 3, group: proofs[0].split(':')[0], proofs, checkout: checkout.directory };
  return {
    binding,
    cli: producerPrompt({ repository: 'owner/project', cliPath: cli }, binding, { principal: 'producer-1' }, checkout),
    pi: piProducerPrompt({ repository: 'owner/project', cliPath: cli }, binding, criteria, checkout, null, 'producer-1'),
  };
};
const cliSubmit = (binding: { key: string; proofs: string[] }) => cliEvidenceSubmit(cli, binding.key, checkout.directory, binding.proofs[0]);

test('e2e:producer-single-prompt — AC-1: both runtimes render one builder; only the submit instruction differs and the shared paragraphs exist once in src/', async () => {
  for (const proofs of [['unit:board-once'], ['manual:host-install-live']]) {
    const { binding, cli: viaCli, pi } = render(proofs);
    assert.equal(viaCli, producerRequest({ repository: 'owner/project', cliPath: cli }, binding, 'producer-1', [], checkout, null, cliSubmit(binding)));
    assert.equal(pi, producerRequest({ repository: 'owner/project', cliPath: cli }, binding, 'producer-1', criteria, checkout, null, toolEvidenceSubmit(binding)));
    const criteriaSentence = /The criteria these proofs establish: .*? (?=Your Graphyard credential)/;
    assert.ok(viaCli.includes(cliSubmit(binding)) && !viaCli.includes('graphyard_submit_evidence'));
    assert.ok(pi.includes(toolEvidenceSubmit(binding)) && !pi.includes(` evidence ${binding.key} FILE`));
    assert.equal(viaCli.replace(cliSubmit(binding), '<submit>'), pi.replace(criteriaSentence, '').replace(toolEvidenceSubmit(binding), '<submit>'), 'everything but the submit instruction (and the criteria data) is the same text');
  }
  const sources = fileURLToPath(new URL('../src/', import.meta.url));
  const files = (await readdir(sources, { recursive: true })).filter(name => name.endsWith('.ts'));
  const text = (await Promise.all(files.map(name => readFile(join(sources, name), 'utf8')))).join('\n');
  for (const paragraph of ['Work only in a detached worktree at the allocated path, never under a temporary directory', 'run it again with the behaviour removed', 'remove both worktrees', 'A proof that passes against an unchanged tree proves nothing'])
    assert.equal(text.split(paragraph).length - 1, 1, `"${paragraph}" is written once in src/`);
});

test('e2e:producer-single-prompt — AC-2: each output is at most 450 words beside its data and carries the credential, exercise and live-install rules', () => {
  for (const proofs of [['unit:board-once'], ['manual:host-install-live']]) {
    const { binding, cli: viaCli, pi } = render(proofs);
    for (const [runtime, prompt] of [['cli', viaCli], ['pi', pi]] as const) {
      const rest = prompt.split(binding.proofs.join(', ')).join(' ').replace(criteria[0].text, ' ').split(/\s+/).filter(word => word && !word.includes('/'));
      assert.ok(rest.length <= 450, `${runtime} ${proofs[0]}: ${rest.length} words`);
      assert.ok(prompt.includes('Your Graphyard credential is the file named by GRAPHYARD_TOKEN_FILE') && prompt.includes('never print, copy, cat, or echo it or any other credential'), `${runtime}: the credential rule`);
      assert.ok(prompt.includes('run it again with the behaviour removed'), `${runtime}: the exercise rule`);
      assert.equal(prompt.includes('HCLOUD_TOKEN and HETZNER_SPEND_CAP_USD_MONTHLY are available in your environment'), proofs[0] === 'manual:host-install-live', `${runtime}: live-install guidance only for a live-install proof`);
    }
  }
});
