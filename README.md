# Mainworks

**Run AI coding agents like Claude Code and Codex, ship each goal to production with independent review and proof.**

![Mainworks](web/public/favicon.svg)
[![Mainworks walkthrough: goal, review, merge trial, deploy, revert](docs/diagrams/how-mainworks-works.gif)](docs/diagrams/how-mainworks-works.mp4)

## Why Mainworks

- **You decide goals, money, credentials.** Tell any agent; reverse relayed answers under Needs you. Master handles blockers.
- **Every change is proven.** Builders write, reviewers check, main trials heads.
- **Production stays safe.** Main deploys itself; failures revert automatically.

Four places: **Home**, **Work**, **Lead**, **Settings**.

Prerequisites: Linux 7.0+ with Landlock ABI 9+ (`uname -r`; Ubuntu 26.04: `linux-image-oem-7.3`); Node 24+/npm (`node --version`, `npm --version`; Ubuntu/Debian: `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash - && sudo apt install nodejs`, Arch: `sudo pacman -S nodejs npm`, macOS: `brew install node@24`); Git (`git --version`, `git remote -v`); Docker with Compose (`docker version`, `docker compose version`); GitHub CLI (`gh auth status`); bubblewrap (`bwrap --version`); Python (`python3 --version`); Herdr (`herdr --version`; install: `curl -fsSL https://herdr.dev/install.sh | sh`); systemd (`systemctl --user status`). [Setup guide](docs/setup.md).

## Quick start

```sh
git clone https://github.com/cryptob1/mainworks.git && cd mainworks
npm ci
npm run build
node bin/graphyard.mjs up --repo OWNER/NAME
```

Settings are `MAINWORKS_*` (`MAINWORKS_URL`). The `graphyard` command and `GRAPHYARD_*` settings still work.

Once published to npm:

```sh
npx @cryptob1/graphyard up --repo OWNER/NAME
```

Setup link connects worker and reviewer accounts; **New work item** takes title and optional description (master writes the criteria; **Advanced** for detail). `mainworks master status`, `mainworks upgrade --plan`, `mainworks upgrade`, `mainworks doctor`. **Invite** prints a link.

## Where things run

![Where every Mainworks part runs](docs/diagrams/where-things-run.svg)

Tests run on compute machines first, coordinator as fallback. `mainworks guide infra` lists parts.

## Learn more

- `mainworks guide setup`, `mainworks guide publishing`, `mainworks guide TOPIC`, `mainworks master guide`.
- [Shared server](docs/shared-server.md), [Re-render the walkthrough](docs/walkthrough.md), [Contributing](AGENTS.md), [Apache 2.0](LICENSE)
