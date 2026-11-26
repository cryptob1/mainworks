import { unownedFamilySql } from './tables/work.js';

/**
 * GY-3850: the install's owner, whose name and email author every commit as 'NAME (Mainworks)'.
 * Each change is one `owner.set` event, so the history is the events; the newest one applies.
 */
export interface OwnerSetting { name: string; email: string; by: string; at: string }
export const ownerSetKind = 'owner.set';
type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

export async function ownerHistory(db: Queryable, limit = 20): Promise<OwnerSetting[]> {
  const rows = (await db.query(`SELECT actor, created_at, payload FROM events WHERE ${unownedFamilySql('owner.')} AND kind = $1 ORDER BY seq DESC LIMIT $2`, [ownerSetKind, limit])).rows;
  return rows.map(row => ({ name: String(row.payload.name), email: String(row.payload.email), by: String(row.actor), at: new Date(row.created_at).toISOString() }));
}
export const checkInOwner = async (db: Queryable): Promise<OwnerSetting | null> => (await ownerHistory(db, 1))[0] ?? null;
