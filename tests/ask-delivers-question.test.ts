import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { priorityServer } from './helpers/priority-server.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';

const cli = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

// A stand-in for claude -p: like the real one, it needs its prompt on stdin (its variadic tool flags swallow a trailing argument) and refuses to run without it.
const stubRuntime = `#!/usr/bin/env node
const input = require('node:fs').readFileSync(0, 'utf8');
const question = /Question: (.*)/.exec(input)?.[1];
if (!question) { console.error('Error: Input must be provided either through stdin or as a prompt argument when using --print'); process.exit(1); }
console.log(JSON.stringify({ summary: 'You asked: ' + question, evidence: ['README.md:1'] }));
`;

test('integration:ask-delivers-question — ask gives the investigator its question and prints its answer', async () => {
  const f = await priorityServer();
  try {
    const item = await f.ok('work', { type: 'chore', priority: 3, title: 'Ask me', why: 'w', simplest: 's', criteria: [{ id: 'AC-1', text: 'Asked', proofs: ['e2e:create-work-item'] }] });
    const { root: repo } = await gitRepo({ label: 'ask-delivers-question-repo', files: { 'README.md': 'hello\n' } });
    const bin = await temporaryDirectory('ask-delivers-question-bin');
    writeFileSync(join(bin, 'claude'), stubRuntime, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NODE_COMPILE_CACHE: join(bin, 'compile-cache'), GRAPHYARD_URL: f.url, GRAPHYARD_TOKEN: f.tokens.worker };
    delete env.GRAPHYARD_TOKEN_FILE; delete env.GRAPHYARD_ASK_RUNTIME;

    const { stdout } = await promisify(execFile)(process.execPath, [cli, 'ask', item.key, 'Where', 'is', 'the', 'readme?'], { cwd: repo, env });
    const printed = JSON.parse(stdout);
    assert.equal(printed.failure, undefined, printed.failure);
    assert.equal(printed.kind, 'investigator.answered');
    assert.equal(printed.summary, 'You asked: Where is the readme?');
    assert.deepEqual(printed.evidence, ['README.md:1']);
  } finally { await f.close(); }
});
