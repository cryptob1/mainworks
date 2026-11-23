// Concern: `mainworks guide TOPIC` — the procedure a launched session loads on demand (GY-2972).
// Each topic's text lives in its own file under src/guide/<topic>.ts so items that edit different
// topics never conflict (GY-3708).
import { COMMAND_NAME, PRODUCT_NAME } from './model/product.js';
import claim from './guide/claim.js';
import sync from './guide/sync.js';
import complete from './guide/complete.js';
import park from './guide/park.js';
import blocked from './guide/blocked.js';
import review from './guide/review.js';
import proof from './guide/proof.js';
import upgrade from './guide/upgrade.js';
import master from './guide/master.js';
import setup from './guide/setup.js';
import infra from './guide/infra.js';
import publishing from './guide/publishing.js';
import runtimes from './guide/runtimes.js';

/**
 * One topic per procedure, in the order the AGENTS.md block lists them: the agent
 * procedures first, then the human-facing topics (setup, publishing, runtimes) the README
 * landing page summarizes.
 */
export const guideTopics = {
  claim,
  sync,
  complete,
  park,
  blocked,
  review,
  proof,
  upgrade,
  master,
  setup,
  infra,
  publishing,
  runtimes,
} as const;

export type GuideTopic = keyof typeof guideTopics;

/** The topics in the order the AGENTS.md block names them. */
export const guideTopicList = Object.keys(guideTopics) as readonly GuideTopic[];

/** What `guide` prints with no topic: the list, and how to read one. */
export const guideList = () => `${PRODUCT_NAME} guide topics: ${guideTopicList.join(', ')}.\nRun \`${COMMAND_NAME} guide TOPIC\` (or \`node $GRAPHYARD_CLI guide TOPIC\`) to print one topic's procedure.`;

/** One topic's procedure; an unknown topic is refused with the list, so a typo is never a silence. */
export function guideText(topic: string): string {
  if (!Object.hasOwn(guideTopics, topic)) throw new Error(`Unknown guide topic: ${topic}. ${guideList()}`);
  return guideTopics[topic as GuideTopic];
}
