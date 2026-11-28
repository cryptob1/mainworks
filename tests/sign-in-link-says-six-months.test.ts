import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HELPER_TEXT, LoginView, STAYS_SIGNED_IN } from '../web/pages/login.js';

const noop = () => {};
const page = (linked: boolean) => renderToStaticMarkup(createElement(LoginView, { state: { kind: 'verifying' }, error: '', draftToken: '', setDraftToken: noop, submit: noop, retry: noop, useAnotherToken: noop, linked }));

test('unit:sign-in-link-says-six-months — the owner\'s sign-in link page says once, in one line, that this browser stays signed in for six months', () => {
  assert.equal(STAYS_SIGNED_IN, 'This browser stays signed in for six months.');
  const linked = page(true);
  assert.equal(linked.split(STAYS_SIGNED_IN).length - 1, 1);
  assert.match(linked, /<p class="login-help">This browser stays signed in for six months\.<\/p>/);
  assert.ok(!linked.includes(HELPER_TEXT));
  assert.ok(!page(false).includes(STAYS_SIGNED_IN));
});
