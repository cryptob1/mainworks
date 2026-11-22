import { z } from 'zod';
import { demand } from '../../model.js';
import { once } from '../../store/mutations.js';
import { mintCaretakerIdentity } from '../auth.js';
import { Next, defineRoutes, parseJson } from '../routes.js';

/**
 * GY-3593: the caretaker reads everything; it writes only an account's quota mark, an unblock, a
 * new item and its own report. Every other write — release, close, rework, requirements, a human
 * request's answer, a role change, code — is refused here, ahead of the route table.
 */
const permitted = [
  /^POST \/api\/work$/,
  /^POST \/api\/work\/[^/]+\/unblock$/,
  /^POST \/api\/agent-registry\/accounts\/[^/]+\/quota$/,
  /^POST \/api\/caretaker\/reports$/,
];
export const caretakerScope = defineRoutes('caretaker-scope', [{
  method: '*', path: /^\/api\//,
  async handle({ actor, req, url }) {
    if (actor.role !== 'caretaker' || req.method === 'GET') return Next;
    const route = `${req.method} ${url.pathname}`;
    demand(permitted.some(pattern => pattern.test(route)), `The caretaker may only read, correct an account's quota mark, unblock, file an item and save its report; ${route} is none of those`, 403);
    return Next;
  },
}]);

/** The newest caretaker report's lines, or null before the first. */
export async function newestCaretakerReport(db: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }) {
  const row = (await db.query(`SELECT payload, created_at FROM events WHERE kind='caretaker.report' ORDER BY created_at DESC, seq DESC LIMIT 1`)).rows[0];
  if (!row) return null;
  const lines: string[] = row.payload.lines;
  return { at: new Date(row.created_at).toISOString(), lines, needsOwner: lines.filter(line => /^needs the owner:/i.test(line)).map(line => line.replace(/^needs the owner:\s*/i, '')) };
}

// Each line says what kind it is: checked, fixed, filed or needs the owner.
const report = z.object({ lines: z.array(z.string().trim().max(300).regex(/^(checked|fixed|filed|needs the owner):\s*\S/i, 'Start each line with checked:, fixed:, filed: or needs the owner:')).min(1).max(12) }).strict();
export const caretakerRoutes = defineRoutes('caretaker', [
  { method: 'POST', path: '/api/caretaker-identity', handle: async ({ services, actor }) => mintCaretakerIdentity(services, actor) },
  { method: 'POST', path: '/api/caretaker/reports', async handle(context) {
    const { actor, services } = context;
    demand(actor.role === 'caretaker' || actor.role === 'admin', 'Only the caretaker saves a caretaker report', 403);
    const { lines } = report.parse(await parseJson(context, 20_000));
    return services.engine.store.transaction(db => once(db, actor, context.idempotencyKey(), { command: 'caretaker.report', lines }, async () => {
      const row = (await db.query("INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,'caretaker.report',$2) RETURNING seq", [actor.id, JSON.stringify({ lines })])).rows[0];
      return { id: Number(row.seq), saved: lines.length };
    }));
  } },
  { method: 'GET', path: '/api/caretaker/reports', handle: async ({ services }) => ({ report: await newestCaretakerReport(services.engine.store.pool) }) },
]);
