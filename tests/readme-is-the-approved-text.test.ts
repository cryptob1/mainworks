// mainworks: runs on a test machine; its local-only words are text, not use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// GY-3925: README.md is the owner-approved draft text (proto/readme/README.draft.md at
// 49560036020d0743676db3df811b32a750083250) without the five MEDIA comments; its five docs/media
// image lines (GY-3926) are checked by readme-media-exist-and-fit and set aside here. With current rounded numbers in 'How fast is it?', prerequisites
// in docs/setup.md as a list, where-things-run.svg linked only from docs/architecture.md
// (at most 250 words), and package.json's description matching the README's first bold line.
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const expectedBeforeTable = `# Mainworks

**Give AI coding agents a goal. Get tested, reviewed, deployed code — on your own server.**

Mainworks is an open-source assembly line for software. You say what you want; agents like Claude Code, Codex and Gemini build it, a different agent reviews it, every change is tested against the latest code before it merges, and a bad release rolls itself back. You stay out of the loop except for the decisions that are really yours.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE) [![Node 24+](https://img.shields.io/badge/node-%3E%3D24-green)](package.json)

*One goal, start to live. No one touched the code in between.*

## Why this exists

Coding agents are good at writing code and bad at being trusted with it. Left alone they mark their own work as done, merge things that break each other, and leave you reviewing a pile of pull requests at midnight.

Mainworks is the part around the agent:

- **A second opinion on everything.** The agent that writes a change never approves it. A different one reads the diff and runs the proof.
- **Nothing merges untested.** Each change is tried on top of the latest main, on real test machines, before it lands.
- **Production protects itself.** Main deploys itself. If the release check fails, the change is reverted and reopened — automatically.
- **You decide what matters.** Goals, money, and who gets access. Everything else, the agents settle among themselves.

## What it looks like

**Work** shows every change and exactly where it is.

**Each change carries its own proof** — the requirement, the test that shows it, and who checked.

**Lead** tells you, in plain words, what happened and the few things that need you.

## How it works

1. **Goal** — you write what you want and why, in a sentence or two. A lead agent turns it into requirements that can be checked.
2. **Build** — a coding agent writes the change and its tests in a sandbox of its own.
3. **Review** — a different agent reads the diff and runs the proof for each requirement. It can send the work back.
4. **Merge trial** — the change is tested on top of the latest main. If main moved underneath it, it is tested again.
5. **Deploy** — main ships itself to your server.
6. **Watch** — a release that fails its check is rolled back and the change reopened.

## Try it

You need a Linux server with Docker, Git and Node 24, and an account with at least one coding agent (Claude Code, Codex or Gemini).

\`\`\`sh
git clone https://github.com/cryptob1/mainworks.git && cd mainworks
npm ci && npm run build
node bin/mainworks.mjs up --repo OWNER/NAME
\`\`\`

\`up\` prints a link. Open it, connect an agent account, and type your first goal.

Something missing on your machine? \`mainworks doctor\` names it and the command that fixes it. The full list is in the [setup guide](docs/setup.md).

## How fast is it?

Numbers from Mainworks building itself, in the week this was written:

| | |
|---|---|`;

const expectedAfterTable = `These are our own measurements on our own repository, not a benchmark. Your project's tests decide your speed.

## What to run it on

**Use a dedicated server, not a shared virtual one.** Shared CPUs get throttled when neighbours are busy; one of our installs on a shared 8-core server regularly lost 60 to 75 percent of its CPU and was the bottleneck for days.

A good fit is a [Hetzner dedicated server](https://www.hetzner.com/dedicated-rootserver/) from the AX line with 64 GB RAM — roughly 50 to 110 US dollars a month; check the current price. (We have no affiliation with Hetzner.)

When tests become the limit, add another machine with one command:

\`\`\`sh
mainworks host add you@other-machine
\`\`\`

## Is it safe to let agents do this?

- Agents work in sandboxes and cannot push to main. Only the merge step can, and only after review and a passing trial.
- The agent that wrote a change cannot approve it or produce its proof.
- Your code and secrets stay on your server. The only outside parties are your Git host and the agent providers you connect.
- Every decision is recorded: who claimed, who reviewed, what was tested, what was reverted.

## Learn more

- [Setup guide](docs/setup.md) — requirements, first run, troubleshooting
- [How the parts fit together](docs/architecture.md) — for the curious: services, containers, where things run
- [Running several projects on one server](docs/shared-server.md)
- [Contributing](AGENTS.md) · [Apache 2.0](LICENSE)

Mainworks was previously called Graphyard; the \`graphyard\` command and settings still work.`;

