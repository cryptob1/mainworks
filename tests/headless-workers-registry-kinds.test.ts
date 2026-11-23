import { describe } from 'node:test';
import { headlessWorkerKindGroups, registryKinds } from './helpers/headless-workers.js';

// GY-3259: the other half of the headless worker kind matrix — the kinds launched only through an
// agent-registry contract — split from tests/headless-workers.test.ts because one file cannot host
// the whole matrix inside the merge trial's five-minute per-file bound (tests/helpers/bounded-tests.mjs).
// GY-3715: three fixtures run their shares at once, so the file finishes inside 30 seconds.
describe('headless-workers-registry', { concurrency: true }, () => headlessWorkerKindGroups('headless-workers-registry', registryKinds, 3));
