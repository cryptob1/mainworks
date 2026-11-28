import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { FleetAccount, FleetRuntime } from '../model/registry.js';
import { accountKeyEnvironment, registryHeadlessLaunch } from '../runner/roles.js';

const fingerprint = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;

/** Report only paths and fingerprints; never include credential contents or parser errors. */
export async function accountCheckDiagnostics(account: FleetAccount, runtime: FleetRuntime, modelId: string | null) {
  // This command has no connection to the loop's process environment. A successful local
  // request must not imply that PATH, HOME or provider settings match the supervised loop.
  const lines = ["Warning: this check uses the shell environment, which may differ from the loop's; results may be false."];
  const home = account.credential.home;
  if (!home) return [...lines, 'Credential: no account credential file is configured'];
  const launchAccount = { name: account.name, kind: runtime.launch.kind, home, key: account.credential.key,
    fleet: { runtime: runtime.name, contract: runtime.launch, model: account.model, modelId, session: 'check', reason: 'live account check' } };
  const ownFile = account.credential.key ? resolve(home, account.credential.key.file)
    : runtime.launch.loginFile ? resolve(home, runtime.launch.loginFile) : null;
  let source = ownFile, value: string | null = null;
  let keyEnvironment: Record<string, string> = {};
  let override: string | null = null;
  try {
    keyEnvironment = accountKeyEnvironment(launchAccount);
    value = account.credential.key ? Object.values(keyEnvironment)[0] ?? null
      : ownFile ? await readFile(ownFile, 'utf8') : null;
  } catch { /* The live check reports unreadable credentials. */ }
  if (runtime.launch.kind === 'opencode') {
    const environment = { ...process.env, ...registryHeadlessLaunch(launchAccount).environment, ...keyEnvironment };
    const provider = modelId?.split('/')[0];
    // Provider options override the login and environment key. Apply config files in
    // OpenCode's load order, followed by explicit inline configuration.
    const configHome = environment.XDG_CONFIG_HOME ?? join(environment.HOME ?? homedir(), '.config');
    const files = [join(configHome, 'opencode', 'config.json'), join(configHome, 'opencode', 'opencode.json'), join(configHome, 'opencode', 'opencode.jsonc'),
      ...(environment.OPENCODE_CONFIG ? [environment.OPENCODE_CONFIG] : []), join(home, 'opencode.json'), join(home, 'opencode.jsonc')];
    if (!account.credential.key && value && provider) {
      try { const auth = JSON.parse(value)[provider]; value = auth?.key ?? auth?.access ?? null; } catch { value = null; }
    }
    for (const file of [...files, 'OPENCODE_CONFIG_CONTENT']) {
      let contents: string;
      try { contents = file === 'OPENCODE_CONFIG_CONTENT' ? environment.OPENCODE_CONFIG_CONTENT ?? '{}' : await readFile(file, 'utf8'); }
      catch { continue; }
      try {
        const { parseConfigFileTextToJson } = await import('typescript');
        const parsed = parseConfigFileTextToJson(file, contents);
        if (parsed.error) throw new Error('Unreadable config');
        const key = parsed.config?.provider?.[provider ?? '']?.options?.apiKey;
        if (typeof key !== 'string' || !key) continue;
        const envReference = /^\{env:([^}]+)\}$/.exec(key);
        const fileReference = /^\{file:([^}]+)\}$/.exec(key);
        const referencedFile = fileReference ? (fileReference[1]!.startsWith('~/') ? join(environment.HOME ?? homedir(), fileReference[1]!.slice(2)) : resolve(file === 'OPENCODE_CONFIG_CONTENT' ? home : dirname(file), fileReference[1]!)) : null;
        value = envReference ? environment[envReference[1]!] ?? null
          : referencedFile ? (await readFile(referencedFile, 'utf8')).trim() : key;
        source = referencedFile ?? file;
        override = file;
      } catch {
        lines.push(`Credential: cannot resolve ${file}; inspect its provider key`);
        source = null; value = null;
      }
    }
  }
  if (override && ownFile) lines.push(`Warning: ${override} overrides the account credential in ${ownFile}`);
  lines.push(value && source ? `Credential: ${source} (${fingerprint(value)})` : `Credential: ${source ?? 'runtime login'} could not be resolved`);
  return lines;
}
