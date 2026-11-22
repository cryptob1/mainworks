import { cpuCelsius, heatReading, heatWindowMs, trialHotCelsius } from '../../src/merge-writer/trial-load.js';

/**
 * GY-3610: the wait before each new test file of a coordinator run — while the CPU package reads at
 * or over the trial launcher's heat limit (its own rule: the mean over the window once it holds four
 * samples, else the latest), no new file starts; it resumes once the reading drops. No sensor: no wait.
 */
export function heatGate(read: () => Promise<number | null> = () => cpuCelsius(), options: { pollMs?: number; onHold?: (celsius: number) => void } = {}) {
  const samples: [number, number][] = [];
  return async () => {
    for (let told = false; ;) {
      const at = Date.now(), sample = await read();
      if (sample === null) return;
      while (samples.length && at - samples[0]![0] >= heatWindowMs) samples.shift();
      samples.push([at, sample]);
      const heat = heatReading(samples)!;
      if (heat.celsius < trialHotCelsius) return;
      if (!told) { told = true; options.onHold?.(heat.celsius); }
      await new Promise(done => setTimeout(done, options.pollMs ?? 5_000));
    }
  };
}
