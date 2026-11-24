// GY-3733: how long each published-image pull took, so the deploy restart says it in one line and
// master status raises attention when a pull took more than five minutes (its layers were not reused).
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { heavyJobsDirectory } from '../master/verification-slots.js';
import type { Transport } from './transport.js';

export interface ImagePull { image: string; ms: number; at: string }
const slowPullMs = 5 * 60_000;
const pullsFile = () => join(heavyJobsDirectory(), 'image-pulls.json');
const repository = (image: string) => image.replace(/:[^:/]+$/, '');

/** The latest pull of each image repository on this host. */
export function readImagePulls(): ImagePull[] {
  try { return JSON.parse(readFileSync(pullsFile(), 'utf8')) as ImagePull[]; } catch { return []; }
}

/** Pulls the image; a successful pull's duration replaces the last one recorded for its repository. */
export async function timedPull(transport: Pick<Transport, 'exec'>, image: string, now = Date.now): Promise<boolean> {
  const started = now();
  if ((await transport.exec('docker', ['image', 'pull', image], { allowFailure: true, timeout: 1_800_000 })).code !== 0) return false;
  const pull = { image, ms: now() - started, at: new Date(now()).toISOString() };
  // The record only reports; a host that cannot write it still has the image.
  await mkdir(heavyJobsDirectory(), { recursive: true })
    .then(() => writeFile(pullsFile(), `${JSON.stringify([...readImagePulls().filter(entry => repository(entry.image) !== repository(image)), pull])}\n`)).catch(() => {});
  return true;
}

const duration = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

/** One line naming each pull made since `since`; null when none was. */
export function pullLine(pulls: ImagePull[], since: number): string | null {
  const recent = pulls.filter(pull => Date.parse(pull.at) >= since);
  return recent.length ? `Image pulls: ${recent.map(pull => `${repository(pull.image)} took ${duration(pull.ms)}`).join('; ')}` : null;
}

/** One attention line while the latest pull of any image took more than five minutes. */
export function slowPullAttention(pulls: ImagePull[]) {
  const slow = pulls.filter(pull => pull.ms > slowPullMs);
  return slow.length ? [{ subject: 'image pull', text: `${slow.map(pull => `${repository(pull.image)} took ${duration(pull.ms)} to pull`).join('; ')}, over 5 minutes: its layers were not reused.`,
    next: 'Check the publish build reuses its registry cache (graphyard-trial:buildcache); this clears on the next pull under 5 minutes' }] : [];
}
