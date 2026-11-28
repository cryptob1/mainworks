import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HumanSignIn, maxSignInSessions, signInSessionTtlMs, teammateSessionTtlMs } from '../src/server/auth.js';
import { sessionExpiredCode } from '../src/model.js';
import { signInDatabase } from './helpers/sign-in-database.js';
import { signInProcess } from './helpers/sign-in-process.js';

const day = 86_400_000;

test('unit:owner-session-180-days-and-expiry-code — the owner stays signed in 180 days after last use, an unknown session is a 401 saying so, and a full table replaces its least recently used session', async () => {
  assert.equal(signInSessionTtlMs, 180 * day);
  assert.equal(teammateSessionTtlMs, 30 * 60_000);
  const database = await signInDatabase();
  const http = await signInProcess(database.url);
  try {
    let now = Date.parse('2026-11-27T00:00:00Z');
    const table = new HumanSignIn(database.store, () => now);
    const owner = { id: 'operator', role: 'admin', sessionKind: 'human' } as const;
    const session = await table.redeem(table.issue(owner, true).code);
    assert.equal(session.expiresAt, '2027-05-26T00:00:00.000Z');
    now += 179 * day;
    assert.equal((await table.authenticate(session.token))?.id, 'operator');
    now += 180 * day - 1;
    assert.equal((await table.authenticate(session.token))?.id, 'operator');
    now += 180 * day;
    assert.equal(await table.authenticate(session.token), null);

    // The server, answering, says the session is unknown or expired with a stable code.
    await database.store.pool.query("UPDATE human_sign_in_sessions SET expires_at=clock_timestamp()-interval '1 second'");
    for (const token of ['gyh_never-issued', session.token]) {
      const response = await fetch(http.url + '/api/status', { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, sessionExpiredCode);
    }
    assert.equal(sessionExpiredCode, 'session_expired');

    // At capacity a new sign-in replaces the least recently used session instead of being refused.
    await database.store.pool.query('DELETE FROM human_sign_in_sessions');
    const held = [];
    for (let i = 0; i < maxSignInSessions; i++) { held.push(await table.redeem(table.issue(owner, true).code)); now += 1000; }
    for (const kept of held.slice(1)) assert.ok(await table.authenticate(kept.token));
    now += 1000;
    const newest = await table.redeem(table.issue(owner, true).code);
    assert.ok(await table.authenticate(newest.token));
    assert.equal(await table.authenticate(held[0].token), null);
    for (const kept of held.slice(1)) assert.ok(await table.authenticate(kept.token));
    assert.equal((await database.store.pool.query('SELECT * FROM human_sign_in_sessions')).rowCount, maxSignInSessions);
  } finally { await http.close(); await database.close(); }
});
