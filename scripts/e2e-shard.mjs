// GY-3874: one shard of the daily e2e catalog on a test machine. The host shim runs it in the trial
// image over the commit's checkout: it reads the case files the shard holds from LIST, runs them as a
// trial runs its bound cases, and writes one JSON line per case to RECORDS for the coordinator.
// Usage: node --import tsx scripts/e2e-shard.mjs LIST RECORDS BUDGET_MS
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDashboardBuilt } from '../src/dashboard-build.ts';
import { runTrialE2eCases } from '../src/merge-writer/e2e-trial.ts';

const [list, records, budget] = process.argv.slice(2);
const proofs = readFileSync(list, 'utf8').split('\n').map(line => line.match(/^e2e\/cases\/(.+)\.json$/)?.[1]).filter(Boolean).map(id => `e2e:${id}`);
const worktree = process.cwd(), mergeSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
writeFileSync(records, '');
// GY-3967: the commit's checkout has no dist/, so the serve would answer with no dashboard and every browser step would time out.
await ensureDashboardBuilt(worktree);
const cases = await runTrialE2eCases({ worktree, mergeSha, proofs, env: { ...process.env }, scratch: mkdtempSync(join(tmpdir(), 'e2e-shard-')),
  budgetMs: Number(budget), holds: async path => existsSync(join(worktree, path)), log: line => console.log(line) });
for (const entry of cases) appendFileSync(records, `${JSON.stringify({ ...entry, screenshot: undefined })}\n`);
process.exit(cases.some(entry => entry.failed > 0 || entry.missing || entry.executed === 0) ? 1 : 0);
