// Durable executor bookkeeping. Work leases, verdicts and evidence remain owned by their domain APIs.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { atomicPrivateWrite, readCredentialFile } from './private-file.js';
import type { MasterConfig } from './master/profiles.js';
import { stateDirectory } from './install/layout.js';
import { Refusal } from './model/refusal.js';

export type LoopStateKind = 'reviews' | 'producers' | 'dispatch';
export interface LoopStateClient {
  read(kind: LoopStateKind): Promise<Record<string, unknown>[]>;
  write(kind: LoopStateKind, records: Record<string, unknown>[], removed?: string[], migrate?: boolean): Promise<void>;
}
/** Embedded executors and fixtures can supply the same store without an HTTP hop. */
export const loopStateContext = new AsyncLocalStorage<(scope: string) => LoopStateClient>();
type Config = Pick<MasterConfig, 'url' | 'credentialFile' | 'repository' | 'hostId' | 'loopStateScope'>;
export const scopeOf = (config: Config) => config.loopStateScope ?? createHash('sha256').update(`${config.repository.toLowerCase()}\n${config.hostId ?? hostname()}\n${config.credentialFile}`).digest('hex');
/** Pin the legacy scope before a host or credential path can change. Preserve the stored settings. */
export async function persistLoopStateScope<T extends Config>(file: string, config: T): Promise<T> {
  if (!config.loopStateScope) {
    config.loopStateScope = scopeOf(config);
    await atomicPrivateWrite(file, config);
  }
  return config;
}
/** A conflicted write is retried this many times in all, backing off 250 ms more each time (about 10 s overall). */
const loopStateWriteAttempts = 9;
export async function loopStateClient(rootOrConfig: string | Config): Promise<LoopStateClient> {
  const injected = loopStateContext.getStore();
  if (injected) return injected(typeof rootOrConfig === 'string' ? resolve(rootOrConfig) : scopeOf(rootOrConfig));
  const config: Config = typeof rootOrConfig === 'string'
    ? JSON.parse(await readFile(resolve(stateDirectory(rootOrConfig), 'master.json'), 'utf8')) : rootOrConfig;
  const scope = scopeOf(config);
  const request = async (kind: LoopStateKind, body?: unknown, attempt = 1): Promise<any> => {
    const response = await fetch(`${config.url}/api/loop-state/${scope}/${kind}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${await readCredentialFile(config.credentialFile)}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 409) {
      const refused = await response.json().catch(() => ({}));
      // GY-3366: a write that lost a race to another writer of the same record is retried, so it lands after the winner.
      if (refused.code === 'loop-state-conflict' && attempt < loopStateWriteAttempts) {
        await new Promise(resolve => setTimeout(resolve, 250 * attempt));
        return request(kind, body, attempt + 1);
      }
      // GY-3990: a stale revision or a taken review reservation is the caller's to settle.
      throw new Refusal(`Loop state ${kind}: ${refused.error ?? 'conflict'}`, 409, refused);
    }
    if (!response.ok) throw new Error(`Loop state ${kind}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  return { read: kind => request(kind), write: async (kind, records, removed = [], migrate = false) => { await request(kind, { records, removed, migrate }); } };
}

/** Import before unlinking. Repeating after a crash never replaces a newer database record. */
export async function migrateLoopFile(client: LoopStateClient, kind: LoopStateKind, file: string, parse: (value: unknown) => Record<string, unknown>[]) {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
  await client.write(kind, parse(JSON.parse(raw)), [], true);
  await unlink(file).catch((error: any) => { if (error.code !== 'ENOENT') throw error; });
}

// Carry the read snapshot through object spreads, but never serialize it. Saves send only changes,
// so a reconcile pass cannot overwrite an unrelated launch made while it waited on a runtime.
const baseline = Symbol('loop-state baseline');
type RecordWithId = { id: string };
export function ledgerSnapshot<T extends object>(ledger: T, records: RecordWithId[]): T {
  return Object.assign(ledger, { [baseline]: new Map(records.map(record => [record.id, JSON.stringify(record)])) });
}
export async function saveLedger(client: LoopStateClient, kind: LoopStateKind, ledger: object, records: RecordWithId[]) {
  const before: Map<string, string> = (ledger as any)[baseline] ?? new Map();
  const ids = new Set(records.map(record => record.id));
  const changed = records.filter(record => before.get(record.id) !== JSON.stringify(record));
  const removed = [...before.keys()].filter(id => !ids.has(id));
  if (changed.length || removed.length) await client.write(kind, changed, removed);
}
/**
 * GY-3990: onto a fresher read, reapply only the fields this copy changed since its own read —
 * never its stale whole records. Returns the fresh ledger, carrying the fresh read's baseline.
 */
export function reapplyChanges<T extends RecordWithId, L extends { reviews: T[] }>(mine: L, fresh: L): L {
  const before: Map<string, string> = (mine as any)[baseline] ?? new Map();
  const ours = new Map(mine.reviews.map(record => [record.id, record]));
  const changed = (record: T, base: Record<string, unknown> | undefined) => {
    if (!base) { const { revision: _revision, ...rest } = record as any; return rest; }
    const keys = new Set([...Object.keys(base), ...Object.keys(record)]);
    return Object.fromEntries([...keys].filter(key => key !== 'revision' && JSON.stringify((record as any)[key]) !== JSON.stringify(base[key])).map(key => [key, (record as any)[key]]));
  };
  const merged = fresh.reviews.flatMap(record => {
    const own = ours.get(record.id), base = before.has(record.id) ? JSON.parse(before.get(record.id)!) : undefined;
    if (!own) return base ? [] : [record];
    const result: any = { ...record, ...changed(own, base) };
    for (const key of Object.keys(result)) if (result[key] === undefined) delete result[key];
    return [result as T];
  });
  const known = new Set(fresh.reviews.map(record => record.id));
  fresh.reviews = [...merged, ...mine.reviews.filter(record => !known.has(record.id) && !before.has(record.id))];
  return fresh;
}
