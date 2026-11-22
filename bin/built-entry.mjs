// GY-3611: the CLI and the server start from one built file each, dist/cli.mjs and dist/server.mjs,
// instead of compiling ~550 TypeScript files through tsx on every start. `npm run build` writes them
// (`node bin/built-entry.mjs`); bin/graphyard.mjs and the test helpers run one only while it is at
// least as new as every file under src/, so a checkout never built, or edited since, runs from source.
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const builtEntries = ['cli', 'server'];

/** `<root>/dist/<name>.mjs` when it exists and is at least as new as every file under `<root>/src`, else null. */
export function builtEntry(root, name) {
  const file = join(root, 'dist', `${name}.mjs`);
  let built;
  try {
    const link = lstatSync(file);
    built = link.isSymbolicLink() ? Math.max(link.mtimeMs, statSync(file).mtimeMs) : link.mtimeMs;
  } catch { return null; }
  for (const entry of readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && statSync(join(entry.parentPath, entry.name)).mtimeMs > built) return null;
  }
  return file;
}

/**
 * Bundle src/cli.ts and src/server.ts into dist/. Dependencies stay external. Each module's
 * `import.meta.url` names its own source file, so the paths modules resolve beside themselves
 * (`../../bin/graphyard.mjs`, `./trial-main.ts`) are the same as from source; only an entry keeps the
 * bundle's own URL, so its "run when started directly" check holds.
 */
export async function buildEntries(root) {
  const { build } = await import('esbuild');
  const dist = join(root, 'dist');
  for (const name of builtEntries) {
    const entry = join(root, 'src', `${name}.ts`), outfile = join(dist, `${name}.mjs`);
    const { outputFiles } = await build({
      entryPoints: [entry], outfile, write: false, bundle: true, platform: 'node', format: 'esm',
      target: 'node24', packages: 'external', logLevel: 'warning', absWorkingDir: root,
      banner: { js: `import { pathToFileURL as __bundleUrlOf } from 'node:url'; const __bundleUrl = process.argv[1] && process.argv[1].endsWith('/dist/${name}.mjs') ? __bundleUrlOf(process.argv[1]).href : import.meta.url;` }, define: { 'import.meta.url': '__moduleUrl' },
      plugins: [{
        name: 'source-import-meta-url',
        setup(context) {
          context.onLoad({ filter: /\.(tsx?|m?js)$/ }, async ({ path }) => {
            const url = path === entry ? '__bundleUrl' : `new URL(${JSON.stringify(relative(dist, path).split('\\').join('/'))}, __bundleUrl).href`;
            return { contents: `const __moduleUrl = ${url};\n${await readFile(path, 'utf8')}`, loader: path.endsWith('x') ? 'tsx' : path.endsWith('ts') ? 'ts' : 'js' };
          });
        },
      }],
    });
    // Written beside and renamed over, so a launcher starting meanwhile never loads half a file.
    await mkdir(dist, { recursive: true });
    await writeFile(`${outfile}.${process.pid}.tmp`, outputFiles[0].contents);
    await rename(`${outfile}.${process.pid}.tmp`, outfile);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildEntries(fileURLToPath(new URL('..', import.meta.url)));
