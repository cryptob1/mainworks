// Concern: GY-3418 — two caches keyed by content that spare trials work they already did. A miss
// runs exactly as before; nothing here decides a verdict.
// The warm dependency image: the node_modules an `npm ci` installed, committed in the repository's
// git directory by the trial image and the lockfile, so a later trial of another head with the same two
// reuses it read-only instead of installing again. The test-result cache: a test file that passed
// in a trial (a merge trial or the batch gate, never a worker's own run) is not run again while
// its own content, the local sources it imports (transitively), the files it reads as data and the
// dependency key are the same. GY-3639: every trial consults it, whatever else the change touches.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** The dependency key: the image the trial runs in and its lockfile's content. */
export const dependencyKey = (image: string, lockfile: string) => sha(`${image}\0${lockfile}`);

/** Where the committed dependency images live in the cache root (the repository's git directory, never the worktree root a trial must leave empty). */
export const dependencyImagesDirectory = (cacheRoot: string) => resolve(cacheRoot, 'mainworks-dependency-images');
/** How many dependency images stay: a lockfile change commits a new one and the oldest goes. */
const keptDependencyImages = 3;

/** The committed node_modules for `key`, or null when none is committed yet. */
export function warmDependencies(cacheRoot: string, key: string): string | null {
  const modules = join(dependencyImagesDirectory(cacheRoot), key, 'node_modules');
  return existsSync(modules) ? modules : null;
}

