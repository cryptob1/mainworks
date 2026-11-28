import type { Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';
import { openHumanOnly } from '../src/model/human-request';

// The human-decisions specs' browser-only API fixture: no production requests, credentials or writes.
export const request = { id: '5b0c8f4e-7d8a-4f6e-9a55-0c1d2e3f4a5b', kind: 'money-or-accounts', needed: 'A Hetzner Cloud project for the live-install proofs', reason: 'The proofs provision real servers',
  requestedBy: 'worker', epoch: 1, at: '2026-01-01T00:00:00Z',
  choices: [{ id: 'choice-1', label: 'Approve up to €50/month', outcome: 'provided', input: 'none' }, { id: 'choice-2', label: 'Approve with a different cap…', outcome: 'provided', input: 'text' }] };
export const parked = { dependencies: [], scenarioRequirements: [], id: 'parked-work', key: 'GY-7', title: 'Live-install proofs', description: 'Needs an account', type: 'feature', priority: 1,
  stage: 'ready', stageEnteredAt: '2026-01-01T00:00:00Z', ready: true, policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 1, epoch: 1, violations: [], workspaces: [],
  criteria: [{ id: 'AC-1', text: 'Proven live', proofs: ['unit:live'] }], evidence: [], gates: [], lease: null, blocker: `Waiting on a human-only decision (spending money or opening third-party accounts): ${request.needed}`, humanRequest: request, humanRequests: [] };
export const now = '2026-01-01T02:00:00Z';

export async function fixture(page: Page, options: { refuseAnswers?: boolean } = {}) {
  const posted: { path: string; body: any }[] = [];
  let work: any = parked;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    // The link is the credential: the one route reached without a token, and it opens a human session.
    if (path === '/api/sign-in') { if (method === 'POST') posted.push({ path, body: route.request().postDataJSON() }); return route.fulfill({ json: { token: 'browser-human', actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, expiresAt: '2026-01-01T14:00:00Z' } }); }
    if (route.request().headers().authorization !== 'Bearer browser-human') return route.fulfill({ status: 401, json: { error: 'Rejected' } });
    if (method === 'POST') {
      const body = route.request().postDataJSON(); posted.push({ path, body });
      if (options.refuseAnswers) return route.fulfill({ status: 403, json: { error: 'The requesting host key is invalid' } });
      const choice = request.choices.find(entry => entry.id === body.choice)!;
      work = { ...parked, blocker: null, humanRequest: null, humanRequests: [{ ...request, answer: { by: 'operator', at: now, outcome: choice.outcome, text: choice.label, waitedMs: 7_200_000, choice: { id: choice.id, label: choice.label }, note: null } }] };
      return route.fulfill({ json: work });
    }
    if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, humanOnly: openHumanOnly([{ work }], Date.parse(now)), github: true, reviewProviders: ['github'], repository: 'fixture/repository', jobs: [] } });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work: [work], now } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus([work], Date.parse(now), null) });
    return route.fulfill({ json: path.endsWith('/work') ? [work] : [] });
  });
  return posted;
}
