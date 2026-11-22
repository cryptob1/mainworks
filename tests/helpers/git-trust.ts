// GY-3649: a remote shard's container runs as a user that does not own the run's checkout, and the
// host shim trusts that checkout to the container only through GIT_CONFIG_* environment
// (src/host-shim.ts). A CLI child whose environment a test otherwise replaces — the reporter's
// plain directory, holding only a URL and a token file — keeps that trust, or the CLI cannot read
// its own release there and its release-skew guard refuses every command.
export const hostGitTrust = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([name]) => /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(name)));
