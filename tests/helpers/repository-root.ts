import { setRepositoryPolicy } from '../../src/model-boundary/repository-policy';
import { setProjectDelivery } from '../../src/model-boundary/project-applications';
import { patchEnv } from './env.js';

/**
 * Points this process at another checkout's graphyard.json and returns the restore. The policy and
 * delivery are read once per process, so both are forgotten on the way in and on the way out: a read
 * made while ROOT is in force would otherwise judge every later test in the same worker by ROOT's
 * policy (GY-3989: a later create was refused "has no way to serve a head").
 */
export function pointRepositoryRoot(root: string): () => void {
  const restore = patchEnv({ GRAPHYARD_REPOSITORY_ROOT: root });
  setRepositoryPolicy(null); setProjectDelivery(null);
  return () => { restore(); setRepositoryPolicy(null); setProjectDelivery(null); };
}
