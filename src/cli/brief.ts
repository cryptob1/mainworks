// Concern: `mainworks brief FILE [--install NAME]` (GY-4126) — copy a brief into the install's
// inbox (readable by the Lead and caretaker) and send the Lead one input naming the delivered path.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { defineCommands } from './registry.js';

export const maxBriefBytes = 1024 * 1024;
const briefUsage = 'Use mainworks brief FILE [--install NAME]';

const insideDirectory = (path: string, parent: string) => {
  const from = relative(resolve(parent), resolve(path));
  return from !== '' && from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from);
};

export async function deliverBrief(file: string, options: { install?: string; cwd?: string } = {}) {
  const [
    { configHome, installDirectory, installInboxDirectory, readInstallRecord, readToken },
    { installIdFor },
    { loadStoredMasterConfig },
    { repositoryFromRemote },
    { readCredentialFile },
    { loadConnection },
    { setting },
  ] = await Promise.all([
    import('../install/secrets.js'),
    import('../install/types.js'),
    import('../master/config.js'),
    import('../onboarding.js'),
    import('../private-file.js'),
    import('../repository-setup.js'),
    import('../setting.js'),
  ]);

  const cwd = options.cwd ?? process.cwd();
  const source = resolve(cwd, file);
  const info = await stat(source).catch(() => { throw new Error(`Cannot read ${file}`); });
  if (!info.isFile()) throw new Error(`${file} is not a regular file`);
  if (info.size > maxBriefBytes) throw new Error(`Refusing ${file}: ${info.size} bytes exceeds the 1 MB brief limit`);
  const data = await readFile(source);
  if (data.length > maxBriefBytes) throw new Error(`Refusing ${file}: ${data.length} bytes exceeds the 1 MB brief limit`);

  const home = configHome();
  let directory: string | null = null;
  let masterUrl: string | null = null;
  let masterCredential: string | null = null;
  if (options.install) {
    const candidates = [installDirectory(options.install, home), ...(options.install.includes('/') ? [installDirectory(installIdFor(options.install), home)] : [])]
      .filter(candidate => insideDirectory(candidate, home));
    directory = candidates.find(candidate => existsSync(candidate)) ?? null;
    if (!directory) throw new Error(`No install named ${options.install} under ${home}; check the name and pass --install NAME`);
  } else {
    const master = await loadStoredMasterConfig(cwd).catch(() => null);
    masterUrl = master?.url ?? null;
    masterCredential = master?.credentialFile ?? null;
    let repo: string | null = master?.repository ?? null;
    if (!repo) {
      try { repo = repositoryFromRemote(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
      catch { repo = null; }
    }
    if (repo) {
      const candidate = installDirectory(installIdFor(repo), home);
      if (existsSync(candidate)) directory = candidate;
    }
    if (!directory) {
      const entries = await readdir(home, { withFileTypes: true }).catch(() => []);
      const installs = entries
        .filter(entry => entry.isDirectory() && (existsSync(join(home, entry.name, 'install.json')) || existsSync(join(home, entry.name, 'tokens'))))
        .map(entry => entry.name)
        .sort();
      if (installs.length === 1) directory = join(home, installs[0]!);
      else if (installs.length > 1) throw new Error(`Multiple installs under ${home} (${installs.join(', ')}): pass --install NAME`);
      else throw new Error(`No install found under ${home}: run mainworks install first or pass --install NAME`);
    }
  }

  const record = await readInstallRecord(directory).catch(() => null);
  const connection = !options.install ? await loadConnection(cwd).catch(() => null) : null;
  const url = setting('URL') || record?.url || masterUrl || connection?.url || null;
  if (!url) throw new Error(`No control plane URL found for ${basename(directory)}; set MAINWORKS_URL or run from the install's checkout`);

  let token = setting('TOKEN')?.trim() || null;
  if (!token && setting('TOKEN_FILE')) token = await readCredentialFile(setting('TOKEN_FILE')!);
  if (!token) {
    const admins = record?.principals.filter(principal => principal.role === 'admin') ?? [];
    const operator = admins.find(principal => principal.sessionKind === 'human')?.id ?? admins[0]?.id ?? `${basename(directory)}-operator`;
    token = await readToken(directory, operator).catch(() => null);
  }
  if (!token && masterCredential) token = await readCredentialFile(masterCredential).catch(() => null);
  if (!token) throw new Error(`No operator credential found in ${join(directory, 'tokens')}; set MAINWORKS_TOKEN or run mainworks install`);

  const inbox = installInboxDirectory(directory);
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  const safeName = basename(source).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'brief';
  const deliveredPath = join(inbox, `${Date.now()}-${safeName}`);
  await writeFile(deliveredPath, data, { mode: 0o600 });

  const response = await fetch(`${url.replace(/\/+$/, '')}/api/master/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ text: `Brief delivered to ${deliveredPath}. Read it and act on it.`, source: 'Brief' }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(body?.error ?? `Control plane refused the brief message (${response.status})`);
  return { install: basename(directory), path: deliveredPath, bytes: data.length, message: body.id };
}

export const briefCommands = defineCommands([
  {
    name: 'brief',
    help: ['  brief FILE [--install NAME]  Copy a brief (up to 1 MB) into the install inbox and prompt the Lead'],
    readsConnection: () => false,
    async run({ id, args, print }) {
      const raw = [id, ...args].filter((word): word is string => word !== undefined);
      const parsed = parseArgs({ args: raw, options: { install: { type: 'string' } }, allowPositionals: true });
      const file = parsed.positionals[0];
      if (!file || parsed.positionals.length > 1) throw new Error(briefUsage);
      return print(await deliverBrief(file, { install: parsed.values.install }));
    },
  },
]);
