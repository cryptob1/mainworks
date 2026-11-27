import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { link, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setting } from './setting.js';

/** Links the lock file into place holding this process's id, atomically; a lock whose process is gone is taken over. */
export async function takeLock(lock: string): Promise<boolean> {
  await mkdir(dirname(lock), { recursive: true });
  const mine = `${lock}.${process.pid}.${randomUUID()}`;
  await writeFile(mine, String(process.pid));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await link(mine, lock); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      try { process.kill(Number(readFileSync(lock, 'utf8')), 0); return false; } catch { await rm(lock, { force: true }); } // the holder is gone
    }
    return false;
  } finally { await rm(mine, { force: true }); }
}

/** GY-3718: the host-wide lock every install's image provisioning and old-image removal take, so no image is removed during a build. */
export const imageLock = 'graphyard-local-images';

/**
 * GY-3710: runs `work` holding the host-wide lock `name` (under /tmp, whatever an install's TMPDIR), waiting while another process or install holds it.
 * GY-4040: MAINWORKS_LOCK_ROOT moves the lock directory, so a test never waits on or holds the lock real deploys take.
 */
export async function withHostLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  const lock = join(setting('LOCK_ROOT') ?? '/tmp/mainworks-locks', `${name.replace(/[^\w.-]/g, '_')}.lock`);
  while (!await takeLock(lock)) await delay(1000);
  try { return await work(); } finally { await rm(lock, { force: true }); }
}
