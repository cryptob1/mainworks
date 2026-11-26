// Provider login identity and account-check descriptions.
import { createHash } from 'node:crypto';
import { adapterIdentity } from './runtimes.js';

/** The provider login an account home holds (GY-1573), read through its runtime adapter's identity file (runtimes.ts `adapterIdentity`). */
export const providerIdentity = (kind: string, home: string) => adapterIdentity(kind, home, ids => createHash('sha256').update(ids.join('\0')).digest('hex').slice(0, 32));
