// Concern: GY-3768 — delta rows written before GY-3766 carry no stage, so the stage read rebuilt their documents.
// Each loop cycle asks the control plane to store the stage on the next batch of them; the batch that finds none
// left ends the backfill, and the loop asks nothing more until it restarts. A loop that filled rows says it is done.
// GY-3769: 1,000 long-chain rows took past the 60 s statement timeout and saved nothing, so the first batch is 50
// rows and each later one is sized from the last batch's time to take about 1 s (GY-3771: leaves 5x headroom under
// the 5 s test timeout and 3x under the 3 s slow-query threshold). GY-3772: each batch says how many rows are left.
// GY-3774: batches are timed and sized from the UPDATE alone (`updateMs`), never from the remaining-rows count.
// GY-3777: batches target ~3 s (still under the 5 s bound) and ask for a full remaining count only on the first batch.

const firstBatch = 50, targetMs = 3_000, maxBatch = 1_000;

/** One loop process's backfill: `post` fills one batch of at most `limit` rows and answers how many it filled. */
export function eventStageBackfill(post: (limit: number, recount?: boolean) => Promise<{ filled: number; remaining?: number; updateMs?: number }>, now = () => performance.now()) {
  let done = false, first = true, filled = 0, limit = firstBatch;
  return async (log: (line: string) => void) => {
    if (done) return;
    const started = now();
    let batch: number, remaining: number | undefined, updateMs: number | undefined;
    try { ({ filled: batch, remaining, updateMs } = await post(limit, first)); } catch (error) { limit = Math.max(1, Math.floor(limit / 4)); throw error; }
    first = false;
    const ms = Math.max(1, updateMs ?? (now() - started));
    filled += batch;
    if (batch && remaining === 0) {
      // GY-3772: the batch that leaves none ends the backfill, so no empty batch follows it.
      done = true;
      log(`[mainworks-master] the event stage backfill is done: it stored ${batch} rows, 0 left; ${filled} older delta rows now store their stage`);
      return;
    }
    if (batch) {
      log(`[mainworks-master] the event stage backfill stored ${batch} rows in ${(ms / 1000).toFixed(1)} s (${filled} so far, ${(remaining ?? 0).toLocaleString('en-US')} left)`);
      limit = Math.max(1, Math.min(maxBatch, Math.round(limit * targetMs / ms)));
      return;
    }
    done = true;
    if (filled) log(`[mainworks-master] the event stage backfill is done: ${filled} older delta rows now store their stage`);
  };
}
