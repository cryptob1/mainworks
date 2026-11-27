import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { priorityServer } from './helpers/priority-server.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { onSearchPath } from '../src/runtime-binary.js';

const cli = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const HOST = 'test-host';

// A stand-in runtime: records its environment and answers the question from stdin.
const stubRuntime = `#!/usr/bin/env node
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
const question = /Question: (.*)/.exec(input)?.[1];
if (!question) { console.error('missing question on stdin'); process.exit(1); }
if (process.env.FAKE_RECORD) {
  fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    customFlag: process.env.CUSTOM_FLAG ?? null,
    miseNoConfig: process.env.MISE_NO_CONFIG ?? null,
    path: process.env.PATH ?? '',
    argv: process.argv.slice(2),
  }));
}
console.log(JSON.stringify({ summary: 'Answered from registry: ' + question, evidence: ['README.md:1'] }));
`;

/** A PATH with node, git, tar and chmod, but no directory containing `claude` or `codex`. */
function pathWithout(...programs: string[]): string {
  const entries = (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(delimiter).filter(Boolean);
  const kept = entries.filter(dir => programs.every(program => !onSearchPath(program, dir)));
  const nodeDir = dirname(process.execPath);
  if (!kept.includes(nodeDir) && programs.every(program => !onSearchPath(program, nodeDir))) kept.unshift(nodeDir);
  return kept.join(delimiter);
}

test('integration:ask-investigator-starts — ask resolves a registered runtime when PATH lacks claude, and names runtimes tried when none can start', async () => {
  const f = await priorityServer();
  try {
    const item = await f.ok('work', {
      type: 'bug', priority: 2, title: 'Ask from builder without claude on PATH',
      why: 'w', simplest: 's',
      criteria: [{ id: 'AC-1', text: 'Asked', proofs: ['e2e:create-work-item'] }],
    });
    const { root: repo } = await gitRepo({ label: 'ask-investigator-starts-repo', files: { 'README.md': 'hello\n' } });
    const runtimeBin = await temporaryDirectory('ask-investigator-starts-bin');
    const claudeHome = await temporaryDirectory('ask-investigator-starts-home');
    const emptyBin = await temporaryDirectory('ask-investigator-starts-empty');
    const compileCache = await temporaryDirectory('ask-investigator-starts-cache');
    writeFileSync(join(runtimeBin, 'claude'), stubRuntime, { mode: 0o755 });
    const record = join(compileCache, 'record.json');

    await f.ok('agent-registry/apply', {
      runtimes: [{
        name: 'claude',
        description: 'Registered Claude Code',
        launch: {
          kind: 'claude',
          args: [],
          environment: { PATH: runtimeBin, CUSTOM_FLAG: 'from-registry' },
          homeVariable: 'CLAUDE_CONFIG_DIR',
          modelFlag: '--model',
          login: 'CLAUDE_CONFIG_DIR={home} claude, then /login',
          loginFile: '.credentials.json',
          toolsFlag: '--allowedTools',
        },
      }],
      models: [{ name: 'opus', provider: 'Anthropic', id: 'claude-opus-4', cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong', contextTokens: null } }],
      accounts: [{ name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host: HOST, home: claudeHome }, enabled: true, maxSessions: null }],
      roles: [{ name: 'worker', accounts: ['claude-a'], concurrency: 1 }],
      reason: 'Register launchable claude runtime for ask test',
    });

    const strippedPath = pathWithout('claude', 'codex');
    assert.equal(onSearchPath('claude', strippedPath), null, 'builder PATH lacks claude');

    const runAsk = async (question: string) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: strippedPath,
        NODE_COMPILE_CACHE: compileCache,
        FAKE_RECORD: record,
        GRAPHYARD_URL: f.url,
        GRAPHYARD_TOKEN: f.tokens.worker,
        GRAPHYARD_HOST_ID: HOST,
      };
      delete env.GRAPHYARD_TOKEN_FILE;
      delete env.GRAPHYARD_ASK_RUNTIME;
      delete env.MAINWORKS_ASK_RUNTIME;
      delete env.CLAUDE_CONFIG_DIR;
      const { stdout } = await promisify(execFile)(process.execPath, [cli, 'ask', item.key, question], { cwd: repo, env });
      return JSON.parse(stdout);
    };

    // AC-1 & AC-2: builder PATH lacks claude, but the registry names a launchable runtime and account.
    const answered = await runAsk('Where is the readme?');
    assert.equal(answered.failure, undefined, answered.failure);
    assert.equal(answered.kind, 'investigator.answered');
    assert.equal(answered.summary, 'Answered from registry: Where is the readme?');
    assert.deepEqual(answered.evidence, ['README.md:1']);

    const seen = JSON.parse(readFileSync(record, 'utf8'));
    assert.equal(seen.claudeConfigDir, claudeHome, 'investigator receives the registered account login home');
    assert.equal(seen.customFlag, 'from-registry', 'investigator receives the registered runtime environment');
    assert.equal(seen.miseNoConfig, '1', 'investigator keeps mise off unrelated configs as worker launches do');
    assert.ok(seen.path.split(delimiter).includes(runtimeBin), 'investigator PATH includes the registered runtime directory');

    // AC-1: when no runtime can start, the answer names the runtimes tried and why each failed.
    await f.ok('agent-registry/runtimes', {
      runtime: {
        name: 'claude',
        description: 'Uninstalled Claude Code',
        launch: {
          kind: 'claude',
          args: [],
          environment: { PATH: emptyBin },
          homeVariable: 'CLAUDE_CONFIG_DIR',
          modelFlag: '--model',
          login: 'CLAUDE_CONFIG_DIR={home} claude, then /login',
          loginFile: '.credentials.json',
          toolsFlag: '--allowedTools',
        },
      },
      reason: 'Point claude at an empty directory to verify failure reporting',
    });

    const failed = await runAsk('Will this name what it tried?');
    assert.equal(failed.kind, 'investigator.failed');
    assert.equal(failed.summary, undefined);
    assert.doesNotMatch(failed.failure, /\n/);
    assert.match(failed.failure, /claude/, 'failure names the runtime tried');
    assert.match(failed.failure, /claude-a/, 'failure names the account tried');
    assert.match(failed.failure, /not found|ENOENT/i, 'failure explains why the runtime could not start');
  } finally {
    await f.close();
  }
});