/** Commit an installed node_modules under `key` (copied, then renamed into place whole), keeping the newest few. */
export async function commitDependencies(cacheRoot: string, key: string, nodeModules: string): Promise<void> {
  const directory = dependencyImagesDirectory(cacheRoot), target = join(directory, key);
  if (existsSync(target)) return;
  const staging = join(directory, `.staging-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    await cp(nodeModules, join(staging, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    await rename(staging, target).catch(() => {}); // another trial committed the same key first
  } finally { await rm(staging, { recursive: true, force: true }); }
  const entries = await Promise.all((await readdir(directory)).map(async name => ({ name, at: (await stat(join(directory, name))).mtimeMs })));
  // A copy a killed trial left half-staged goes after an hour; of the committed images the newest few stay.
  const stale = entries.filter(entry => entry.name.startsWith('.staging-') && entry.at < Date.now() - 3_600_000);
  const old = entries.filter(entry => !entry.name.startsWith('.')).sort((a, b) => b.at - a.at).slice(keptDependencyImages);
  for (const entry of [...stale, ...old]) await rm(join(directory, entry.name), { recursive: true, force: true });
}

const importPattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const stringPattern = /['"`]([^'"`\n]*)['"`]/g;
const skipped = new Set(['.git', 'node_modules']);

/**
 * Each test file's result key in `worktree`: its content, every local source it imports
 * transitively (relative specifiers, `.js` resolving to `.ts` as tsc emits them), the files it reads
 * as data, the root configuration (package.json, .npmrc, tsconfig) and `dependencies`. Data is a path a string names — relative to the file or to the
 * worktree — in the test or in a helper under the test's own top-level directory: a file's content
 * (a fixture, a doc, an e2e case), and a directory's whole tree where the naming file lists
 * directories. A file no test imports or names is in no key. Contents are read once per call.
 */
export function testResultKeys(worktree: string, files: readonly string[], dependencies: string): Map<string, string> {
  const contents = new Map<string, string | null>(), trees = new Map<string, string>();
  const read = (path: string) => {
    if (!contents.has(path)) { try { contents.set(path, statSync(path).isFile() ? readFileSync(path, 'utf8') : null); } catch { contents.set(path, null); } }
    return contents.get(path)!;
  };
  const resolveImport = (from: string, specifier: string) => {
    const base = resolve(dirname(from), specifier);
    return [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base.replace(/\.mjs$/, '.mts'), `${base}.ts`, join(base, 'index.ts')].find(path => read(path) !== null);
  };
  const tree = (directory: string): string => {
    if (!trees.has(directory)) {
      const hash = createHash('sha256');
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
        if (skipped.has(entry.name)) continue;
        const path = join(directory, entry.name);
        hash.update(`\0${entry.name}\0${entry.isDirectory() ? tree(path) : read(path) ?? ''}`);
      }
      trees.set(directory, hash.digest('hex'));
    }
    return trees.get(directory)!;
  };
  let tops: string[] = [];
  try { tops = readdirSync(worktree).filter(name => name.length > 1 && !skipped.has(name)).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); } catch { /* no worktree: no data */ }
  const pathPattern = new RegExp(`(?<![\\w@.-])((?:\\.{1,2}/)*)((?:${tops.join('|')})(?:/[\\w.@-]+)*)(?![\\w@-])`, 'g');
  /** The data `path`'s text names: `[relative path, content or tree digest]` per file or listed directory. */
  const named = new Map<string, [string, string][]>();
  const data = (path: string, text: string) => {
    if (named.has(path)) return named.get(path)!;
    const lists = /\breaddir(?:Sync)?\b|\bglob\b/.test(text), found: [string, string][] = [], here = dirname(path);
    const add = (target: string | undefined) => {
      if (!target || !relative(worktree, target) || relative(worktree, target).startsWith('..')) return;
      const content = read(target);
      if (content !== null) found.push([relative(worktree, target), content]);
      else if (lists && statSync(target).isDirectory()) found.push([`${relative(worktree, target)}/`, tree(target)]);
    };
    for (const [, string] of text.matchAll(stringPattern)) {
      // A path from the worktree's root or up from the file, anywhere in the string; or the whole string, beside the file.
      for (const [, up, path] of string!.matchAll(pathPattern)) add([...(up ? [resolve(here, up + path)] : []), resolve(worktree, path!)].find(candidate => existsSync(candidate)));
      if (/^[\w@.-]+(?:\/[\w@.-]+)*$/.test(string!) && existsSync(resolve(here, string!))) add(resolve(here, string!));
    }
    named.set(path, found);
    return found;
  };
  // The configuration every test runs under is in every key: a change to it runs them all again.
  const configuration = tops.length ? readdirSync(worktree).filter(name => /^(?:package\.json|\.npmrc|tsconfig[\w.-]*\.json)$/.test(name)).sort().map(name => `\0${name}\0${read(join(worktree, name)) ?? ''}`).join('') : '';
  // GY-3787: each file is parsed and hashed once per call, however many tests reach it.
  const parsed = new Map<string, { digest: string; imports: string[] }>();
  const parse = (path: string) => {
    if (!parsed.has(path)) {
      const text = read(path), found = text === null ? [] : [...text.matchAll(importPattern)].map(match => resolveImport(path, match[1]!));
      parsed.set(path, { digest: sha(text ?? ''), imports: [...new Set(found.filter((target): target is string => !!target && !relative(worktree, target).startsWith('..')))] });
    }
    return parsed.get(path)!;
  };
  const digests = new Map<string, string>();
  const digest = (content: string) => { if (!digests.has(content)) digests.set(content, sha(content)); return digests.get(content)!; };
  const keys = new Map<string, string>();
  for (const file of files) {
    const start = join(worktree, file), seen = new Set<string>([start]), queue = [start], hash = createHash('sha256').update(dependencies).update(configuration);
    const own = `${file.split('/')[0]}/`, reads = new Map<string, string>();
    while (queue.length) {
      const path = queue.shift()!, text = read(path);
      const { digest: content, imports } = parse(path);
      hash.update(`\0${relative(worktree, path)}\0${content}`);
      if (text === null) continue;
      for (const found of imports) if (!seen.has(found)) { seen.add(found); queue.push(found); }
      if (tops.length && (path === start || relative(worktree, path).startsWith(own))) for (const [name, content] of data(path, text)) reads.set(name, content);
    }
    for (const name of [...reads.keys()].sort()) hash.update(`\0data\0${name}\0${digest(reads.get(name)!)}`);
    keys.set(file, hash.digest('hex').slice(0, 40));
  }
  return keys;
}

/** Where passing results live: one directory per UTC day, the last seven read and kept. */
const testResultsDirectory = (cacheRoot: string) => resolve(cacheRoot, 'graphyard-test-results');
const keptDays = 7;
const days = (now: number) => Array.from({ length: keptDays }, (_, index) => new Date(now - index * 86_400_000).toISOString().slice(0, 10));

/** The files whose key passed in a trial within the last seven days. */
export function cachedPasses(cacheRoot: string, keys: ReadonlyMap<string, string>, now = Date.now()): Set<string> {
  const directory = testResultsDirectory(cacheRoot), recent = days(now);
  return new Set([...keys].filter(([, key]) => recent.some(day => existsSync(join(directory, day, key)))).map(([file]) => file));
}

/** Record each passing file's key under today, and drop days older than seven. */
export async function recordPasses(cacheRoot: string, keys: readonly string[], now = Date.now()): Promise<void> {
  if (!keys.length) return;
  const directory = testResultsDirectory(cacheRoot), recent = days(now);
  await mkdir(join(directory, recent[0]!), { recursive: true });
  await Promise.all(keys.map(key => writeFile(join(directory, recent[0]!, key), '')));
  for (const day of await readdir(directory)) if (!recent.includes(day)) await rm(join(directory, day), { recursive: true, force: true });
}