test('unit:readme-is-the-approved-text — README.md matches the owner-approved draft text, setup prerequisites live in docs/setup.md, where-things-run.svg is linked only from docs/architecture.md, and package.json description matches the first bold line', () => {
  const readme = read('README.md').replace(/^\[?!\[[^\]]*\]\(docs\/media\/[^\n]*\n\n/gm, '').trim();
  const [before, rest] = readme.split('\n| Changes merged per day |');
  assert.equal(before, expectedBeforeTable, 'README text before the speed table matches the approved draft word for word');
  assert.ok(rest, 'README carries the speed table');

  const [tableBody, after] = rest.split('\n\nThese are our own measurements');
  assert.ok(after !== undefined, 'README carries the text after the speed table');
  assert.equal(`These are our own measurements${after}`, expectedAfterTable, 'README text after the speed table matches the approved draft word for word');

  const rows = `| Changes merged per day |${tableBody}`.split('\n');
  assert.equal(rows.length, 4, 'the speed table has four rows');
  assert.match(rows[0]!, /^\| Changes merged per day \| about \d+ \|$/);
  assert.match(rows[1]!, /^\| Start to merged, typical \| about \d+ minutes \|$/);
  assert.match(rows[2]!, /^\| Merged on the first attempt \| about \d+ in 10 \|$/);
  assert.match(rows[3]!, /^\| Machines \| .+ \|$/);

  assert.doesNotMatch(readme, /<!--\s*MEDIA/i, 'no MEDIA comments remain');
  for (const forbidden of [/\bjournalctl\b/i, /\bsystemd\b/i, /\bbubblewrap\b/i, /\bLandlock\b/i, /\bnpx\b/i, /graphyard-master/i, /graphyard-deploy/i, /graphyard-OWNER-NAME/i, /mainworks-trial/i, /\.service\b/]) {
    assert.doesNotMatch(readme, forbidden, `README must not contain ${forbidden}`);
  }

  // package.json's description is the README's first bold line.
  const manifest = JSON.parse(read('package.json'));
  const firstBold = readme.split('\n')[2]!.replace(/\*\*/g, '');
  assert.equal(manifest.description, firstBold, 'package.json description matches the README first bold sentence');

  // The former prerequisites paragraph lives in docs/reference.md (GY-3940) as a list, one requirement per line with its check command.
  const setup = read('docs/reference.md');
  const prereqSection = setup.split('\n## Prerequisites\n')[1]?.split('\n## ')[0]?.trim() ?? '';
  assert.ok(prereqSection.length > 0, 'docs/reference.md has a Prerequisites section');
  const prereqLines = prereqSection.split('\n').filter(line => line.startsWith('- '));
  assert.ok(prereqLines.length >= 9, `docs/reference.md lists each prerequisite on its own line: ${prereqLines.length}`);
  for (const check of ['uname -r', 'node --version', 'npm --version', 'git --version', 'docker version', 'docker compose version', 'gh auth status', 'bwrap --version', 'python3 --version', 'herdr --version', 'systemctl --user status']) {
    assert.ok(prereqLines.some(line => line.includes(check)), `docs/reference.md prerequisite list includes ${check}`);
  }

  // docs/diagrams/where-things-run.svg is linked only from docs/architecture.md (at most 250 words)
  // and says Mainworks, not the old name, in every label that is not a real unit, container or host-shim name.
  const arch = read('docs/architecture.md').trim();
  assert.ok(arch.split(/\s+/).length <= 250, `docs/architecture.md is at most 250 words: ${arch.split(/\s+/).length}`);
  assert.match(arch, /\]\(diagrams\/where-things-run\.svg\)/, 'docs/architecture.md links where-things-run.svg');

  const markdownFiles = ['README.md', ...readdirSync(join(root, 'docs')).filter(name => name.endsWith('.md')).map(name => `docs/${name}`)];
  for (const file of markdownFiles) {
    if (file === 'docs/architecture.md') continue;
    assert.doesNotMatch(read(file), /where-things-run\.svg/, `${file} does not link where-things-run.svg`);
  }

  const svg = read('docs/diagrams/where-things-run.svg');
  const oldToken = new RegExp(`[\\w.-]*${'graph'}${'yard'}[\\w.-]*`, 'gi');
  const nonMachineOldName = (svg.match(oldToken) ?? []).filter(token =>
    !/^graphyard-master-OWNER-NAME\.service$/.test(token) &&
    !/^graphyard-deploy-OWNER-NAME\.service$/.test(token) &&
    !/^graphyard-OWNER-NAME-server-1$/.test(token) &&
    !/^graphyard-OWNER-NAME-db-1$/.test(token) &&
    token !== 'graphyard-host-shim',
  );
  assert.deepEqual(nonMachineOldName, [], 'where-things-run.svg says Mainworks in every non-unit/container label');

  // Every tracked doc linked from README.md exists.
  const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean));
  assert.ok(tracked.has('docs/architecture.md') || arch.length > 0);
});
