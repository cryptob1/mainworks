import { readFileSync } from 'node:fs';
import { setting } from './setting.js';

const expand = (list: string): number[] => list.trim().split(/[ ,]+/).flatMap(part => {
  if (!/^\d+(-\d+)?$/.test(part)) throw new Error(`Invalid CPU list: ${list}`);
  const [first, last = first] = part.split('-').map(Number) as [number, number?];
  if (last < first) throw new Error(`Invalid CPU range: ${part}`);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
});

/** Host CPU numbers, not the launcher's affinity count: reserve these for another project. */
export function allowedCpus(reserved = setting('RESERVED_CPUS'), online?: string): string | undefined {
  if (!reserved?.trim()) return undefined;
  const excluded = new Set(expand(reserved));
  const allowed = expand(online ?? readFileSync('/sys/devices/system/cpu/online', 'utf8')).filter(cpu => !excluded.has(cpu));
  if (!allowed.length) throw new Error('MAINWORKS_RESERVED_CPUS reserves every online CPU; leave at least one CPU for Mainworks');
  const ranges: string[] = [];
  for (let index = 0; index < allowed.length; index++) {
    const start = allowed[index]!;
    let end = start;
    while (allowed[index + 1] === end + 1) end = allowed[++index]!;
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  }
  return ranges.join(',');
}

/** The `systemd-run` properties naming a scope's CPUs, where the user manager holds the cpuset controller. */
export function reservedCpuProperties(): string[] {
  const cpus = allowedCpus();
  return cpus ? ['-p', `AllowedCPUs=${cpus}`] : [];
}

/**
 * The words before a launched command that keep it, and every process it starts, off the reserved
 * CPUs: `taskset -c`. A user manager that holds only the cpu, memory and pids controllers records
 * a scope's AllowedCPUs without applying it (systemd's user@.service delegates just those), so the
 * affinity is what holds on such a host.
 */
export function reservedCpuPrefix(): string[] {
  const cpus = allowedCpus();
  return cpus ? ['taskset', '-c', cpus] : [];
}
