// Concern: GY-4020 — while the batch gate lands a revert, the merge writer pushes nothing to main, so
// the revert's leased push is never rejected by a merge landing under it. Merge trials still run;
// held pushes resume in the order they waited once the revert lands or the gate abandons it.

interface PendingRevert { culprit: string; since: string; held: string[]; done: Promise<void> }
const pending = new WeakMap<object, PendingRevert>();

/** Runs the gate's revert of `culprit` with merge pushes on `state` held until it settles. */
export async function holdingMergePushes<T>(state: object | undefined, culprit: string, now: () => number, run: () => Promise<T>): Promise<T> {
  if (!state) return run();
  let release = () => {};
  const entry: PendingRevert = { culprit, since: new Date(now()).toISOString(), held: [], done: new Promise<void>(resolve => { release = resolve; }) };
  pending.set(state, entry);
  try { return await run(); }
  finally { if (pending.get(state) === entry) pending.delete(state); release(); }
}

/** Names a push the pending revert holds, once. */
export function notePushHeld(state: object, name: string) {
  const entry = pending.get(state);
  if (entry && !entry.held.includes(name)) entry.held.push(name);
}

/** Waits, naming the push, while the gate has a revert pending on `state`. */
export async function afterGateRevert(state: object, name: string) {
  for (let entry = pending.get(state); entry; entry = pending.get(state)) {
    notePushHeld(state, name);
    await entry.done;
  }
}

/** What status shows while a revert holds pushes: the held pushes and why; null otherwise. */
export function gatePushHold(state: object): { reason: string; held: string[]; since: string } | null {
  const entry = pending.get(state);
  return entry ? { reason: `the batch gate is landing its revert of ${entry.culprit}; merges push to main once it lands or is abandoned`, held: entry.held.slice(0, 100).map(name => name.slice(0, 200)), since: entry.since } : null;
}
