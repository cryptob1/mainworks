import { test, expect } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';
import { openHumanOnly } from '../src/model/human-request';
import { fixture, now, parked, request } from './human-decisions-fixture';

// GY-738: the operator opens the one-time sign-in link, lands in a human session without a token,
// and answers a money request with one click, at desktop width and at 375 px.
for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
  test(`the operator signs in from the link and answers a money request with one click at ${viewport.width} px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const posted = await fixture(page);
    await page.goto('/#sign-in=one-time-code-from-mainworks-login&work');
    // Signed in without typing a token; the code leaves the address bar at once.
    await expect(page.getByRole('button', { name: 'Every request and answer →' })).toBeVisible();
    expect(posted[0]).toEqual({ path: '/api/sign-in', body: { code: 'one-time-code-from-mainworks-login' } });
    expect(new URL(page.url()).hash).toBe('');
    // GY-2171: the human session lasts until 90 days unused, so it is kept beyond this browser session.
    expect(await page.evaluate(() => localStorage.getItem('graphyard-token'))).toBe('browser-human');

    await page.getByRole('button', { name: 'Every request and answer →' }).click();
    await expect(page.getByText('Signed in as')).toContainText('operator · human operator');
    const card = page.locator('.human-request');
    await expect(card.getByRole('button', { name: 'Decline this request' })).toBeVisible();
    await expect(card.getByText('mainworks answer', { exact: false })).toBeHidden();
    // One click is the whole answer.
    await card.getByRole('button', { name: 'Approve up to €50/month' }).click();
    await expect(page.getByRole('region', { name: 'Recently answered' })).toContainText('Approve up to €50/month');
    expect(posted.at(-1)).toEqual({ path: '/api/work/parked-work/answer', body: { request: request.id, choice: 'choice-1' } });
    await expect(page.locator('.human-request')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  });
}

test('integration:sign-in-screen-command the sign-in screen names the one command, mainworks open, that signs the operator in', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 401, json: { error: 'Rejected' } }));
  await page.goto('/');
  // GY-3989: the command waits behind "How do I get a token?", out of the first screen.
  const fold = page.locator('.login-help', { hasText: 'How do I get a token?' });
  await expect(fold.locator('code')).toBeHidden();
  await fold.getByText('How do I get a token?').click();
  await expect(fold.locator('p')).toHaveText('On the computer running Mainworks, run mainworks open to sign in there, or mainworks login to print a link to open on another device.');
  await expect(fold.locator('code')).toHaveText('mainworks open');
});

test('the local viewer sees the dashboard without a login wall and is offered Sign in for a human-only decision', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') return route.fulfill({ status: 401, json: { error: 'A valid Mainworks bearer token is required' } });
    if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'local-viewer', role: 'reader', displayName: 'Local viewer' }, humanOnly: openHumanOnly([{ work: parked as never }], Date.parse(now)), repository: 'fixture/repository', jobs: [] } });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work: [parked], now } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus([parked as never], Date.parse(now), null) });
    return route.fulfill({ json: path.endsWith('/work') ? [parked] : [] });
  });
  await page.goto('/#work');
  await expect(page.getByRole('button', { name: 'Every request and answer →' })).toBeVisible();
  await expect(page.getByLabel('Access token')).toHaveCount(0);
  await page.getByRole('button', { name: 'Every request and answer →' }).click();
  await page.locator('.human-request').getByRole('button', { name: 'Sign in as the operator' }).click();
  await expect(page.getByLabel('Access token')).toBeVisible();
});

test('a refused answer keeps everything the operator typed: the card clears only after the answer succeeds', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const posted = await fixture(page, { refuseAnswers: true });
  await page.goto('/#sign-in=one-time-code-from-mainworks-login&work');
  await page.getByRole('button', { name: 'Every request and answer →' }).click();
  const card = page.locator('.human-request');
  // The choice that asks for words: typed, submitted, refused.
  const note = card.getByRole('textbox', { name: 'Note for GY-7' });
  await note.fill('Cap it at €30 and bill the staging project');
  await card.getByRole('button', { name: 'Approve with a different cap…' }).click();
  await expect(page.getByRole('alert')).toContainText('The requesting host key is invalid');
  expect(posted.at(-1)).toEqual({ path: '/api/work/parked-work/answer', body: { request: request.id, choice: 'choice-2', note: 'Cap it at €30 and bill the staging project' } });
  await expect(card).toHaveCount(1);
  await expect(note).toHaveValue('Cap it at €30 and bill the staging project');
});

test('a real-world check keeps the photo the person chose: a 1 MiB image posts whole, and an unreadable one holds the answer', async ({ page }) => {
  const check = { id: '6c1d9f5e-8e9b-4a7f-8b66-1d2e3f4a5b6c', proof: 'human:receipt-prints', criterion: 'AC-1', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1, ask: 'A receipt prints on the shop printer', steps: ['Make this check on commit aaaaaaaaaaaa'], at: '2026-01-01T00:00:00Z', requestedBy: 'graphyard', answer: null };
  const work = { ...parked, blocker: null, humanRequest: null, humanRequests: [], humanProofs: [check] };
  const posted: any[] = [];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/sign-in') return route.fulfill({ json: { token: 'browser-human', actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, expiresAt: '2026-01-01T14:00:00Z' } });
    if (route.request().method() === 'POST') { posted.push(route.request().postDataJSON()); return route.fulfill({ json: work }); }
    if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, humanOnly: openHumanOnly([{ work: work as never }], Date.parse(now)), github: true, reviewProviders: ['github'], repository: 'fixture/repository', jobs: [] } });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work: [work], now } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus([work as never], Date.parse(now), { humanOnly: openHumanOnly([{ work: work as never }], Date.parse(now)) }) });
    return route.fulfill({ json: path.endsWith('/work') ? [work] : [] });
  });
  await page.goto('/#sign-in=one-time-code-from-mainworks-login&work');
  await page.getByRole('button', { name: 'Every request and answer →' }).click();
  const card = page.locator('.human-request'), pass = card.getByRole('button', { name: 'Pass, with this note…' }), photo = card.getByLabel('Photo (optional)');
  await card.getByRole('textbox', { name: 'Note for GY-7' }).fill('Printed clean');
  await expect(pass).toBeEnabled();

  const original = await page.evaluateHandle(() => FileReader.prototype.readAsDataURL);
  await page.evaluate(() => { FileReader.prototype.readAsDataURL = function () { setTimeout(() => this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>)); }; });
  await photo.setInputFiles({ name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('broken') });
  await expect(card.getByRole('alert')).toContainText('could not be read');
  await expect(pass).toBeDisabled();
  await page.evaluate(read => { FileReader.prototype.readAsDataURL = read; }, original);

  const bytes = Buffer.alloc(1024 * 1024, 7);
  await photo.setInputFiles({ name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: bytes });
  await expect(pass).toBeEnabled();
  await expect(card.getByRole('alert')).toHaveCount(0);
  await pass.click();
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0]).toEqual({ request: check.id, outcome: 'pass', note: 'Printed clean', photo: { name: 'receipt.jpg', mediaType: 'image/jpeg', bytes: bytes.toString('base64') } });
});
