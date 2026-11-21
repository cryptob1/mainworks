# Mainworks

**Run AI coding agents like Claude Code and Codex, ship each goal to production with independent review and proof.**

[![Mainworks walkthrough: goal through review, merge trial, deploy, revert](docs/diagrams/how-graphyard-works.gif)](docs/diagrams/how-graphyard-works.mp4)

## Why Mainworks

- **You decide goals, money, credentials.** Tell any agent; reverse relayed answers under Needs you. Master handles blockers.
- **Every change is proven.** Workers build, agents review, main trials each head.
- **Production stays safe.** Main deploys itself; failures revert automatically.

Prerequisites: Linux 7.0+ with Landlock ABI 9+ (`uname -r`; Ubuntu 26.04: `sudo apt install linux-image-oem-7.3`); Node 24+/npm (`node --version`, `npm --version`; Ubuntu/Debian: `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash - && sudo apt install nodejs`, Arch: `sudo pacman -S nodejs npm`, macOS: `brew install node@24`); Git (`git --version`, `git remote -v`); Docker with Compose (`docker version`, `docker compose version`); GitHub CLI (`gh auth status`); bubblewrap (`bwrap --version`); Python (`python3 --version`); Herdr (`herdr --version`; install: `curl -fsSL https://herdr.dev/install.sh | sh`); systemd (`systemctl --user status`). [Setup guide](docs/setup.md).

## Quick start

```sh
git clone https://github.com/cryptob1/graphyard.git && cd graphyard
npm ci
npm run build
node bin/graphyard.mjs up --repo OWNER/NAME
```

The `graphyard` command and `GRAPHYARD_*` settings still work.

Once published to npm:

```sh
npx @cryptob1/graphyard up --repo OWNER/NAME
```

The Setup link connects worker and reviewer accounts, file goals under **New work item**: title and optional description; the master writes the criteria; **Advanced** takes full detail. `mainworks master status`; `mainworks upgrade --plan` then `mainworks upgrade`; `mainworks doctor` verifies. **Invite** gives a one-time sign-in link for any device.

## Where things run

![Where every Mainworks part runs](docs/diagrams/where-things-run.svg)

`mainworks guide infra` lists every part.

## Learn more

- `mainworks guide setup`, `mainworks guide publishing`, `mainworks guide TOPIC` and `mainworks master guide` print procedures.
- [Shared server](docs/shared-server.md), [Re-render the walkthrough](docs/walkthrough.md), [Contributing](AGENTS.md), [Apache 2.0](LICENSE)
