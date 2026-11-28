import { randomUUID } from 'node:crypto';
import { unauthorizedProofs } from '../../model/proof.js';
import { admin, deploySmokeProof, deploySmokeRequired, demand, singleCaseWarnings } from '../../model.js';
import type { Work } from '../../model.js';
import { resolveScenario } from '../../scenarios.js';
import type { Ctx } from './types.js';
import { authorizeOperatorCommand, adoptFollowUpWindow, assertHumanOwner, declareBootstrap, refuseRenewedDeferral } from './shared.js';

export async function open(c: Omit<Ctx, 'work'> & { work?: Work }): Promise<Work> {
  const { engine, db, actor, command, data, all, now } = c;
  let work: Work | undefined;
  if (actor.role === 'operator-agent') {
    authorizeOperatorCommand(actor, command, data, undefined, engine.repository);
  // GY-3215: an invited maintainer files work as themselves; a viewer does not. GY-3344: so does a reporter.
  } else if (actor.team !== 'maintainer' && actor.role !== 'reporter' && actor.role !== 'caretaker') admin(actor);
  const titleKey = data.title.trim().toLowerCase();
  const duplicate = all.find(w => w.stage !== 'done' && w.title.trim().toLowerCase() === titleKey);
  demand(!duplicate, `An open item already has this title: ${duplicate?.key}`, 409);
  demand(data.dependencies.every((dep: string) => all.some(w => w.id === dep)), 'Unknown dependency');
  const rawCriteria = data.criteria.length
    ? data.criteria
    : (data.origin !== undefined && data.origin !== 'planner') || data.faultKey !== undefined
      ? [{ id: 'AC-1', text: `${data.title}: ${data.simplest ?? data.why ?? 'completed and verified'}`.slice(0, 2000), proofs: [] }]
      : [];
  demand(new Set(rawCriteria.map((ac: { id: string }) => ac.id)).size === rawCriteria.length, 'Criterion IDs must be unique');
  const criteria = rawCriteria.length ? declareBootstrap(engine, actor, { ...data, criteria: rawCriteria }, [], 1, now) : [];
  const scenarioRequirements: Work['scenarioRequirements'] = [];
  const proofNames: string[] = [...new Set<string>(rawCriteria.flatMap((ac: { proofs: string[] }) => ac.proofs))];
  for (const proof of proofNames.filter(p => p.startsWith('e2e:'))) {
    // GY-1708: resolveScenario persists a shipped revision (capacity-limit-redispatch) so create
    // pins a shipped scenario without a separate e2e sync. Only Mainworks's own repository install
    // ships them; another managed repository registers its cases with e2e sync (GY-2964).
    // GY-2973: an unregistered scenario pins nothing — the case is the item's own deliverable
    // (the trial refuses a head that lacks e2e/cases/NAME.json and runs the case it adds), and
    // the scenario registers when the merged head is synced, as case sync already does.
    const scenario = await resolveScenario(db, proof.slice(4), { at: now, by: actor.id }, engine.repository);
    if (scenario) scenarioRequirements.push({ proof, revision: scenario.revision, environment: scenario.environment, hash: scenario.hash });
  }
  await assertHumanOwner(engine, db, data.owner);
  const created = now.toISOString();
  const { reason: _reason, ...intent } = data;
  work = { ...intent, criteria, id: randomUUID(), key: '', stage: 'backlog', revision: 0, policyRevision: 1, createdAt: created, updatedAt: created, stageEnteredAt: created,
    ready: false, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements, evidence: [], observation: null, blocker: null, gates: [], violations: [],
    ...(actor.role === 'reporter' ? { reportedBy: actor.id } : {}) };
  // A policy-required post-deployment proof needs an authorized producer as much as a criterion proof does.
  work!.proofGaps = unauthorizedProofs(engine.principals, [...proofNames, ...(deploySmokeRequired(data.policy) ? [deploySmokeProof] : [])], data.producerProofs);
  // GY-2975: the create response and the stored document carry the single-case warning, so the author sees it at once.
  const warnings = singleCaseWarnings(criteria);
  if (warnings.length) work!.warnings = warnings;
  await adoptFollowUpWindow(db, work!);
  const inserted = await db.query('INSERT INTO work_items(id,document) VALUES($1,$2) RETURNING number', [work!.id, JSON.stringify(work)]);
  work!.key = `GY-${inserted.rows[0].number}`;
  all.push(work!);
  refuseRenewedDeferral(work!, all);
  return work!;
}
