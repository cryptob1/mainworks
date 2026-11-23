// Concern: GY-3528 — the heavy-job budget and each machine's load in the words the Workers page and master status show.

/** The short name a host target shows: `gy-compute@vish-msi:2222` is vish-msi. */
export const machineName = (name: string) => name.replace(/^.*@/, '').replace(/:\d+$/, '');
/** The budget in one line: `13 heavy-job slots (this machine 4, vish-msi 4, omarchypc 5)`. */
export const budgetLine = (machines: readonly { name: string; local?: boolean; slots: number }[]) =>
  `${machines.reduce((sum, machine) => sum + machine.slots, 0)} heavy-job slots (${machines.map(machine => `${machine.local ? 'this machine' : machineName(machine.name)} ${machine.slots}`).join(', ')})`;
/** One machine's load in one line: `vish-msi: 3 of 24 cores busy, 2 shards, 58°C` (shards for a compute host, GY-3706), or away. */
export const machineLine = (machine: { name: string; local?: boolean; away: boolean; cores: number | null; busy?: number | null; celsius: number | null; shards?: number }) =>
  `${machine.local ? 'this machine' : machineName(machine.name)}: ${machine.away && !machine.local ? 'away'
    : `${machine.busy == null ? '—' : Math.round(machine.busy)} of ${machine.cores ?? '—'} cores busy${machine.shards === undefined ? '' : `, ${machine.shards} shard${machine.shards === 1 ? '' : 's'}`}${machine.celsius === null ? '' : `, ${Math.round(machine.celsius)}°C`}`}`;
