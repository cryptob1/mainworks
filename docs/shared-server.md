# A shared Mainworks server on Tailscale

One Linux server runs every Mainworks install you keep. Your devices — and the people you invite — reach exactly those installs, privately, over Tailscale.

## The server

Any Linux host you control: a spare machine or a small cloud server. Sessions are confined with Landlock, so the kernel must be Linux 7.0 or later with Landlock ABI 9 or newer (`uname -r`; `mainworks doctor` checks the ABI and names each fix). Check swap with `swapon --show`; a server with none can be killed mid-build by a memory spike, so add a swap file:

```sh
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

## Several installs on one server

Each repository gets its own install: run `mainworks up --repo OWNER/NAME` once per repository. An install owns its server container and Postgres (`graphyard-OWNER-NAME-server-1`, `graphyard-OWNER-NAME-db-1`), its loop and deploy units (`graphyard-master-OWNER-NAME.service`, `graphyard-deploy-OWNER-NAME.service`), its port and its sign-in. `mainworks guide infra` lists every part.

To keep Mainworks off the cores another project on the server depends on, set `MAINWORKS_RESERVED_CPUS` where its work starts: the loop's unit, and any shell that runs `mainworks watch`. Sessions, merge trials and checks then run on the other cores only, with no limit on how many run. With no setting, placement is unchanged. A drop-in survives `master init` rewriting the unit:

```sh
systemctl --user edit graphyard-master-OWNER-NAME.service
```

```ini
[Service]
Environment=MAINWORKS_RESERVED_CPUS=0-3
```

```sh
systemctl --user restart graphyard-master-OWNER-NAME.service
```

A running session's scope names its CPUs (`systemctl --user show -p AllowedCPUs` on it), and each of its processes says where the kernel lets it run (`Cpus_allowed_list` in `/proc/PID/status`).

## Sharing the machine over Tailscale

Install Tailscale on the server, sign in, rerun `mainworks up`: every install is served on the tailnet with `tailscale serve --bg --http=PORT` — never `tailscale funnel`; nothing is public. To let a person in, press **Invite** in the top bar. The first time it asks once for a Tailscale API key, which the browser seals to this machine; each invite then makes the Tailscale device invite itself (multi-use when it names several people). Until then a machine share link saved earlier (Tailscale admin console: Machines, this machine, Share) is used; Tailscale expires an unused one 30 days after it was made.

## One Herdr, holding only the Master sessions

One shared Herdr runs on the server (`herdr` opens it; its files live under `~/.config/herdr`). Each install's Master session runs there in its own workspace, and Mainworks never closes, pastes into or reclaims another install's pane. Workers and reviewers run headless, no panes: one run per item, logged per attempt (`mainworks guide runtimes`).

## One port per install

The first install serves at `127.0.0.1:4310`, each next one takes the first free port after it, and `up --port N` picks one. On the tailnet an install answers at `http://SERVER:PORT` — that port alone, as plain HTTP, because WireGuard already carries the tailnet encrypted and Mainworks asks for no tailnet HTTPS certificate.

## Signing in and inviting people

Each install has its own sign-in; one signs you in to no other. Sign in with the one-time link `up` prints, or `mainworks login` for a fresh one. Invite someone with **Invite**: a name, a role and how long the link stays valid (1, 7 or 30 days). Invite gives one link on the install's Funnel address that opens once, on any device, with no Tailscale. The dialog lists every teammate, each with Revoke, which ends their session at once. A viewer reads everything; a maintainer also files work and types into the master. `mainworks invite NAME --role viewer|maintainer [--days N]` prints the same link.

## The missing desktop keyring

A server has no desktop keyring, and nothing needs one: `gh` keeps its login in its own files, and each agent account's sign-in lives under that account's home — a cursor account's at `~/.config/cursor/auth.json` — where its confined sessions read it.

## Data kept outside Git

No credential is ever committed. The install record, sign-in credentials (mode 0600), the deploy checkout and the CLI releases live under `~/.config/graphyard/<install>/`; each Master's coordinator credential under `~/.config/graphyard/masters/`; the tailnet facts every install shares under `~/.config/graphyard/machine/`; and the checkout's ignored `.graphyard/` holds its connection and worktrees.

## Moving an install by hand

Run `mainworks install move --to HOST --plan`, or move per install:

1. On the old host, stop the loop and deploy units (`systemctl --user stop graphyard-master-OWNER-NAME.service graphyard-deploy-OWNER-NAME.service`) and the containers (`docker stop graphyard-OWNER-NAME-server-1 graphyard-OWNER-NAME-db-1`).
2. Copy the repository checkout, `~/.config/graphyard/<install>/` and `~/.config/graphyard/masters/` to the new host (`rsync -a` keeps modes).
3. Re-copy the checkout's `.git/worktrees/` entries from the old host after the move — their files hold absolute paths — and run `git worktree repair` in the moved checkout to re-point them.
4. Re-point the checkout's `.graphyard/connection.json` (`cliPath`, `hostId`), re-stamp a copied CLI release with `mainworks upgrade --repair-identity`, then rerun `mainworks up` there; it starts the units and containers and serves the install on the tailnet again.
