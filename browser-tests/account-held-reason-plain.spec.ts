import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { withDatabase } from '../tests/helpers/postgres';
import { temporaryDirectory } from '../tests/helpers/temp-dirs';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { checkAccountLive } from '../src/fleet';
import { hostAccountsVariable } from '../src/host-accounts';
import { applyRegistryMutation } from '../src/model-boundary/registry';
import { emptyRegistry, proposedRuntimes } from '../src/model/registry';

// e2e:account-held-reason-plain — GY-3591 AC-2: an account held with the 2026-11-21 Claude probe
// JSON fixture renders on the Accounts page (Settings › Agents) as its plain sentence and
// 'back <day> at <time>', with no '{' or '"api_error'.

const HOST = 'build-host';
const claudeSentence = "You've hit your weekly limit · resets Nov 23, 10pm (UTC)";
const claudeJsonFixture = JSON.stringify({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  duration_ms: 412,
  num_turns: 1,
  api_error: 'usage_limit_reached',
  result: claudeSentence,
  usage: { input_tokens: 0, output_tokens: 0, depth_limit: 0 },
});

async function plane(context: BrowserContext) {
  const store = await withDatabase(`held_reason_${randomUUID().slice(0, 8).replace(/-/g, '')}`);
  await store.init();
  const engine = new Engine(store, 120, 'fixture/shop');
  engine.gitRunner = null;
  const http = server(engine, [
    { id: 'operator', role: 'admin', sessionKind: 'human', token: 'test-human-operator' },
    { id: 'executor', role: 'coordinator', sessionKind: 'ai', token: 'test-executor' },
  ]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await context.route('**/*', async route => {
    const { pathname, search } = new URL(route.request().url());
    await route.fetch(pathname.startsWith('/api/') ? { url: url + pathname + search } : {})
      .then(response => route.fulfill({ response }), () => route.abort('connectionrefused'));
  });
  const close = async () => { await context.unrouteAll(); await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); };
  return { url, close };
}

async function post(url: string, token: string, path: string, body: unknown) {
  const response = await fetch(`${url}/api/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify(body),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function openAccounts(page: Page, url: string) {
  const signIn = await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } });
  expect(signIn.status).toBe(200);
  const { code } = await signIn.json() as { code: string };
  await page.goto(`/#sign-in=${code}`);
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Settings(\s+\d+)?$/ }).click();
  await expect(page.getByRole('heading', { name: 'Agents', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
}

test('e2e:account-held-reason-plain — Accounts page shows held account sentence and back day/time with no raw JSON', async ({ page, context }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  process.env[hostAccountsVariable] = await temporaryDirectory('e2e-held-reason-host');
  const home = await temporaryDirectory('e2e-held-reason-claude');
  const { url, close } = await plane(context);
  try {
    const runtime = structuredClone(proposedRuntimes.find(entry => entry.name === 'claude')!);
    await post(url, 'test-human-operator', 'agent-registry/apply', {
      runtimes: [runtime],
      models: [{ name: 'opus', id: 'claude-opus-5' }],
      accounts: [{ name: 'claude-held', runtime: 'claude', model: 'opus', credential: { host: HOST, home } }],
      roles: [{ name: 'worker', accounts: ['claude-held'], concurrency: 1 }],
      reason: 'GY-3591 e2e fixture',
    });
    const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
      runtimes: [runtime],
      models: [{ name: 'opus', id: 'claude-opus-5' }],
      accounts: [{ name: 'claude-held', runtime: 'claude', model: 'opus', credential: { host: HOST, home } }],
      roles: [{ name: 'worker', accounts: ['claude-held'], concurrency: 1 }],
      reason: 'local probe target',
    }, { actor: 'operator', at: new Date().toISOString() }).registry;
    const quota = await checkAccountLive(registry.accounts[0]!, registry.runtimes[0]!, {
      smoke: async () => ({ ok: false, error: claudeJsonFixture }),
    });
    expect(quota.state).toBe('exhausted');
    expect(quota.resetsAt).toBeTruthy();
    await post(url, 'test-executor', 'agent-registry/observe', {
      host: HOST,
      observations: [{ account: 'claude-held', quota }],
    });

    await openAccounts(page, url);
    const table = page.getByRole('table', { name: 'Accounts at a glance' });
    const row = table.locator('[data-account-row="claude-held"]');
    await expect(row).toBeVisible({ timeout: 15_000 });
    const text = await row.innerText();
    const resetDay = await page.evaluate(iso => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), quota.resetsAt!);
    expect(text).toContain('weekly limit');
    expect(text).toContain(`back ${resetDay} at `);
    expect(text).not.toContain('{');
    expect(text).not.toContain('"api_error');
  } finally {
    await page.close();
    await close();
  }
});
