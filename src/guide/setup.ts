import { COMMAND_NAME, PRODUCT_NAME } from '../model/product.js';

export default `${PRODUCT_NAME} runs on a Linux host. Check each prerequisite; \`${COMMAND_NAME} doctor\` (or \`npx @cryptob1/graphyard doctor\`) in the repository's checkout checks credentials, agent logins, confinement, the kernel and services in one pass, and each failed check prints its fix. The \`graphyard\` command and \`GRAPHYARD_*\` settings still work.

- Linux 7.0+ with Landlock ABI 9+ enabled: \`uname -r\` (doctor checks the ABI).
- Node.js 24+ and npm: \`node --version && npm --version\`.
- Git, and a durable checkout with an SSH origin: \`git --version && git rev-parse --show-toplevel && git remote -v\`.
- Docker Engine usable by your user: \`docker version\` — merge trials need it even with \`--local\`.
- Docker Compose plugin: \`docker compose version\`.
- GitHub CLI signed in with repo scope and admin access: \`gh auth status && gh repo view OWNER/NAME --json viewerPermission\`.
- Bubblewrap (worker confinement): \`bwrap --version\`; install it with \`sudo apt install bubblewrap\` or \`sudo pacman -S bubblewrap\`.
- Python 3 (Landlock probe): \`python3 --version\`.
- Herdr: \`herdr --version\` (\`up\` installs it if absent).
- systemd user manager: \`systemctl --user status\`.

Use \`handoff GY-N\` to obtain the workspace and launch command for this machine. Run agents through \`watch GY-N EPOCH -- YOUR_AGENT_COMMAND\`. The supervisor supplies \`MAINWORKS_CLI\`, \`MAINWORKS_URL\`, and worker identity to the child. Inside that session, invoke the CLI as \`node "$MAINWORKS_CLI" status GY-N\` (or other commands). For manual startup, use the CLI path printed by \`init\` or Herdr's handoff command.

Test runs go to compute machines first, with the coordinator as fallback. Add a compute machine with \`${COMMAND_NAME} host add YOU@HOST\` in a terminal.

A project is onboarded only when main's \`graphyard.json\` declares \`e2e.serve\` starting the real application on \$PORT (\`{"command":"PORT=\${PORT:-3000} npm start","url":"http://127.0.0.1:3000/","readySeconds":60}\`) and a nonempty \`featureMap\`. Each feature has a name, a URL path or a command (given TARGET_URL), and traps: known pitfalls, empty when none are known. Example: \`"featureMap": [{"name":"Home","url":"/","traps":[]}]\`. The batch gate and deploy check reach every mapped feature, alongside the project's cases. Until main declares both, Setup shows the project as not onboarded: never a pass and never a human task. The Lead adds the real serve and feature map.

Sign in with \`gh auth login --scopes repo\`. No GitHub App is needed: \`up\` registers the merge writer's deploy key with the gh login, and it alone pushes. Where the organization disallows deploy keys, pipe a fine-grained token (Contents read/write on the one repository) to \`--merge-token-stdin\` instead — or install with \`--push-auth gh\`, which pushes with the gh login itself (\`gh auth token\` answers git at the moment of each push, so no key or token is stored). A SAML organization that refuses the SSH fetch is named by preflight with its exact fix: an https fetch URL with the SSH push URL kept (\`install --apply\` sets both), or \`--push-auth gh\`. To share an install with people, see Team access in \`${COMMAND_NAME} guide infra\`. Preview \`up\`'s checks with \`${COMMAND_NAME} install --repo OWNER/NAME --plan\` (or \`npx @cryptob1/graphyard install --repo OWNER/NAME --plan\`; \`--provider local\` for local mode).

A managed repository can extend the trial image with its own toolchain: commit a \`graphyard.trial.Dockerfile\` whose \`FROM\` names the build arg \`GRAPHYARD_TRIAL_IMAGE\` (the image merge trials run in). The merge writer builds it from the base branch's copy of the file, caches it by the file's digest and the base image, and runs that repository's trials in it. A head that edits the file has its copy built in its own trial — one that does not build is refused — while its checks still run in the base branch's image, unless that copy no longer builds. A repository without the file runs the standard image. A Go service whose merge gate is \`make verify\` extends the image like this:

\`\`\`dockerfile
ARG GRAPHYARD_TRIAL_IMAGE
FROM \${GRAPHYARD_TRIAL_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends curl make \\
 && curl -fsSL https://go.dev/dl/go1.27.linux-amd64.tar.gz | tar -C /usr/local -xzf - \\
 && rm -rf /var/lib/apt/lists/*
ENV PATH=/usr/local/go/bin:$PATH
\`\`\``;
