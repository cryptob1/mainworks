import { z } from 'zod';
import { deliveryPolicySchema } from './delivery-policy.js';
import { repositoryPolicySchema } from './repository-policy.js';
import { type RepositoryConfig, repositoryConfigFile } from '../model/documentation.js';
/**
 * The whole committed file: delivery, and the repository's own risk, review and E2E policy
 * (model/repository-policy.ts, GY-1843). A `documentation` policy written before GY-2875 is ignored.
 * `app.healthUrl` (GY-3452) is where an install that deploys elsewhere answers its live commit.
 */
const featureMap = z.array(z.object({
  name: z.string().trim().min(1),
  url: z.string().regex(/^\/(?!\/)/).optional(),
  command: z.string().trim().min(1).optional(),
  traps: z.array(z.string()),
}).strict().refine(feature => !!(feature.url || feature.command), 'A feature needs a URL path or command')).min(1);
/** A deployed environment's name, and a variable's name: letters, digits and _. */
export const runtimeEnvironmentName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
export const variableName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'A variable name is letters, digits and _');
/**
 * What each deployed environment must hold (runtime-check.ts): the platform and the secrets'
 * source in plain words, and per environment the variable names it needs. Names only. The
 * commands that list and set them live in the install's own runtime.json, never here: this file
 * is the candidate's, and a command here would run with the platform login.
 */
const runtime = z.object({
  platform: z.string().trim().min(1).max(100),
  secrets: z.string().trim().min(1).max(500),
  environments: z.record(runtimeEnvironmentName, z.object({ required: z.array(variableName) }).strict())
    .refine(environments => Object.keys(environments).length > 0, 'Name at least one environment'),
}).strict();
export const repositoryConfigSchema = z.object({
  featureMap: featureMap.optional(),
  runtime: runtime.optional(),
  documentation: z.unknown().optional(),
  delivery: deliveryPolicySchema.optional(),
  app: z.object({ healthUrl: z.url().max(500) }).strict().optional(),
  ...repositoryPolicySchema.shape,
}).strict();

/** The policy a committed `graphyard.json` declares; refuses a file that does not parse. */
export function parseRepositoryConfig(text: string): RepositoryConfig {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error: any) { throw new Error(`${repositoryConfigFile} is not JSON: ${error.message}`); }
  return repositoryConfigSchema.parse(value);
}
