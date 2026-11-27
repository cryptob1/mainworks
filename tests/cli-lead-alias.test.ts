import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, renderHelp } from '../src/cli/index.js';
import { guideList, guideText, guideTopicList } from '../src/guide.js';
import { claudeRuleProblem, masterHarnessPlan } from '../src/harness.js';
import { masterPrompt } from '../src/master/harness.js';
import type { MasterConfig } from '../src/master/profiles.js';
import { harnessDecision } from './helpers/harness-decision.js';

// GY-4050: `mainworks lead` is the command, with `master` kept as a hidden alias,
// in help and guide topics.

async function printed(argv: string[]) {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.join(' ')); };
  try { await main(argv); } finally { console.log = log; }
  return lines.join('\n');
}

test('unit:cli-lead-alias — mainworks lead SUB matches master SUB, master is hidden from help, and help and guide topics say lead', async () => {
  const help = renderHelp();
  const subcommands = [...new Set([...help.matchAll(/^ {2}lead ([a-z-]+)/gm)].map(match => match[1]))];
  assert.ok(subcommands.length > 20, `help lists lead's subcommands: ${subcommands.join(', ')}`);
  for (const word of ['master', 'coordinator']) {
    assert.doesNotMatch(help, new RegExp(word, 'i'), `help says ${word}`);
  }

  for (const sub of subcommands) {
    const lead = await printed(['lead', sub, '--help']);
    const master = await printed(['master', sub, '--help']);
    assert.ok(lead.includes(`lead ${sub}`), `lead ${sub} --help prints lead's help`);
    assert.equal(master, lead, `master ${sub} --help prints the same help as lead ${sub}`);
    for (const word of ['master', 'coordinator']) {
      assert.doesNotMatch(lead, new RegExp(word, 'i'), `lead ${sub} --help says ${word}`);
    }
  }

  // Real subcommand execution parity: lead guide and master guide produce identical output.
  const leadGuide = await printed(['lead', 'guide']);
  const masterGuide = await printed(['master', 'guide']);
  assert.equal(masterGuide, leadGuide, 'master guide behaves identically to lead guide');
  assert.match(leadGuide, /Lead-agent operating mode/);

  // Guide topics list `lead`, not `master`, while `guide master` still aliases to `guide lead`.
  assert.ok(guideTopicList.includes('lead'), 'guideTopicList includes lead');
  assert.ok(!guideTopicList.includes('master' as never), 'guideTopicList does not list master');
  assert.doesNotMatch(guideList(), /\bmaster\b/i, 'guideList does not mention master');
  assert.equal(guideText('master'), guideText('lead'), 'guide master aliases to guide lead');
  assert.equal(await printed(['guide', 'master']), await printed(['guide', 'lead']), 'CLI guide master matches guide lead');

  // Guide topics say `lead` for CLI commands rather than `master`.
  for (const topic of guideTopicList) {
    const text = guideText(topic);
    assert.doesNotMatch(text, /\bmainworks master\b/i, `guide ${topic} says mainworks master`);
    assert.doesNotMatch(text, /\bguide master\b/i, `guide ${topic} says guide master`);
  }

  // The Claude Lead's generated harness allows every `lead` form its guide names (plus `lead review:*`)
  // and keeps the hidden `master` rules; the Lead's launch prompt runs `lead status` and `lead guide`.
  const cliPath = '/bin/graphyard.mjs';
  const plan = masterHarnessPlan({ harness: 'claude', root: '/repo', cliPath, repository: 'owner/project', baseBranch: 'main', credentialHome: '/home/x/.config/graphyard' });
  assert.deepEqual([...plan.allow, ...plan.deny].map(entry => claudeRuleProblem(entry.rule)).filter(Boolean), []);
  const allowRules = new Set(plan.allow.map(entry => entry.rule));
  assert.ok(allowRules.has(`Bash(node ${cliPath} lead:*)`), 'harness allows lead:*');
  assert.ok(allowRules.has(`Bash(node ${cliPath} lead review:*)`), 'harness allows lead review:*');
  assert.ok(allowRules.has(`Bash(node ${cliPath} master:*)`), 'harness keeps master:*');
  assert.ok(allowRules.has(`Bash(node ${cliPath} master review:*)`), 'harness keeps master review:*');

  const guideLeadSubs = new Set<string>();
  for (const text of [leadGuide, guideText('lead')]) {
    for (const match of text.matchAll(/\blead ([a-z][a-z-|]*)/g)) {
      for (const part of match[1].split('|')) {
        if (subcommands.includes(part)) guideLeadSubs.add(part);
      }
    }
  }
  assert.ok(guideLeadSubs.size > 10, `guide names lead subcommands: ${[...guideLeadSubs].join(', ')}`);
  for (const sub of guideLeadSubs) {
    assert.equal(harnessDecision(plan, `node ${cliPath} lead ${sub}`).decision, 'allow', `harness allows lead ${sub}`);
    assert.equal(harnessDecision(plan, `node ${cliPath} lead ${sub} GY-1`).decision, 'allow', `harness allows lead ${sub} GY-1`);
  }

  const prompt = masterPrompt({
    repository: 'owner/project', cliPath, url: 'https://graphyard.example', credentialFile: '/credentials/master.token',
    hostId: 'host', baseBranch: 'main', masterAgentName: 'graphyard-master-project', workers: [], reviewers: [], producers: [], run: {},
  } as unknown as MasterConfig);
  assert.match(prompt, /Run node \/bin\/graphyard\.mjs lead status, then node \/bin\/graphyard\.mjs lead guide\./);
  assert.equal(harnessDecision(plan, `node ${cliPath} lead status`).decision, 'allow');
  assert.equal(harnessDecision(plan, `node ${cliPath} lead guide`).decision, 'allow');
});
