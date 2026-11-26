import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHelp } from '../src/cli/index.js';
import { guideList, guideText, guideTopicList } from '../src/guide.js';
import { masterGuide } from '../src/master/guide.js';
import { authorLine, ownerAttentionLine, workerCommitterEnvironment } from '../src/check-in-author.js';
import { trialAuthor } from '../src/merge-writer/trial.js';
import { deployKeyTitle } from '../src/install/deploy-key.js';
import { mainworksGitIdentity } from '../src/up.js';
import { managedInstructions } from '../src/repository-setup.js';

// GY-3872: the strings Mainworks shows a person say Mainworks. 'graphyard' stays only in the
// machine-facing names below, each kept because an existing install, branch or file still uses it.

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (path: string) => readFileSync(join(root, path), 'utf8');
const sources = (directory: string) => readdirSync(join(root, directory)).filter(name => /\.tsx?$/.test(name)).map(name => source(join(directory, name)));

/** Every string a person reads, by where they read it. */
const shown: Record<string, string[]> = {
  'CLI output': [renderHelp(), guideList(), ...guideTopicList.map(topic => guideText(topic)), masterGuide, ownerAttentionLine],
  'status text': [source('src/model/next-action.ts'), source('src/model-boundary/liveness.ts')],
  'page text': [...sources('web/pages'), ...sources('web/components'), source('web/glossary.ts')],
  'commit identities': [trialAuthor, `${trialAuthor}@users.noreply.invalid`, ...Object.values(workerCommitterEnvironment('graphyard-codex-2')), authorLine(null), ...Object.values(mainworksGitIdentity)],
  'key titles': [deployKeyTitle('host')],
  'AGENTS.md': [source('AGENTS.md'), managedInstructions('')],
  'README.md': [source('README.md').replace('Mainworks was previously called Graphyard;', '')],
};

/** The machine-facing names that keep the old word, each with why it stays. */
const allowed: [RegExp, string][] = [
  [/^graphyard$/, 'the old command, which keeps working; the system actor id in recorded history; the saved-login username and terminal socket protocol existing browsers hold; the AGENTS.md block markers existing installs find'],
  [/^\/graphyard$/, 'the closing AGENTS.md block marker existing installs find'],
  [/^(bin\/)?graphyard\.mjs$/, 'the old launcher, which keeps working'],
  [/^\.graphyard(\/|$)/, 'the state directory existing checkouts hold'],
  [/^~\/\.(config|local\/share)\/graphyard(\/|$)/, 'the config and data directories existing installs hold'],
  [/^@?cryptob1\/graphyard$/, 'the published npm package and the GitHub repository'],
  [/^graphyard\/(onboarding|gy-|$)/, 'branch names (graphyard/<key>-<epoch>) in-flight work and gates match'],
  [/^refs\/graphyard\//, 'refs the merge writer and deploy unit read'],
  [/^graphyard-(master|deploy|local)(-OWNER-NAME)?\.service$/, 'systemd units of existing installs'],
  [/^graphyard-(OWNER-NAME-(server|db)-1|preview-)/, 'Docker container and Compose project names of existing installs'],
  [/^graphyard-host-shim/, 'the installed host helper sudoers names'],
  [/^graphyard\.(json|trial\.Dockerfile)$/, 'policy files projects already commit'],
  [/^graphyard[.-](boot|theme|pausedConcurrency|removedConnects|token)$/, 'browser storage keys an open session already holds'],
];

test('unit:no-old-name-where-a-person-reads — CLI output, status text, page text, commit identities, key titles, AGENTS.md and README.md say Mainworks; Graphyard or graphyard appears only as an allowed machine-facing name, each with its reason', () => {
  for (const [, reason] of allowed) assert.ok(reason.length > 10, 'every allowed name says why it stays');
  const found: string[] = [];
  for (const [where, texts] of Object.entries(shown)) {
    for (const text of texts) for (const word of text.match(/[\w.@~/$*…-]*[Gg]raphyard[\w.@~/$*…-]*/g) ?? []) {
      const token = word.replace(/^[^\w.@~/]+|[.…*]+$/g, '').replace(/[.…*]+$/g, '');
      if (!allowed.some(([pattern]) => pattern.test(token))) found.push(`${where}: ${token}`);
    }
  }
  assert.deepEqual([...new Set(found)], [], 'the old name where a person reads it');
  assert.match(trialAuthor, /^mainworks-/); assert.match(deployKeyTitle('host'), /^mainworks-/);
  assert.match(source('AGENTS.md'), /^# Working on Mainworks/);
  assert.match(source('AGENTS.md'), /the old `graphyard` command and `GRAPHYARD_\*` settings still work/);
});
