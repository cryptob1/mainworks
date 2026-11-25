import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectProvider, relaySubscriptionLogin } from '../src/fleet.js';
import { checkAgentEnvironment } from '../src/master/environments.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3831: tests/cursor-confined-sign-in.test.ts failed in merge trials when the 50 ms poll in
// relaySubscriptionLogin fired before the login stub wrote cursor/auth.json. Because a logged-out
// cursor home (cursor-c) already has a profile-only cli-config.json ({}) and relaySubscriptionLogin
// only checked access(cli-config.json), the first poll saw the pre-existing file, killed the login
// child with SIGTERM, and reported loggedIn: true before any sign-in existed.
//
// This test reproduces the race deterministically without host load or lengthened timeouts: the
// login stub waits on a gate file that is only released on the second poll tick (via isCancelled),
// guaranteeing at least one poll runs while cli-config.json is still profile-only.
test('unit:cursor-confined-sign-in-pinned — cursor login relay ignores a pre-existing profile-only cli-config.json until a real sign-in is written', async () => {
  const home = await temporaryDirectory('cursor-confined-sign-in-pinned');
  mkdirSync(join(home, 'cursor'), { recursive: true });
  writeFileSync(join(home, 'cli-config.json'), '{}\n', { mode: 0o600 });

  const gate = join(home, 'release-login.gate');
  const stub = join(home, 'stub-cursor-login.mjs');
  writeFileSync(stub, [
    "import { existsSync, mkdirSync, writeFileSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    `const gate = ${JSON.stringify(gate)};`,
    'const finish = () => {',
    '  const xdg = process.env.XDG_CONFIG_HOME;',
    '  const configDir = process.env.CURSOR_CONFIG_DIR;',
    "  const signIn = join(xdg, 'cursor', 'auth.json');",
    '  mkdirSync(dirname(signIn), { recursive: true });',
    '  mkdirSync(configDir, { recursive: true });',
    '  writeFileSync(signIn, JSON.stringify({ accessToken: "signed-in-token" }) + "\\n");',
    '  writeFileSync(join(configDir, "cli-config.json"), JSON.stringify({ authInfo: { userId: "cursor-c" } }) + "\\n");',
    '  console.log("Visit https://cursor.example/device and enter code CURSOR-1234");',
    '  process.exit(0);',
    '};',
    'if (existsSync(gate)) finish();',
    'setInterval(() => { if (existsSync(gate)) finish(); }, 10);',
    '',
  ].join('\n'));

  const provider = connectProvider('cursor')!;
  let polls = 0;
  const login = await relaySubscriptionLogin(provider, home, {
    login: { command: process.execPath, args: [stub] },
    pollMs: 10,
    loginTimeoutMs: 5_000,
    isCancelled: async () => {
      polls += 1;
      if (polls >= 2 && !existsSync(gate)) writeFileSync(gate, 'go\n');
      return false;
    },
  });

  assert.equal(login.loggedIn, true, `cursor login completed: ${login.error}`);
  assert.ok(polls >= 2, `poll fired while cli-config.json was still profile-only (polls=${polls})`);
  assert.ok(existsSync(join(home, 'cursor', 'auth.json')), 'the login child was not killed before writing cursor/auth.json');
  assert.equal((await checkAgentEnvironment({ name: 'cursor-c', kind: 'cursor', home }, { quota: false, cacheMs: 0 })).loggedIn, true, 'the account reads logged in once its sign-in exists');
});
