// Concern: the loop half of a variable the owner provided on Needs you (runtime-check.ts). The
// browser sealed it to this host's connect key; the loop opens it here, sets it in every
// environment the install's runtime.json declares and records the outcome on the item, which drops
// the ciphertext. The value lives only in this process's memory and the set command's `$VALUE`.
import type { MasterConfig } from '../master.js';
import type { Work } from '../model.js';
import { fleetRequest } from '../fleet.js';
import { installIdFor } from '../install/types.js';
import { installDirectory } from '../install/secrets.js';
import { setVariable, type RunCommand } from '../runtime-check.js';
import { hostKeyPair, unsealToHost } from './connect-accounts.js';

export interface VariableReport { work: string; variable: string; environments: string[]; error: string | null }

/** Sets each provided variable sealed to this host, once; answers what it did. */
export async function applyRuntimeVariables(config: Pick<MasterConfig, 'url' | 'hostId' | 'credentialFile' | 'repository'>, options: { installDirectory?: string; keyFile?: string; fetch?: typeof fetch; run?: RunCommand } = {}): Promise<VariableReport[]> {
  if (!config.url || !config.hostId) return [];
  const { work } = await fleetRequest(config, 'work-snapshot', { fetch: options.fetch }) as { work: Work[] };
  const pending = work.flatMap(item => (item.humanRequests ?? [])
    .filter(request => request.variable && request.sealHost === config.hostId && request.answer?.sealedValue)
    .map(request => ({ item, request })));
  if (!pending.length) return [];
  const { privateKey } = await hostKeyPair(config.credentialFile, options.keyFile);
  const directory = options.installDirectory ?? installDirectory(installIdFor(config.repository));
  const reports: VariableReport[] = [];
  for (const { item, request } of pending) {
    let result: { environments: string[]; error: string | null };
    try { result = await setVariable(directory, request.variable!, unsealToHost(privateKey, request.answer!.sealedValue!), options.run); }
    catch (error) { result = { environments: [], error: error instanceof Error ? error.message.slice(0, 500) : 'the value could not be opened' }; }
    await fleetRequest(config, `work/${item.id}/variable-applied`, { body: { request: request.id, environments: result.environments, ...(result.error ? { error: result.error } : {}) }, fetch: options.fetch, idempotencyKey: `variable-applied:${request.id}` });
    reports.push({ work: item.key, variable: request.variable!, ...result });
  }
  return reports;
}
