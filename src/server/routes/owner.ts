import { z } from 'zod';
import { demand } from '../../model.js';
import { defineRoutes, parseJson } from '../routes.js';
import { checkInOwner, ownerHistory, ownerSetKind as kind } from '../../store/check-in-owner.js';

// GY-3850: the install's owner; each change is one `owner.set` event and the newest one applies.
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
