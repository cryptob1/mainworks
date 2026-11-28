import { test, expect } from '@playwright/test';
import { signInDatabase } from '../tests/helpers/sign-in-database';
import { signInProcess } from '../tests/helpers/sign-in-process';

// GY-4072: the owner stays signed in. Only the server, answering, saying the session ended drops it:
// a restart and a 403 keep it, show one line and retry.
test('e2e:dashboard-stays-signed-in-across-restart-and-403 — a restart and a 403 keep the dashboard signed in; an ended session signs it out', async ({ page }) => {
  test.setTimeout(150_000);
  const database = await signInDatabase();
  let http: { url: string; close(): Promise<void> } | null = await signInProcess(database.url);
  const settled = { timeout: 20_000 };
  let refuse = false;
  try {
    // API requests are carried to the restartable control plane; while none listens, the request fails as a down server's would.
    await page.route('**/*', async route => {
      const { pathname, search } = new URL(route.request().url());
      if (refuse && pathname === '/api/work-snapshot') { refuse = false; return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Operator permission required' }) }); }
      if (pathname.startsWith('/api/') && !http) return route.abort('connectionrefused').catch(() => {});
      await route.fetch(pathname.startsWith('/api/') ? { url: http!.url + pathname + search } : {}).then(response => route.fulfill({ response }), () => route.abort('connectionrefused')).catch(() => {});
    });
    const { code } = await (await fetch(http.url + '/api/sign-in-links', { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
    await page.goto('/#sign-in=' + code + '&work');
    const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
    await expect(signOut).toBeVisible(settled);
    const token = await page.evaluate(() => localStorage.getItem('graphyard-token'));
    expect(token).toMatch(/^gyh_/);

    // A restart: the open dashboard says Reconnecting…, keeps its session, and recovers on its own.
    await http.close(); http = null;
    await expect(page.getByText('Reconnecting…')).toBeVisible(settled);
    await expect(signOut).toBeVisible();
    http = await signInProcess(database.url);
    await expect(page.getByText('Reconnecting…')).toBeHidden(settled);
    await expect(signOut).toBeVisible();
    await page.reload();
    await expect(signOut).toBeVisible(settled);
    expect(await page.evaluate(() => localStorage.getItem('graphyard-token'))).toBe(token);

    // A 403 shows its refusal and keeps the session.
    refuse = true;
    await expect(page.getByText('Operator permission required')).toBeVisible(settled);
    await expect(signOut).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('graphyard-token'))).toBe(token);
    await expect(page.getByText('Operator permission required')).toBeHidden(settled);
    await expect(signOut).toBeVisible();

    // Only the server saying the session ended signs the browser out.
    await database.store.pool.query('DELETE FROM human_sign_in_sessions');
    await expect(page.getByText('Your sign-in has ended. Open a new sign-in link.')).toBeVisible(settled);
    await expect(signOut).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('graphyard-token'))).toBeNull();
  } finally { await http?.close(); await database.close(); }
});
