import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Dashboard } from '../web/pages/dashboard.js';
import HomePage from '../web/pages/home.js';
import GuidePage from '../web/pages/guide.js';
import { checklistDismissed, dismissChecklist, showChecklist } from '../web/components/home-checklist.js';
import { boardWork } from '../browser-tests/ui-board.js';

// unit:first-time-panel-copy — GY-4066: the day-one checklist on Home carries the exact copy GY-4066 wrote: the
// heading, the seven steps and the guide line, one Got it button, and each named page a link to that page. The
// owner with merged work sees it; the first-run page, a teammate and a browser that dismissed it see none.

/** The checklist's copy, exactly as GY-4066 wrote it; each page it names, and where that page is. */
const copy = {
  heading: 'First time here?',
  intro: 'You set goals and answer what only you can. The Lead and its builders do the rest.',
  steps: [
    'Read the line at the top of Home. Moving is good; Slowed or Stopped shows a card with one button to press.',
    'Answer everything under Needs you. Press Review request; the recommended answer comes first.',
    'Open Work. The header shows merges per hour and the median time from review to live.',
    'Press the Stuck filter on Work. For any change stuck there, ask the Lead why on the Lead page.',
    'Open Lead, then Product. Check the product brief says what you want built.',
    'Type one goal with a number into Tell the Lead below, then press Send.',
    'Use your app for ten minutes and tell the Lead what felt wrong.',
  ],
  guide: 'The full guide is in Settings → Help.',
  button: 'Got it',
  links: [['Home', '#home'], ['Needs you', '#needs-you'], ['Work', '#work'], ['Work', '#work'], ['Lead', '#lead'], ['Lead', '#lead'], ['Product', '#product'], ['Help', '#guide']] as [string, string][],
};

const owner = { id: 'operator', role: 'admin', sessionKind: 'human' };
const teammate = { id: 'teammate', role: 'reader', team: 'maintainer', sessionKind: 'human' };
const noop = () => {};
const home = (work: unknown[], actor: unknown = owner) => renderToStaticMarkup(createElement(HomePage, {
  token: 'fixture', work, board: null, status: { actor }, error: '', connected: true, lastUpdated: null, view: 'home', setView: noop, filter: null, setFilter: noop,
  selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: Date.now(), jobs: [], query: '', setQuery: noop,
  operatorAgents: [], operatorAgentsError: null, features: { validation: null, releases: null, automation: null, scenarios: null }, events: [], editingRequirements: false, setEditingRequirements: noop,
  sessionEpoch: { current: 0 }, api: async () => ({}), refresh: async () => {}, action: async () => {}, setError: noop, signOut: noop,
} as unknown as Dashboard));
const help = (ownerSignedIn: boolean) => renderToStaticMarkup(createElement(GuidePage, { setView: noop, owner: ownerSignedIn }));

/** The checklist's markup on a rendered Home, or null where none is shown. */
const checklist = (html: string) => {
  const start = html.indexOf('<section class="panel first-time"');
  return start < 0 ? null : html.slice(start, html.indexOf('</section>', start) + '</section>'.length);
};
/** The words of a markup fragment, without its tags. */
const words = (html: string) => html.replace(/<[^>]+>/g, '');
/** This process's storage, replaced for one check and put back after it. */
function withStorage(storage: unknown, check: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
  try { check(); } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('unit:first-time-panel-copy — Home shows the owner the checklist with its exact copy and links, after the status line; the first-run page and a teammate show none, and Help offers the owner one button', () => {
  const html = home(boardWork());
  const panel = checklist(html);
  assert.ok(panel, 'the owner with merged work sees the checklist on Home');
  assert.equal(words(panel), [copy.heading, copy.intro, ...copy.steps, copy.guide, copy.button].join(''), 'the panel holds the copy and nothing else');
  assert.equal(words(panel.match(/<h2>.*?<\/h2>/)![0]), copy.heading);
  assert.deepEqual([...panel.matchAll(/<li>(.*?)<\/li>/g)].map(match => words(match[1])), copy.steps, 'the seven steps, one list item each');
  assert.deepEqual([...panel.matchAll(/<a href="([^"]+)">(.*?)<\/a>/g)].map(match => [words(match[2]), match[1]]), copy.links, 'each named page links to that page');
  assert.deepEqual([...panel.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(match => words(match[1])), [copy.button], 'one button, Got it');
  assert.ok(html.indexOf('class="home-status-line"') < html.indexOf('<section class="panel first-time"'), 'under the status line and the incident cards');

  assert.equal(checklist(home([])), null, 'the first-run page, with no merged work, shows no checklist');
  assert.equal(checklist(home(boardWork(), teammate)), null, 'a teammate, who has no Tell the Lead box on Home, is shown none');
  assert.match(help(true), /<div class="page-actions"><button type="button">Show the first-time checklist<\/button><\/div>/, 'Help offers the owner one button');
  assert.doesNotMatch(help(false), /first-time checklist/, 'a teammate is offered no button for a checklist they are not shown');
});

test('unit:first-time-panel-copy — Got it remembers the dismissal in this browser and Help forgets it; a browser with no storage shows the checklist again', () => {
  const saved = new Map<string, string>();
  withStorage({ getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); } }, () => {
    assert.equal(checklistDismissed(), false);
    assert.ok(checklist(home(boardWork())), 'nothing dismissed: shown');
    dismissChecklist();
    assert.equal(checklistDismissed(), true, 'the dismissal is kept in storage');
    assert.equal(checklist(home(boardWork())), null, 'dismissed: the next load shows none');
    showChecklist();
    assert.equal(checklistDismissed(), false);
    assert.ok(checklist(home(boardWork())), 'shown again from Help');
  });
  // A private window, or this test's Node, has no storage: nothing is remembered, so the checklist shows.
  withStorage(undefined, () => {
    dismissChecklist();
    assert.equal(checklistDismissed(), false);
    assert.ok(checklist(home(boardWork())));
  });
});
