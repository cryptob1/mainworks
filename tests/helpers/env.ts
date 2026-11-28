// GY-4076: save and restore process.env entries around a test or block.
export function patchEnv(patch: Record<string, string | undefined>, hook?: { after(fn: () => unknown): void }) {
  const saved = Object.entries(patch).map(([key, value]) => {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    return [key, previous] as const;
  });
  const restore = () => { for (const [key, previous] of saved) if (previous === undefined) delete process.env[key]; else process.env[key] = previous; };
  hook?.after(restore);
  return restore;
}

export function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const restore = patchEnv(patch);
  try {
    const result = fn();
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') return (result as unknown as Promise<unknown>).finally(restore) as T;
    restore();
    return result;
  } catch (error) { restore(); throw error; }
}
