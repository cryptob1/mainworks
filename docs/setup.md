# Setup guide

The details the [README](../README.md) leaves out. `mainworks guide setup` prints every prerequisite check and fix; `mainworks doctor` verifies a host. The `graphyard` command and `GRAPHYARD_*` settings still work.

## First run

1. **Connect.** Run `node bin/graphyard.mjs up --repo OWNER/NAME` and open the Setup link it prints.
2. **Confirm your Builder.** Connect an AI coding account for building and one for reviewing (it may be the same account) until both turn green.
3. **Ship one small change.** File a small goal from Home or Work; the Lead writes checkable criteria and dispatches a Builder.
4. **Watch it merge.** Open the Task page to inspect the diff, checks and live session as the merge trial runs and lands on main.

## Host

- Docker and Compose: on an AppArmor host up loads the `graphyard-trial` profile with sudo. Merge trials need Docker and Compose even for `--local`.
- Fair sharing: each worker, reviewer and producer session gets equal CPU and disk weight and a memory share (host memory in proportion to cores divided by live sessions, never under two cores). A lone session may use the whole machine. The loop, master, server and database weigh more so they answer under load. `mainworks master status` → `sessionUsage` and Settings → Workers show use beside share; the overload alarm fires only when saturated and over twice its share for five minutes.

## Compute machines

- A compute machine lends Mainworks its CPU and nothing else: merge trials and worker checks send it test shards first, falling back to the coordinator only when none has room. Run `mainworks host prepare` on the coordinator and run the printed script once on the compute machine with sudo: it creates the unprivileged `gy-compute` user (no sudo, not in the docker group) with rootless Docker, and limits this machine's SSH key to `graphyard-host-shim` (no shell). When `dockerd-rootless-setuptool.sh` or `slirp4netns` are absent, the script fetches static copies into `gy-compute`'s home. It needs `curl`, `python3` and `git`.
- `mainworks host add gy-compute@HOST` refuses an unreachable host, one without Docker, a plain-shell key, root or a docker-group user. Settings → Workers lists every host with cores, temperature, CPU steal and active runs; an unreachable host shows Away.
- Compute-only port: where port 22 is Tailscale SSH (which ignores keys), the script starts OpenSSH for `gy-compute` on port 2222 (key-only, shim-only). Add `gy-compute@HOST:2222` or an alias from `~/.ssh/config`.
- Tailnet check rule: Tailscale SSH rules reaching a host must use action `check`, never `accept`. `host add` warns if port 22 lets your account in unattended.
- `mainworks host remove USER@HOST` removes one; `mainworks host list` lists all. Add only machines you own (a host can forge its own shard results).
- Tests naming Docker, nested confinement (bwrap, unshare, landlock), npm exec or /var/tmp stay on the coordinator. Every other test — database, browser and loopback servers included — runs on compute machines first. Dropped shards hand back automatically. `mainworks master status` → `remoteShards` reports each machine.

## Accounts and multi-session capacity

- Workers and reviewers run headless, logged per item (`mainworks guide runtimes`).
- One account can run several sessions at once: set its cap with `mainworks master registry account set NAME --max-sessions 3 --reason "allow parallel sessions"` (shared across every install on the host). A held account shows the provider's own sentence and reset time.
- Where a SAML organization or org policy blocks deploy keys, `--push-auth gh` pushes with your gh login instead of a deploy key.
- Setup invites or revokes viewers and maintainers.
- Sharing one machine across installs: the [shared server guide](shared-server.md).

## Onboarding a project

- A project is onboarded when main's `graphyard.json` declares `e2e.serve` (starting the real app) and a `featureMap` (name, URL path or command, and traps: `"featureMap": [{"name":"Home","url":"/","traps":[]}]`).
- Every batch check and deploy check runs the feature map. A missing serve, missing feature map or placeholder serve shows as a Master fault in `mainworks master status` and Setup; the Lead files work to add them.

## Your app's address and live deploys

- Add `"app": { "url": "https://HOST.TAILNET.ts.net:PORT" }` to `graphyard.json` on main (never `127.0.0.1`, `localhost` or `::1`). The top bar shows Open app and Settings → Delivery shows the live commit and link.
- Work counts a merge as shipped once the live commit contains it. For apps deployed elsewhere (e.g. Railway), point `graphyard.json` at its version endpoint (plain SHA, or JSON `commit`/`sha`):

```json
{ "app": { "healthUrl": "https://your-app.example.com/version" } }
```

Or declare multiple external apps under `delivery.applications` (`id`, `directory`, `versionUrl`). Mainworks polls at most once a minute and never deploys or previews them; `mainworks master status` lists each as current, deploying, lagging or failed.

## Delivery feedback and publishing

- Work's **Taste** feed shows recent deliveries with evidence: **Looks good** records your call; **Send back** opens a follow-up item and proposed lesson.
- Verified deploys publish `@cryptob1/graphyard` with npm OIDC provenance plus both GHCR images via Actions — no host publish token. `mainworks guide publishing` covers owner setup.

## Prerequisite details

- Ubuntu 26.04 kernel: `sudo apt install linux-image-oem-7.3`.
- Check each tool: `git --version`, `git remote -v`, `docker version`, `docker compose version`, `gh auth status`, `bwrap --version`, `python3 --version`, `herdr --version`, `systemctl --user status`.
- Install Herdr: `curl -fsSL https://herdr.dev/install.sh | sh`.
