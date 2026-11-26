import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Engine } from '../../src/engine.js';
import type { Principal, Work } from '../../src/model.js';

/** The steps past `ready` that a test names; the walk ends at the last one. */
interface LifecycleSteps {
  /** Who claims the item; without it the item is only filed and released. */
  claim?: Principal;
  /** The claimant takes its assignment through the worker pull (`pullAssignment`) instead of the claim command. */
  pull?: boolean;
  /** What differs from the default workspace: host `machine-a`, path `/tmp/<key>/<id>`, branch `graphyard/<key>-<epoch>`. */
  workspace?: { host?: string; path?: string; branch?: string };
  /** The claimant submits `head`, or pull request `pr` (the item's own number unless given); a submission registers the workspace first, as the control plane demands. */
  submit?: { pr?: number; head?: string };
}

/**
 * Take one fixture item through the lifecycle its test would otherwise walk by hand: `operator` files
 * `input` and releases it, the claimant claims it, registers a workspace and submits. Returns the
 * item as the control plane holds it after the last step named.
 */
export async function lifecycle(engine: Engine, operator: Principal, input: Record<string, unknown>, steps: LifecycleSteps = {}): Promise<Work> {
  const step = (actor: Principal, command: Parameters<Engine['execute']>[1], id: string | null, body: unknown = {}) => engine.execute(actor, command, id, body, randomUUID());
  let item = await step(operator, 'create', null, input);
  item = await step(operator, 'ready', item.id);
  if (!steps.claim) return item;
  if (steps.pull) {
    const pulled = await engine.pullAssignment(steps.claim, { work: item.id }, randomUUID());
    assert.equal(pulled.assigned?.id, item.id, JSON.stringify(pulled.refused));
    item = pulled.assigned!;
  } else item = await step(steps.claim, 'claim', item.id);
  if (steps.workspace || steps.submit) {
    const key = item.key.toLowerCase();
    item = await step(steps.claim, 'workspace', item.id, { epoch: item.epoch, host: 'machine-a', path: `/tmp/${key}/${item.id}`, branch: `graphyard/${key}-${item.epoch}`, ...steps.workspace });
  }
  if (steps.submit) item = await step(steps.claim, 'submit', item.id, { epoch: item.epoch, ...(steps.submit.head ? {} : { pr: Number(item.key.slice(3)) }), ...steps.submit });
  return item;
}
