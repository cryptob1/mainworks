# Reference

The detail the [getting-started guide](setup.md) leaves out.

- `mainworks guide setup` prints every prerequisite check and fix; `mainworks doctor` verifies a host.
- The `graphyard` command and `GRAPHYARD_*` settings still work, from before the rename to Mainworks.

## Prerequisites

- Linux 7.0+ with Landlock ABI 9+ (`uname -r`; Ubuntu 26.04: `sudo apt install linux-image-oem-7.3`)
- Node 24+ and npm (`node --version`, `npm --version`)
- Installing Node 24: Ubuntu/Debian: `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash - && sudo apt install nodejs`, Arch: `sudo pacman -S nodejs npm`, macOS: `brew install node@24`
- Git (`git --version`, `git remote -v`)
- Docker with Compose (`docker version`, `docker compose version`)
- GitHub CLI (`gh auth status`)
- bubblewrap (`bwrap --version`)
- Python 3 (`python3 --version`)
- Herdr (`herdr --version`; install: `curl -fsSL https://herdr.dev/install.sh | sh`)
- systemd user manager (`systemctl --user status`)
- An account for at least one agent: Claude Code, Codex or Gemini

## Who decides what

- You decide goals, money and credentials.
- Tell any agent; reverse relayed answers under Needs you.
- The master handles blockers.

## Host

- Docker and Compose: on an AppArmor host up loads the `mainworks-trial` profile with sudo.
- Merge trials need Docker and Compose even for `--local`.
- Fair sharing: each worker, reviewer and producer session gets equal CPU and disk weight.
- Each session also gets a memory share: host memory in proportion to cores divided by live sessions, never under two cores.
- A lone session may use the whole machine.
- The loop, master, server and database weigh more, so they answer under load.
- `mainworks master status` → `sessionUsage` and Settings → Workers show each session's use beside its share.
- The overload alarm fires only when a session is saturated and over twice its share for five minutes.

## Compute machines

- A compute machine lends Mainworks its CPU and nothing else.
- Merge trials and worker checks send it test shards first, falling back to the coordinator only when none has room.
- Add one with `mainworks host add you@HOST` in a terminal. It asks for that machine's sudo password once.
- It creates the unprivileged `gy-compute` user (no sudo, not in the docker group) with rootless Docker.
- It limits this machine's SSH key there to `graphyard-host-shim`: no shell.
- Running `host add` again is a no-op. Later installs and releases update the helper without sudo.
- When `dockerd-rootless-setuptool.sh` or `slirp4netns` are absent, setup fetches static copies into `gy-compute`'s home. The machine needs `curl`, `python3` and `git`.
- Another install can use a prepared machine without root: run `mainworks host share HOST PUBLIC-KEY` here with its ssh-ed25519 key, then `host add` there.
- `mainworks host unshare HOST PUBLIC-KEY` removes that key.
- No SSH login of your own on the machine: `mainworks host prepare` prints the one-time sudo script to run there, then `mainworks host add gy-compute@HOST`.
- `host add` refuses an unreachable host, one without Docker, a plain-shell key, root or a docker-group user.
- Settings → Workers lists every host with cores, temperature, CPU steal and active runs; an unreachable host shows Away.
- Compute-only port: where port 22 is Tailscale SSH (which ignores keys), setup starts OpenSSH for `gy-compute` on port 2222, key-only and shim-only.
- On such a machine add `gy-compute@HOST:2222` or an alias from `~/.ssh/config`.
- Agent sessions on a host: `mainworks host sessions gy-compute@HOST 2` lets it run up to two worker sessions at once. 0 turns it back to test shards only.
- Claude, Codex, OpenCode and Cursor builders start there first, while it has room and is under its heat limit; this machine runs them only when no host has room.
- The account's login goes over SSH into the container's memory for that one session. It is never written to the host's disk and is gone when the session ends.
- A login the provider refreshed comes back here.
- The remote session's commits and changed files show up in the worktree here as it works.
- Its `mainworks` commands run here, so `complete` submits the commit it made.
- A host that drops ends its session, and the item goes back to the queue.
- `mainworks master status` lists each session's host under `remoteSessions`.
- `host sessions` refuses a host whose helper is older than this release; run `mainworks host add you@HOST` again first.
- Tailnet check rule: Tailscale SSH rules reaching a host must use action `check`, never `accept`. `host add` warns if port 22 lets your account in unattended.
- `mainworks host remove USER@HOST` removes one; `mainworks host list` lists all.
- Add only machines you own: a host can forge its own shard results.
- Tests naming Docker, nested confinement (bwrap, unshare, landlock), npm exec or /var/tmp stay on the coordinator.
- Every other test, database, browser and loopback servers included, runs on compute machines first.
- Dropped shards hand back automatically. `mainworks master status` → `remoteShards` reports each machine.

## Accounts and multi-session capacity

- Workers and reviewers run headless, logged per item (`mainworks guide runtimes`).
- One account can run several sessions at once: `mainworks master registry account set NAME --max-sessions 3 --reason "allow parallel sessions"`.
- That cap is shared across every install on the host.
- A held account shows the provider's own sentence and reset time.
- Where a SAML organization or org policy blocks deploy keys, `--push-auth gh` pushes with your gh login instead of a deploy key.
- Setup invites or revokes viewers and maintainers.
- Sharing one machine across installs: the [shared server guide](shared-server.md).

## Onboarding a project

- Onboarded means main's `graphyard.json` declares `e2e.serve`, serving the real app on `$PORT`.
- Example serve: `{"command":"PORT=${PORT:-3000} npm start","url":"http://127.0.0.1:3000/","readySeconds":60}`.
- It also declares a `featureMap`: name, path or command, and traps, such as `[{"name":"Home","url":"/","traps":[]}]`.
- Every batch check and deploy check runs the feature map.
- A missing serve, missing feature map or placeholder serve shows as a Master fault in `mainworks master status` and Setup.
- The Lead files work to add them.

## Your app's address and live deploys

- Add `"app": { "url": "https://HOST.TAILNET.ts.net:PORT" }` to `graphyard.json` on main, never `127.0.0.1`, `localhost` or `::1`.
- The top bar then shows Open app, and Settings → Delivery shows the live commit and link.
- Work counts a merge as shipped once the live commit contains it.
- For apps deployed elsewhere (e.g. Railway), point `graphyard.json` at its version endpoint, answering a plain SHA or JSON `commit`/`sha`:

```json
{ "app": { "healthUrl": "https://your-app.example.com/version" } }
```

- Or declare several external apps under `delivery.applications` (`id`, `directory`, `versionUrl`).
- Mainworks polls each at most once a minute and never deploys or previews them.
- `mainworks master status` lists each as current, deploying, lagging or failed.

## Delivery feedback and publishing

- Work's **Taste** feed shows recent deliveries with evidence.
- **Looks good** records your call; **Send back** opens a follow-up item and proposed lesson.
- Verified deploys publish `@cryptob1/graphyard` with npm OIDC provenance plus both GHCR images via Actions — no host publish token.
- `mainworks guide publishing` covers owner setup.
