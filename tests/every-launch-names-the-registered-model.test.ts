import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountLaunch } from '../src/master/environments.js';
import { headlessArgs } from '../src/headless-argv.js';
import { smokeRegistryAccount } from '../src/runner/roles.js';
import type { FleetLaunchAccount } from '../src/fleet.js';

// GY-3687: every launch Mainworks builds for a registry account names the account's registered
// model id — worker start, worker continue, code review, product review, producer and smoke, on
// each runtime — even when the stored runtime names no model flag (the contract the 2026-11-22
// fable session launched on) and a role policy carries an alias such as 'opus'.

const ids: Record<string, string> = { claude: 'claude-opus-5-5', codex: 'gpt-5.1-codex', opencode: 'zai-coding-plan/glm-5.3' };
const homes: Record<string, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', opencode: 'XDG_DATA_HOME' };
const account = (kind: string): FleetLaunchAccount => ({ name: `${kind}-a`, kind, home: `/accounts/${kind}-a`,
  fleet: { runtime: kind, model: 'opus', modelId: ids[kind]!, session: 's-1', reason: 'chosen', policy: { args: ['--model', 'opus'] } as never,
    contract: { kind, args: kind === 'claude' ? ['--dangerously-skip-permissions'] : [], environment: {}, homeVariable: homes[kind]!, modelFlag: null, login: null, loginFile: null } } });
const profile = { approvals: 'auto' as const, agentArgs: [], environment: {} };

/** The model a launch names: the word after its model flag, or OpenCode's config content. */
function named(kind: string, args: string[], environment: Record<string, string> = {}) {
  if (kind === 'opencode' && !args.includes('--model')) return JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? '{}').model ?? null;
  const flags = args.flatMap((arg, index) => arg === '--model' ? [args[index + 1]] : arg.startsWith('--model=') ? [arg.slice(8)] : []);
  assert.ok(flags.length <= 1, `one model flag: ${args.join(' ')}`);
  return flags[0] ?? null;
}

test('unit:every-launch-names-the-registered-model — each launch kind on each runtime carries the registered id, never an alias or nothing', async () => {
  for (const kind of ['claude', 'codex', 'opencode']) {
    const chosen = account(kind), id = ids[kind]!;
    const headless = accountLaunch(profile, chosen, { headless: true, writable: ['/tmp/x'] });
    const interactive = accountLaunch(profile, chosen, { writable: ['/tmp/x'] });
    const launches: Record<string, { args: string[]; environment: Record<string, string> }> = {
      'worker start': { args: headlessArgs(kind, headless.args, 'go', headless.contract), environment: headless.environment },
      'worker continue': { args: headlessArgs(kind, headless.args, 'go', headless.contract, [], 'session-1'), environment: headless.environment },
      'code review': { args: headlessArgs(kind, headless.args, 'review', headless.contract), environment: headless.environment },
      'product review': { args: headlessArgs(kind, headless.args, 'walk the app', headless.contract), environment: headless.environment },
      producer: { args: interactive.args, environment: interactive.environment },
    };
    // The smoke runs a stub that prints the words it was given and answers OK.
    const smoke = await smokeRegistryAccount(chosen, { cwd: process.cwd(), command: process.execPath, commandArgs: ['-e', 'console.log(JSON.stringify(process.argv.slice(1))); console.log("OK")', '--'] });
    assert.equal(smoke.ok, true, smoke.error ?? '');
    launches.smoke = { args: JSON.parse(smoke.output!.split('\n')[0]!), environment: {} };
    for (const [name, launch] of Object.entries(launches)) {
      assert.equal(named(kind, launch.args, launch.environment), id, `${kind} ${name} names ${id}: ${launch.args.join(' ')}`);
      assert.ok(!launch.args.includes('opus'), `${kind} ${name} passes no alias: ${launch.args.join(' ')}`);
    }
  }
});
