// Concern: GY-3881 — whether the commits that moved main after a head's trial touch what the head's
// files import, so a passing trial on the older base still speaks for the new merge.
import { posix } from 'node:path';

/** One git call in the coordinator's checkout: the arguments after `git -C <root>`, the child's stdout. */
export type StaleTrialGit = (args: string[]) => Promise<string>;

const script = /\.(?:[cm]?[jt]sx?)$/;
const specifiers = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
const goImports = /^\s*import\s*\(([\s\S]*?)\)|^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm;

/**
 * The files `files` import at `sha`: a script's relative imports (a `.js` specifier resolving to its
 * `.ts` source as tsc emits it), and for a Go file every `.go` file of its own package (its directory)
 * and of each package of this module it imports.
 */
async function importsOf(git: StaleTrialGit, sha: string, files: readonly string[], tree?: Set<string>): Promise<string[]> {
  const all = tree ?? new Set((await git(['ls-tree', '-r', '--name-only', sha])).split('\n').filter(Boolean));
  const show = (file: string) => git(['show', `${sha}:${file}`]).catch(() => '');
  const goPackage = (directory: string) => [...all].filter(file => file.endsWith('.go') && posix.dirname(file) === directory);
  const module = all.has('go.mod') ? /^module\s+(\S+)/m.exec(await show('go.mod'))?.[1] ?? null : null;
  const found = new Set<string>();
  for (const file of files) {
    if (script.test(file)) {
      for (const [, specifier] of (await show(file)).matchAll(specifiers)) {
        if (!specifier!.startsWith('.')) continue;
        const base = posix.normalize(posix.join(posix.dirname(file), specifier!));
        const hit = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base.replace(/\.mjs$/, '.mts'), `${base}.ts`, `${base}/index.ts`].find(path => all.has(path));
        if (hit) found.add(hit);
      }
    } else if (file.endsWith('.go')) {
      for (const sibling of goPackage(posix.dirname(file))) found.add(sibling);
      if (!module) continue;
      for (const match of (await show(file)).matchAll(goImports)) {
        for (const [, path] of (match[1] ?? `"${match[2]}"`).matchAll(/"([^"]+)"/g)) {
          if (path!.startsWith(`${module}/`)) for (const member of goPackage(path!.slice(module.length + 1))) found.add(member);
        }
      }
    }
  }
  return [...found];
}

/**
 * The first file the commits from `from` to `to` change that `files` are, or import directly or
 * through one level (`importsOf` read on `to`), or null when the move touches none of them.
 */
export async function moveTouches(git: StaleTrialGit, from: string, to: string, files: readonly string[]): Promise<string | null> {
  const moved = (await git(['diff', '--name-only', from, to])).split('\n').filter(Boolean);
  if (!moved.length) return null;
  const tree = new Set((await git(['ls-tree', '-r', '--name-only', to])).split('\n').filter(Boolean));
  const direct = await importsOf(git, to, files, tree);
  const reach = new Set([...files, ...direct, ...await importsOf(git, to, direct, tree)]);
  return moved.find(file => reach.has(file)) ?? null;
}
