import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoginView, pageTitle } from '../web/pages/login.js';

const noop = () => {};
const form = (install: string) => renderToStaticMarkup(createElement(LoginView, { state: { kind: 'form' }, error: '', draftToken: '', setDraftToken: noop, submit: noop, retry: noop, useAnotherToken: noop, install }));
const username = (markup: string) => /<input[^>]*name="username"[^>]*>/.exec(markup)?.[0] ?? '';

test('unit:sign-in-form-names-its-factory — each install\'s sign-in form gives a password manager its own username and title', () => {
  const [core, hoa] = [form('cryptob1/graphyard'), form('cryptob1/hwd-backend')];
  for (const [markup, install] of [[core, 'cryptob1/graphyard'], [hoa, 'cryptob1/hwd-backend']]) {
    const field = username(markup);
    assert.match(field, /autoComplete="username"|autocomplete="username"/);
    assert.match(field, /readOnly=""|readonly=""/);
    assert.ok(field.includes(`value="${install}"`), field);
    assert.match(markup, /<input[^>]*type="password"[^>]*autoComplete="current-password"|<input[^>]*type="password"[^>]*autocomplete="current-password"/);
  }
  assert.notEqual(username(core), username(hoa));
  assert.equal(pageTitle('cryptob1/graphyard'), 'Mainworks · cryptob1/graphyard');
  assert.equal(pageTitle('cryptob1/hwd-backend'), 'Mainworks · cryptob1/hwd-backend');
  assert.equal(pageTitle(null), 'Mainworks');
});
