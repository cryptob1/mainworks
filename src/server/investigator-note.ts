import { z } from 'zod';
import { demand, type Principal } from '../model.js';
import { workIdByRef } from '../store/locked-read.js';
import type { Services } from './routes.js';

const line = z.string().trim().min(1).max(2000);
const noteSchema = z.union([
  z.object({ question: line, head: line, summary: line, evidence: z.array(line).max(50) }).strict(),
  z.object({ question: line, head: line, failure: line }).strict(),
]);

/** GY-3530: append an investigator's answer, or its one failure line, to the item's history. */
export async function recordInvestigatorNote(services: Services, actor: Principal, id: string, body: unknown) {
  const details = noteSchema.parse(body);
  const kind = 'failure' in details ? 'investigator.failed' : 'investigator.answered';
  return services.engine.store.transaction(async (db, now) => {
    const work = (await db.query(`SELECT id, key FROM work_index WHERE id = ${workIdByRef('$1')}`, [id])).rows[0];
    demand(work, 'Work item not found', 404);
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor.id, kind, JSON.stringify({ details, at: now.toISOString() })]);
    return { key: work.key, kind, ...details };
  });
}
