// Concern: GY-3528 — the heavy-job budget and each machine's load in the words the Workers page and master status show.

/** The short name a host target shows: `gy-compute@vish-msi:2222` is vish-msi. */
export const machineName = (name: string) => name.replace(/^.*@/, '').replace(/:\d+$/, '');
/** The budget in one line: `13 heavy-job slots (this machine 4, vish-msi 4, omarchypc 5)`. */
export const budgetLine = (machines: readonly { name: string; local?: boolean; slots: number }[]) =>
  `${machines.reduce((sum, machine) => sum + machine.slots, 0)} heavy-job slots (${machines.map(machine => `${machine.local ? 'this machine' : machineName(machine.name)} ${machine.slots}`).join(', ')})`;
/** One machine's load in one line: `vish-msi: 3 of 24 cores busy, 58°C`, or away. */
export const machineLine = (machine: { name: string; local?: boolean; away: boolean; cores: number | null; busy?: number | null; celsius: number | null }) =>
  `${machine.local ? 'this machine' : machineName(machine.name)}: ${machine.away && !machine.local ? 'away'
    : `${machine.busy == null ? '—' : Math.round(machine.busy)} of ${machine.cores ?? '—'} cores busy${machine.celsius === null ? '' : `, ${Math.round(machine.celsius)}°C`}`}`;
/** GY-3704: a host's last check fallback, shown beside its load: `last check fell back to this machine at 2026-11-22T07:00:00Z: host … dropped a shard: …`. */
export const fallbackLine = (fallback: { reason: string; at: string }) => `last check fell back to this machine at ${fallback.at}: ${fallback.reason}`;
