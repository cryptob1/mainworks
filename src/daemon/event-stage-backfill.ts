// Concern: GY-3768 — delta rows written before GY-3766 carry no stage, so the stage read rebuilt their documents.
// Each loop cycle asks the control plane to store the stage on the next batch of them; the batch that finds none
// left ends the backfill, and the loop asks nothing more until it restarts. A loop that filled rows says it is done.

/** One loop process's backfill: `post` fills one batch and answers how many rows it filled. */
export function eventStageBackfill(post: () => Promise<{ filled: number }>) {
  let done = false, filled = 0;
  return async (log: (line: string) => void) => {
    if (done) return;
    const batch = (await post()).filled;
    filled += batch;
    if (batch) return;
    done = true;
    if (filled) log(`[mainworks-master] the event stage backfill is done: ${filled} older delta rows now store their stage`);
  };
}
