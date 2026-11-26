import assert from 'node:assert/strict';
import test from 'node:test';
import { observeStart } from '../src/master/launch.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';

test('unit:launch-shell-runtime-identity — installed agents use their kind, custom runtime paths keep their registered identity', async () => {
  for (const [program, kind] of [['/opt/agents/claude', 'claude'], ['/opt/agents/codex', 'codex'], [process.execPath, process.execPath]]) {
    const command = `${program} fixture.js`;
    assert.equal(expandTypedCommand(command).kind, kind);
    startedAtOnce(['pane', 'run', 'fixture-pane', command]);
    const observation = await observeStart('fixture-pane', kind!, command, (_program, args) => startedAtOnce(args) ?? '{}');
    assert.equal(observation.state, 'ready', observation.detail);
  }
});
