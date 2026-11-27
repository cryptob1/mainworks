import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { priorityServer } from './helpers/priority-server.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';

const cli = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

// Stand-in Claude Code runtime: rejects any --allowedTools or --disallowedTools rule naming a tool
// Claude Code does not know (such as removed MultiEdit or legacy Task), exiting 1 as the real CLI does.
const stubRuntime = `#!${process.execPath}
const fs = require('node:fs');
const known = new Set(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent']);
const argv = process.argv.slice(2);
for (const [flag, kind] of [['--allowedTools', 'allow'], ['--disallowedTools', 'deny']]) {
  const index = argv.indexOf(flag);
  if (index === -1) continue;
  const raw = argv[index + 1] ?? '';
  for (const entry of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const tool = entry.replace(/\\(.*\\)$/s, '');
    if (!known.has(tool)) {
      console.error(\`Permission \${kind} rule \${entry} matches no known tool\`);
      process.exit(1);
    }
  }
}
if (process.env.FAKE_RECORD) {
  fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv }));
}
const input = fs.readFileSync(0, 'utf8');
const question = /Question: (.*)/.exec(input)?.[1];
if (!question) { console.error('missing question on stdin'); process.exit(1); }
console.log(JSON.stringify({ summary: 'Answered: ' + question, evidence: ['README.md:1'] }));
`;

test('integration:ask-investigator-permissions-known-tools — ask passes only known runtime tools in permission rules so the investigator runs and answers', async () => {
  const f = await priorityServer();
  try {
    const item = await f.ok('work', {
      type: 'bug', priority: 2, title: 'Ask with known tools only',
      why: 'w', simplest: 's',
      criteria: [{ id: 'AC-1', text: 'Asked', proofs: ['e2e:create-work-item'] }],
    });
    const { root: repo } = await gitRepo({ label: 'ask-known-tools-repo', files: { 'README.md': 'hello\n' } });
    const bin = await temporaryDirectory('ask-known-tools-bin');
    const record = join(bin, 'record.json');
    writeFileSync(join(bin, 'claude'), stubRuntime, { mode: 0o755 });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      NODE_COMPILE_CACHE: join(bin, 'compile-cache'),
      FAKE_RECORD: record,
      GRAPHYARD_URL: f.url,
      GRAPHYARD_TOKEN: f.tokens.worker,
    };
    delete env.GRAPHYARD_TOKEN_FILE;
    delete env.GRAPHYARD_ASK_RUNTIME;
    delete env.MAINWORKS_ASK_RUNTIME;

    const { stdout } = await promisify(execFile)(process.execPath, [cli, 'ask', item.key, 'What', 'is', 'in', 'the', 'readme?'], { cwd: repo, env });
    const printed = JSON.parse(stdout);
    assert.equal(printed.failure, undefined, printed.failure);
    assert.equal(printed.kind, 'investigator.answered');
    assert.equal(printed.summary, 'Answered: What is in the readme?');
    assert.deepEqual(printed.evidence, ['README.md:1']);

    const seen = JSON.parse(readFileSync(record, 'utf8'));
    const denied = seen.argv[seen.argv.indexOf('--disallowedTools') + 1].split(',');
    for (const tool of ['Bash', 'Edit', 'Write']) assert.ok(denied.includes(tool), `${tool} is denied`);
    assert.ok(!denied.includes('MultiEdit'), 'removed tool MultiEdit is not passed');
    assert.ok(!denied.includes('Task'), 'legacy tool Task is not passed');
  } finally {
    await f.close();
  }
});
