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
// heading, the seven steps and the guide line, one Got it button, each named page a link to that page, and the
// guide line a link to the public guide in a new tab. The owner with merged work sees it; the first-run page, a
// teammate and a browser that dismissed it see none. Help shows the guide link line at its top.

/** The owner's public guide for new factory managers. */
const guide = 'https://claude.ai/artifact/WdyKuULnFYMx8qF5eTmFbg';
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
  guide: `The full guide for new factory managers: ${guide}`,
  button: 'Got it',
  links: [['Home', '#home'], ['Needs you', '#needs-you'], ['Work', '#work'], ['Work', '#work'], ['Lead', '#lead'], ['Lead', '#lead'], ['Product', '#product'], [guide, guide]] as [string, string][],
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
const help = (actor: unknown) => renderToStaticMarkup(createElement(GuidePage, { setView: noop, owner: actor === owner }));

/** The checklist's markup on a rendered Home, or null where none is shown. */
const checklist = (html: string) => {
  const start = html.indexOf('<section class="panel first-time"');
  return start < 0 ? null : html.slice(start, html.indexOf('</section>', start) + '</section>'.length);
};
/** The words of a markup fragment, without its tags. */
const words = (html: string) => html.replace(/<[^>]+>/g, '');
/** Every link in a fragment: its text, where it goes, and whether it opens a new tab. */
const links = (html: string) => [...html.matchAll(/<a ([^>]*)>(.*?)<\/a>/g)].map(([, attributes, text]) =>
  ({ text: words(text), href: /href="([^"]*)"/.exec(attributes)![1], newTab: /target="_blank"/.test(attributes) }));
/** This process's storage, replaced for one check and put back after it. */
function withStorage(storage: unknown, check: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
  try { check(); } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('unit:first-time-panel-copy — Home shows the owner the checklist with its exact copy and links, after the status line; the first-run page and a teammate show none, and Help shows the owner one button', () => {
  const html = home(boardWork());
  const panel = checklist(html);
  assert.ok(panel, 'the owner with merged work sees the checklist on Home');
  assert.equal(words(panel), [copy.heading, copy.intro, ...copy.steps, copy.guide, copy.button].join(''), 'the panel holds the copy and nothing else');
  assert.equal(words(panel.match(/<h2>.*?<\/h2>/)![0]), copy.heading);
  assert.deepEqual([...panel.matchAll(/<li>(.*?)<\/li>/g)].map(match => words(match[1])), copy.steps, 'the seven steps, one list item each');
  const anchors = links(panel);
  assert.deepEqual(anchors.map(({ text, href }) => [text, href]), copy.links, 'each named page links to that page, and the guide line to the public guide');
  assert.deepEqual(anchors.map(anchor => anchor.newTab), [...copy.links.slice(0, 7).map(() => false), true], 'only the public guide opens a new tab');
  assert.deepEqual([...panel.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(match => words(match[1])), [copy.button], 'one button, Got it');
  assert.ok(html.indexOf('class="home-status-line"') < html.indexOf('<section class="panel first-time"'), 'under the status line and the incident cards');

  assert.equal(checklist(home([])), null, 'the first-run page, with no merged work, shows no checklist');
  assert.equal(checklist(home(boardWork(), teammate)), null, 'a teammate, who has no Tell the Lead box on Home, is shown none');
  assert.match(help(owner), /<div class="page-actions"><button type="button">Show the first-time checklist<\/button><\/div>/, 'Help offers the owner one button');
  assert.doesNotMatch(help(teammate), /first-time checklist/, 'a teammate is offered no button for a checklist they are not shown');
});

test('unit:first-time-panel-copy — Help shows the guide link line at its top, for everyone, opening the public guide in a new tab', () => {
  const line = /<div class="page-heading"><div><h1>.*?<\/h1><p class="page-fact">.*?<\/p><p class="summary">New to running a factory\? <a href="https:\/\/claude\.ai\/artifact\/WdyKuULnFYMx8qF5eTmFbg" target="_blank" rel="noopener noreferrer">Read the factory manager guide<\/a><\/p>/;
  for (const actor of [owner, teammate]) {
    const html = help(actor);
    assert.match(html, line, 'the guide link line sits in the page heading, under the primary fact');
    assert.ok(html.indexOf('Read the factory manager guide') < html.indexOf('aria-label="On this page"'), 'above everything else the page shows');
  }
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
