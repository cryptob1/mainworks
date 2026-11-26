import { posix } from 'node:path';

/** Check committed paths, never worktree files that might be untracked or differ from head. */
export async function checkRelativeImports(git: (args: string[]) => Promise<string>, head: string, base: string | null): Promise<void> {
  const changed = await git(base
    ? ['diff', '--name-only', '--diff-filter=AM', '--no-renames', '-z', `${base}...${head}`]
    : ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=AM', '--no-renames', '-r', '--root', '-z', head]);
  const files = changed.split('\0').filter(file => /\.[cm]?[jt]sx?$/.test(file));
  if (!files.length) return;
  const paths = new Set((await git(['ls-tree', '-r', '-z', head])).split('\0').flatMap(entry => {
    const match = /^\d+ blob [a-f0-9]+\t(.*)$/s.exec(entry);
    return match ? [match[1]!] : [];
  }));
  const { preProcessFile } = await import('typescript');
  for (const file of files) {
    const source = await git(['show', `${head}:${file}`]);
    for (const imported of preProcessFile(source, true, true).importedFiles) {
      if (!/^\.{1,2}\//.test(imported.fileName)) continue;
      const target = posix.join(posix.dirname(file), imported.fileName.split(/[?#]/)[0]!);
      // Source imports name the emitted JavaScript; extensionless bundler imports also work.
      const candidates = [target];
      if (/\.jsx?$/.test(target)) candidates.push(target.replace(/\.jsx?$/, '.ts'), target.replace(/\.jsx?$/, '.tsx'), target.replace(/\.jsx?$/, '.d.ts'));
      if (/\.[mc]js$/.test(target)) candidates.push(target.replace(/js$/, 'ts'), target.replace(/\.([mc])js$/, '.d.$1ts'));
      if (!posix.extname(target)) {
        for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json']) {
          candidates.push(`${target}${extension}`, `${target}/index${extension}`);
        }
      }
      if (!candidates.some(candidate => paths.has(candidate))) {
        const line = source.slice(0, imported.pos).split('\n').length;
        throw new Error(`${file}:${line}: relative import '${imported.fileName}' does not resolve to a file in the head; add the missing file or fix the import before complete`);
      }
    }
  }
}
