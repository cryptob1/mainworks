import type { Cycle } from './cycle.js';

/** GY-3593: one caretaker run every 30 minutes per install, never two at once. */
export const caretakerIntervalMs = 30 * 60_000;
const caretakerKey = 'caretaker';

/** What one caretaker pass came to: skipped (no account, with the reason) or its result line. */
export type CaretakerOutcome = { skipped: string } | { result: string };

/**
 * Starts the install's caretaker run beside the cycle when the last one started 30 minutes ago or
 * more and none is live. `state.caretaker` is what `master status` shows: when it last ran and its
 * result line.
 */
export function caretakerStep(cycle: Pick<Cycle, 'config' | 'state' | 'effects' | 'clock' | 'launcher' | 'now'>) {
  const { config, state, effects, clock, launcher } = cycle;
  const start = effects.caretaker;
  if (!start || config.forPerson || launcher.busy(caretakerKey)) return;
  const last = state.caretaker?.at;
  if (last && clock - Date.parse(last) < caretakerIntervalMs) return;
  const at = new Date(clock).toISOString();
  state.caretaker = { at, result: 'Running' };
  launcher.submit(caretakerKey, [], async () => {
    const outcome = await start().catch((error: unknown): CaretakerOutcome => ({ result: `Failed: ${error instanceof Error ? error.message : String(error)}` }));
    state.caretaker = { at, result: ('skipped' in outcome ? `Skipped: ${outcome.skipped}` : outcome.result).slice(0, 500) };
    await effects.persist(state).catch(() => {});
  });
}
