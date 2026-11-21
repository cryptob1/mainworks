import { z } from 'zod';
import { activeLease, demand, type Principal } from '../model.js';
import { lockedWork } from '../store/locked-read.js';
import { save } from '../store.js';
import { maskSecrets } from '../redaction.js';
import type { Services } from './routes.js';
import { dispatchWorkerVerification } from './worker-verification-queue.js';
import type { WorkerCheckResult } from '../merge-writer/worker-check.js';
import type { WorkerVerificationResult } from '../cli/worker-verification.js';
import type { VerifyRecord } from '../cli/verify.js';

const schema = z.object({ head: z.string().regex(/^[a-f0-9]{40}$/), epoch: z.number().int().positive(),
  mode: z.enum(['verify', 'check']), preserves: z.array(z.string()).max(1000).optional(),
  check: z.string().min(1).max(200).optional() }).strict().refine(input => (input.mode === 'check') === !!input.check, 'A check request names exactly one check');

/** The lease holder requests only its recorded criteria, never arbitrary host commands. */
export async function workerVerification(services: Services, actor: Principal, id: string, body: unknown) {
  const input = schema.parse(body);
  demand(actor.role === 'worker', 'Only an implementation worker may request self-verification', 403);
  const read = () => services.engine.store.transaction(async (db, now) => {
    const work = (await lockedWork(db, [id])).find(work => work.id === id || work.key === id);
    demand(work, 'Work item not found', 404);
    activeLease(work!, actor, input.epoch, now);
    return work!;
  });
  const work = await read();
  const workspace = work.workspaces.find(entry => entry.owner === actor.id && entry.epoch === input.epoch);
  demand(workspace, 'The lease has no assigned worktree', 409);
  // The server's /repo and private filesystem are not Docker host paths.
  const job = { host: workspace!.host, branch: workspace!.branch, work, input, baseBranch: services.engine.baseBranch };
  // GY-3283: a declared check's run is the worker's own feedback, not proof: answered, never recorded.
  if (input.mode === 'check') return dispatchWorkerVerification<WorkerCheckResult>(services, job);
  // GY-3543: a head that already passed under this policy revision is answered from that record, not run again.
  const passed = work.passedVerification;
  if (passed?.head === input.head && passed.policyRevision === work.policyRevision) return passed.result as WorkerVerificationResult;
  const ticket = requested(services, work.id);
  let result: WorkerVerificationResult;
  try { result = await dispatchWorkerVerification(services, job); }
  catch (error) {
    const reason = maskSecrets(error instanceof Error ? error.message : String(error)).slice(0, 8000);
    await services.engine.store.transaction(async (db, now) => {
      const current = (await lockedWork(db, [id])).find(entry => entry.id === work.id);
      if (!current) return;
      activeLease(current, actor, input.epoch, now);
      await save(db, current, actor.id, 'work.self-verification-failed', now, { epoch: input.epoch, head: input.head, mode: input.mode, error: reason });
    }).catch(() => {});
    throw error;
  }
  demand(result.record.head === input.head, 'Verification returned a different head', 409);
  await services.engine.store.transaction(async (db, now) => {
    const current = (await lockedWork(db, [id])).find(entry => entry.id === work.id)!;
    // GY-3543: a result that outlived its assignment is still kept for its head, unless a newer request for the item replaced it.
    let lapsed = false;
    try { activeLease(current, actor, input.epoch, now); } catch (error) { if (latest(services, work.id) !== ticket) throw error; lapsed = true; }
    if (!lapsed) demand(JSON.stringify(current.criteria) === JSON.stringify(work.criteria), 'Criteria changed during verification', 409);
    if (passedRecord(result.record)) current.passedVerification = { head: input.head, policyRevision: work.policyRevision, at: now.toISOString(), result };
    await save(db, current, actor.id, 'work.self-verified', now, { epoch: input.epoch, ...result, ...(lapsed ? { lapsed } : {}) });
  });
  return result;
}

/** Every proof ran and passed, and each one exercised the change. */
const passedRecord = (record: VerifyRecord) => record.ran.length > 0 && record.ran.every(run => run.result === 'pass' && !run.unexercised);
/** The newest verification request per item: a later one replaces an earlier result that outlived its lease. */
const requests = new WeakMap<Services, Map<string, number>>();
let sequence = 0;
function requested(services: Services, id: string) {
  const items = requests.get(services) ?? new Map<string, number>();
  requests.set(services, items);
  items.set(id, ++sequence);
  return sequence;
}
const latest = (services: Services, id: string) => requests.get(services)?.get(id);
