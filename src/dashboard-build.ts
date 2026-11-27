import { existsSync, mkdirSync, statSync } from 'node:fs';
import { cp, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const defaultBuildDashboard = (cwd: string) => async (outDir: string) => {
  const { build } = await import('vite');
  await build({ configFile: join(cwd, 'vite.config.ts'), configLoader: 'runner', root: join(cwd, 'web'), cacheDir: join(cwd, '.graphyard', 'vite'), logLevel: 'warn', build: { outDir, emptyOutDir: true } });
};

/**
 * Ensures `<cwd>/dist/index.html` exists without wiping sibling files (`dist/cli.mjs`, `dist/server.mjs`)
 * or racing another remote shard sharing the same checkout (GY-3656). Serializes behind a lock directory,
 * builds into a private staging directory, copies assets into `dist/`, and renames `index.html` last.
 */
export async function ensureDashboardBuilt(
  cwd: string,
  build: (outDir: string) => Promise<void> = defaultBuildDashboard(cwd),
  options: { staleMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const dist = join(cwd, 'dist'), index = join(dist, 'index.html');
  if (existsSync(index)) return false;
  const lock = join(cwd, '.graphyard', 'dist-dashboard.lock');
  const staleMs = options.staleMs ?? 120_000, pollMs = options.pollMs ?? 100;
  mkdirSync(dirname(lock), { recursive: true });
  for (;;) {
    if (existsSync(index)) return false;
    try { mkdirSync(lock); break; } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > staleMs) { await rm(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }
  const staging = join(cwd, '.graphyard', `dist-dashboard-${process.pid}-${Date.now()}`);
  try {
    if (existsSync(index)) return false;
    await build(staging);
    mkdirSync(dist, { recursive: true });
    for (const name of await readdir(staging)) {
      if (name === 'index.html') continue;
      await cp(join(staging, name), join(dist, name), { recursive: true, force: true });
    }
    await rename(join(staging, 'index.html'), index);
    return true;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
