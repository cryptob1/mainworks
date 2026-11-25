import { z } from 'zod';
import { demand } from '../../model.js';
import { defineRoutes, parseJson, type RouteContext } from '../routes.js';
import { unownedFamilySql } from '../../store/tables/work.js';

/**
 * GY-3850: the install's owner, whose name and email author every commit as 'NAME (Mainworks)'.
 * Each change is one `owner.set` event, so the history is the events; the newest one applies.
 */
type Pool = RouteContext['services']['engine']['store']['pool'];
export interface OwnerSetting { name: string; email: string; by: string; at: string }
const kind = 'owner.set';

async function ownerHistory(pool: Pool, limit = 20): Promise<OwnerSetting[]> {
  const rows = (await pool.query(`SELECT actor, created_at, payload FROM events WHERE ${unownedFamilySql('owner.')} AND kind = $1 ORDER BY seq DESC LIMIT $2`, [kind, limit])).rows;
  return rows.map(row => ({ name: String(row.payload.name), email: String(row.payload.email), by: String(row.actor), at: new Date(row.created_at).toISOString() }));
}
export const checkInOwner = async (pool: Pool): Promise<OwnerSetting | null> => (await ownerHistory(pool, 1))[0] ?? null;

const ownerSchema = z.object({ name: z.string().trim().min(1).max(100).regex(/^[^<>\n\r]+$/, 'A name holds no <, > or line break'), email: z.string().trim().email().max(200) }).strict();

export const ownerRoutes = defineRoutes('owner', [
  { method: 'GET', path: '/api/owner', handle: async context => ({ owner: await checkInOwner(context.services.engine.store.pool), history: await ownerHistory(context.services.engine.store.pool) }) },
  { method: 'POST', path: '/api/owner', handle: async context => {
    demand(context.actor.role === 'admin', 'Only the owner sets who commits are authored by: run mainworks config owner "NAME" EMAIL', 403);
    const owner = ownerSchema.parse(await parseJson(context));
    await context.services.engine.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [context.actor.id, kind, JSON.stringify(owner)]);
    return { owner: await checkInOwner(context.services.engine.store.pool), history: await ownerHistory(context.services.engine.store.pool) };
  } },
]);
