import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPublicLink } from '../src/cli/team-access.js';
import { servedInstall } from './helpers/served-install.js';

// GY-3690: whether an install is reachable from the public internet is the owner's call: off by
// default, changed only by the owner's human session, recorded with who and when, and readable by any agent.

test('unit:public-link-is-the-owners-explicit-choice — off by default, the loop makes no funnel call while off, and only the owner\'s human session changes it', async () => {
  const install = await servedInstall('public_link_setting', { funnel: true });
  try {
    const as = async (token: string, path: string, body?: unknown) => {
      const response = await fetch(install.base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as any };
    };
    // Default off, as an agent reads it (`team-access status`).
    const initial = await as(install.loop, '/api/team-access/public-link');
    assert.deepEqual(initial.body, { on: false, by: null, at: null });
    assert.equal(renderPublicLink(initial.body), 'Public link: off (never set; off by default)');

    // Off: no funnel call, even with every public port free, and the existing serve is left as it is.
    await install.sync();
    const calls = existsSync(join(install.host, 'calls.log')) ? readFileSync(join(install.host, 'calls.log'), 'utf8') : '';
    assert.doesNotMatch(calls, /"funnel"/);
    assert.equal(existsSync(join(install.host, 'funnel.json')), false);

    // A non-owner is refused the change.
    const refused = await as(install.loop, '/api/team-access/public-link', { on: true });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'Only the owner, signed in to the dashboard, turns the public link on or off');
    assert.equal((await as(install.loop, '/api/team-access/public-link')).body.on, false);

    // The owner turns it on: recorded with who and when; the next pass turns Funnel on.
    const on = await install.call('/api/team-access/public-link', { on: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.on, true);
    assert.equal(on.body.by, 'operator');
    assert.ok(Math.abs(Date.parse(on.body.at) - Date.now()) < 60_000);
    assert.match(renderPublicLink(on.body), /^Public link: on \(set by operator at /);
    await install.sync();
    assert.match(readFileSync(join(install.host, 'calls.log'), 'utf8'), /"funnel"/);
  } finally { await install.close(); }
});
