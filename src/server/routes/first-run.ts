import { z } from 'zod';
import { demand } from '../../model.js';
import { smallIssues, type FirstRunIssue } from '../../model/first-run.js';
import { defineRoutes, parseJson } from '../routes.js';

/**
 * First-run step 3 (GY-3709): the loop posts the repository's open issues (`gh issue list`) while
 * the install has nothing merged; the dashboard reads the three it offers as a first task. Kept in
 * memory beside the engine: the loop posts again within minutes of a restart.
 */
const reported = new WeakMap<object, FirstRunIssue[]>();
const issueSchema = z.object({ number: z.number().int().positive(), title: z.string().min(1).max(500), body: z.string().max(65_536).default(''), labels: z.array(z.string().max(100)).max(50).default([]), url: z.string().url().max(500) });

export const firstRunRoutes = defineRoutes('first-run', [
  { method: 'GET', path: '/api/first-run/issues', handle: async ({ services }) => ({ issues: smallIssues(reported.get(services.engine) ?? []) }) },
  {
    method: 'POST', path: '/api/first-run/issues',
    async handle(context) {
      demand(context.actor.role === 'coordinator' || context.actor.role === 'admin', 'The loop reports open issues', 403);
      const { issues } = z.object({ issues: z.array(issueSchema).max(200) }).parse(await parseJson(context));
      reported.set(context.services.engine, issues);
      const merged = await context.services.engine.store.pool.query(`SELECT 1 FROM work_items WHERE document->>'stage' = 'done' AND COALESCE(document->'delivery'->>'mergedAt', document->'observation'->>'mergedAt') IS NOT NULL LIMIT 1`);
      return { offered: smallIssues(issues).length, wanted: !merged.rowCount };
    },
  },
]);
