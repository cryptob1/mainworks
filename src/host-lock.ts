import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { link, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Links the lock file into place holding this process's id (and, GY-4030, who holds it), atomically; a lock whose process is gone is taken over. */
export async function takeLock(lock: string, holder = ''): Promise<boolean> {
  await mkdir(dirname(lock), { recursive: true });
  const mine = `${lock}.${process.pid}.${randomUUID()}`;
  await writeFile(mine, `${process.pid} ${holder}`.trim());
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await link(mine, lock); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      try { process.kill(Number(readFileSync(lock, 'utf8').split(' ')[0]), 0); return false; } catch { await rm(lock, { force: true }); } // the holder is gone
    }
    return false;
  } finally { await rm(mine, { force: true }); }
}

/** GY-3718: the host-wide lock every install's image provisioning and old-image removal take, so no image is removed during a build. */
export const imageLock = 'graphyard-local-images';

/** GY-4030: a child process runs under the host locks its parent holds, named in this variable. */
export const heldLocksVariable = 'MAINWORKS_HELD_LOCKS';

/**
 * GY-3710: runs `work` holding the host-wide lock `name` (under /tmp, whatever an install's TMPDIR), waiting while another process or install holds it.
 * GY-4030: the lock names its `holder`; `onWait` hears the current holder once, when this caller starts waiting.
 */
export async function withHostLock<T>(name: string, work: () => Promise<T>, options: { holder?: string; onWait?: (holder: string) => unknown } = {}): Promise<T> {
  if (process.env[heldLocksVariable]?.split(',').includes(name)) return work();
  const lock = join('/tmp', 'mainworks-locks', `${name.replace(/[^\w.-]/g, '_')}.lock`);
  for (let waited = false; !await takeLock(lock, options.holder); await delay(1000)) {
    if (waited) continue;
    waited = true;
    let holder = '';
    try { holder = readFileSync(lock, 'utf8').split(' ').slice(1).join(' '); } catch { /* released meanwhile */ }
    await options.onWait?.(holder || 'another install');
  }
  try { return await work(); } finally { await rm(lock, { force: true }); }
}
