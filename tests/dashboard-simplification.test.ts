import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { evaluate } from '../src/model-boundary/gates.js';
import { stages, type Gate, type Work } from '../src/model.js';
import { apiRoutes } from '../src/server/index.js';
// @ts-expect-error Dependency-free fixture and screenshot script.
import { fixtureApi, fixtureStatus, fixtureWork as auditWork, NOW, unexplainedWords, visibleWords } from '../scripts/dashboard-fixture.mjs';
import { live } from '../browser-tests/ui-board.js';
import { jargon, phaseOf, plainReason, plainStatus } from '../src/model/plain-status.js';
import { classify } from '../web/groups.js';
import WorkersPage from '../web/pages/workers.js';
import { glossary } from '../web/glossary.js';
import { probeFeatures, unknownFeatures, type Features } from '../web/features.js';
import { primaryEntries, sections, views, visibleViews } from '../web/pages/index.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import WorkPage from '../web/pages/work.js';
import { boardFromStatus } from '../src/model/board.js';
import WorkDetails from '../web/pages/work-details.js';

import GuidePage from '../web/pages/guide.js';
import AutomationPage from '../web/pages/automation.js';
import CreateWork from '../web/pages/create-work.js';
import TopBar, { MainTopBar } from '../web/components/top-bar.js';
import ScenarioLibrary from '../web/scenarios.js';

// GY-67: the dashboard is rendered from the checked-in fixture (scripts/dashboard-fixture.mjs)
// and read the way a newcomer reads it: visible words only, closed <details> bodies and item
// titles excluded. Every assertion here is about presentation; gates, authority and the API
// are the control plane's and are only read.

// The fixture's merged items are served by the release (since GY-161 a merge alone is still at Deploy).
const fixtureWork = () => auditWork().map(live);
const root = new URL('..', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');
const work = fixtureWork() as unknown as Work[];
const find = (key: string) => work.find(w => w.key === key)!;
const noop = () => {};
function dashboard(overrides: Partial<Dashboard> = {}, role = 'admin', features: Features = unknownFeatures): Dashboard {
  const d: Dashboard = {
    token: 'fixture', work, status: fixtureStatus(role), error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop, filter: null, setFilter: noop,
   
    selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: NOW, jobs: [], query: '', setQuery: noop,
    operatorAgents: [], operatorAgentsError: null, features, events: fixtureApi('events') as any[], editingRequirements: false, setEditingRequirements: noop,
    sessionEpoch: { current: 0 }, api: async (path: string) => fixtureApi(path, role), refresh: async () => {}, action: async () => {},
    setError: noop, signOut: noop, ...overrides,
  };
  // The board GET /api/board serves over the same work (GY-200): the Work page renders its groups.
  return 'board' in overrides ? d : { ...d, board: boardFromStatus(d.work, d.observedAt, d.status) };
}
const markup = (element: any) => renderToStaticMarkup(element);
const words = (html: string): string[] => visibleWords(html);
const text = (html: string) => words(html).join(' ');
const home = (d = dashboard()) => markup(createElement('div', null, createElement(MainTopBar, d), createElement(TopBar, d), createElement(WorkPage, d)));
const itemView = (key: string, role = 'admin') => markup(createElement(WorkDetails, { ...dashboard({}, role), item: find(key) }));
const jargonIn = (sentence: string) => jargon.filter(term => new RegExp(`\\b${term}`, 'i').test(sentence));

/** A work item in a given shape, evaluated by the real gate evaluator so its reasons are the control plane's own. */
function evaluated(overrides: Partial<Work>, all: Work[] = work): Work {
  const base = { ...find('GY-13'), id: `probe-${Math.random()}`, key: 'GY-99', ...overrides } as Work;
  const result = evaluate(base, [...all, base], new Date(NOW));
  return { ...base, stage: base.stage === 'done' ? 'done' : result.stage, gates: result.gates };
}
const withGates = (item: Partial<Work>, first: string, reasons: string[]): Work => {
  const order = ['ready', 'build', 'review', 'test', 'acceptance', 'merge'];
  const gates: Gate[] = order.map(name => ({ name, passed: order.indexOf(name) < order.indexOf(first), reasons: name === first ? reasons : order.indexOf(name) < order.indexOf(first) ? [] : ['later'] }));
  return { ...find('GY-15'), stage: first === 'ready' ? 'build' : first, ...item, gates } as Work;
};

test('unit:plain-status-copy — every stage and every gate reason reads as one plain sentence with no internal terms', () => {
  // The examples the requirement names, on the fixture.
  assert.equal(plainStatus(find('GY-13'), NOW).sentence, 'Waiting for someone to pick this up');
  assert.equal(plainStatus(find('GY-14'), NOW).sentence, 'Alex is building it — no pull request yet');
  assert.equal(plainStatus(find('GY-15'), NOW).sentence, 'Waiting for review of PR #42');
  assert.equal(plainStatus(find('GY-17'), NOW).sentence, 'Stuck: A fault blocks it; the master agent clears it.');
  // A lapsed claim is waiting for a worker, and says who stopped.
  assert.equal(plainStatus(find('GY-12'), NOW).sentence, 'Waiting for someone to pick this up — Robin stopped working on it');

  // One row per stage: the sentence, its tone, and who is named.
  const handedIn = { submission: { epoch: 1, pr: 42 }, candidate: { ...find('GY-15').candidate! }, epoch: 1 };
  const table: [string, Work, string, string][] = [
    ['backlog', { ...find('GY-11') }, 'Not started — waiting to be released for work', 'waiting'],
    ['ready', { ...find('GY-13') }, 'Waiting for someone to pick this up', 'waiting'],
    ['ready (dependency)', evaluated({ ready: true, dependencies: [find('GY-15').id] }), 'Waiting for GY-15 to ship first', 'waiting'],
    ['build', { ...find('GY-14') }, 'Alex is building it — no pull request yet', 'working'],
    ['build (rework)', { ...find('GY-15'), reworkRequested: true, lease: null }, 'Sent back for changes — waiting for someone to pick it up', 'waiting'],
    ['build (handed in)', withGates(handedIn, 'build', ['Pull request has not been independently observed']), 'Handed in — Mainworks has not seen the pull request on GitHub yet', 'waiting'],
    ['review', { ...find('GY-15') }, 'Waiting for review of PR #42', 'waiting'],
    ['review (changes)', withGates(handedIn, 'review', ['Outstanding change requests must be resolved through a new review']), 'A reviewer asked for changes on PR #42', 'waiting'],
    ['test', withGates(handedIn, 'test', ['Required CI check test has not passed on the current candidate']), 'Waiting for automated checks on PR #42', 'waiting'],
    ['acceptance', { ...find('GY-16') }, 'Waiting for proof that it works — 2 of 3 proofs passed', 'waiting'],
    ['merge (conflict)', withGates(handedIn, 'merge', ['Pull request is not mergeable against the current base']), 'Stuck: the pull request conflicts with the main branch', 'stuck'],
    ['merge (ready)', { ...withGates(handedIn, 'merge', []), stage: 'merge', gates: find('GY-18').gates }, 'Ready to merge PR #42', 'waiting'],
    ['done', { ...find('GY-18') }, 'Shipped in PR #40', 'shipped'],
    // Done = merged (GY-1981): shipped whatever the smoke policy or deployment record.
    ['done (smoke policy, no deployment record)', { ...find('GY-18'), delivery: { ...find('GY-18').delivery!, deployment: undefined }, policy: { ...find('GY-18').policy, deploySmoke: true } as any }, 'Shipped in PR #40', 'shipped'],
    ['done (no deployment record)', { ...find('GY-18'), delivery: { ...find('GY-18').delivery!, deployment: undefined } }, 'Shipped in PR #40', 'shipped'],
    ['blocked', { ...find('GY-17') }, 'Stuck: A fault blocks it; the master agent clears it.', 'stuck'],
  ];
  const seen = new Set<string>();
  for (const [name, item, sentence, tone] of table) {
    const status = plainStatus(item, NOW);
    if (sentence) assert.equal(status.sentence, sentence, name);
    if (tone) assert.equal(status.tone, tone, name);
    assert.deepEqual(jargonIn(status.sentence), [], `${name}: ${status.sentence}`);
    seen.add(item.stage);
  }
  assert.deepEqual([...seen].sort(), [...stages].sort(), 'the table covers every stage');

  // Every reason the gate evaluator can give, in every form, has a plain reading.
  const reasons: [string, string][] = [
    ['ready', 'Not released from backlog'], ['ready', 'Dependency GY-3 is unfinished'], ['ready', 'needs a second Postgres instance'],
    ['build', 'Worker has not submitted implementation for this attempt'], ['build', 'Pull request has not been independently observed'], ['build', 'No workspace registered'],
    ['review', 'Verified clean Codex review of the current commit is required'],
    ['review', 'Every configured reviewer profile is exhausted for this candidate (claude); add reviewer capacity or select another review provider'],
    ['review', 'Verified approval from reviewer profile claude is required for the current commit'],
    ['review', 'A new independent approval after the requirement-review baseline is required'], ['review', 'Independent approval of the current commit is required'],
    ['review', 'Outstanding change requests must be resolved through a new review'],
    ['test', 'Required CI check typecheck has not passed on the current candidate'],
    ['acceptance', 'AC-2: unit:login needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy'],
    ['acceptance', 'AC-2: e2e:checkout needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy; scenario v3 in staging; previously accepted evidence was revoked'],
    ['acceptance', 'Bootstrap obligation inherited from GY-4 AC-1: unit:x needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy'],
    ['acceptance', 'Trusted unit:x evidence from ci is no longer independent: ci has since held an assignment on GY-9'],
    // GY-1235: the merge gate reads no observation age and no protection verification, only whether GitHub was seen at the candidate.
    ['merge', 'The merge writer has not observed the current candidate'],
    ['merge', 'Pull request is not mergeable against the current base'],
    ['merge', 'Slice lead lead-1 ruled hold under rule R-2; delivery is blocked until the authorized recovery: redo the migration'],
  ];
  for (const [gate, reason] of reasons) {
    const plain = plainReason(reason, gate, Date.now());
    assert.ok(plain.known, `${gate}: no plain reading for "${reason}"`);
    assert.deepEqual(jargonIn(plain.text), [], `${reason} → ${plain.text}`);
    const status = plainStatus(withGates({ submission: { epoch: 1, pr: 7 }, candidate: { ...find('GY-15').candidate!, pr: 7 }, blocker: gate === 'ready' && !/^(Not released|Dependency)/.test(reason) ? reason : null, lease: null }, gate, [reason]), NOW);
    assert.deepEqual(jargonIn(status.sentence), [], `${reason} → ${status.sentence}`);
  }
  // The live evaluator's reasons for every fixture item are all recognised.
  for (const item of work) for (const gate of evaluate(item, work, new Date(NOW)).gates) for (const reason of gate.reasons) assert.ok(plainReason(reason, gate.name, Date.now()).known, `${item.key} ${gate.name}: ${reason}`);
  // An unanticipated reason never leaks: it reads as its step.
  assert.equal(plainReason('Internal epoch lease candidate mismatch', 'merge', Date.now()).text, 'Waiting to merge');
});

test('integration:dashboard-navigation — one top bar (Home, Work, Lead, Settings); every other page sits under one place; admin-only and unconfigured pages hidden', async () => {
  const labels = (d: Dashboard) => primaryEntries(d).map(entry => entry.label);
  // GY-3600: Now and Shipped are filters of Work, not pages of their own.
  assert.deepEqual(sections.map(section => section.label), ['Home', 'Work', 'Lead', 'Settings']);
  for (const role of ['admin', 'reader', 'worker', 'coordinator', 'operator-agent']) assert.equal(labels(dashboard({}, role)).length, 4, role);
  assert.deepEqual(labels(dashboard()), ['Home', 'Work', 'Lead', 'Settings']);
  const sectionOf = Object.fromEntries(views.map(view => [view.label, view.section]));
  for (const page of ['Work', 'Needs you', 'Releases', 'Tests', 'Test cases']) assert.equal(sectionOf[page], 'work', page);
  for (const page of ['Lead', 'Product']) assert.equal(sectionOf[page], 'lead', page);
  for (const page of ['Agents', 'Workers', 'Costs', 'Setup', 'Delivery', 'Help', 'Operator automation']) assert.equal(sectionOf[page], 'settings', page);

  // The top bar renders exactly the four places; the pages of a place are sub-page links above the content.
  const topNav = markup(createElement(MainTopBar, dashboard()));
  assert.equal(topNav.match(/class="nav-link( active)?"/g)?.length, 4);
  const tabs = (d: Dashboard, view: string) => [...markup(createElement(TopBar, { ...d, view })).matchAll(/class="tab(?: active)?"[^>]*>(?:<abbr[^>]*>)?([^<]+)</g)].map(match => match[1]);
  assert.deepEqual(tabs(dashboard(), 'work'), ['Work', 'Tests', 'Advanced', 'Releases', 'Test cases']);
  assert.deepEqual(tabs(dashboard(), 'agents'), ['Agents', 'Workers', 'Costs', 'Setup', 'Delivery', 'Help', 'Advanced', 'Operator automation'], 'Operator automation sits inside the Advanced fold');
  assert.match(markup(createElement(TopBar, { ...dashboard(), view: 'agents' })), /<details class="tabs-advanced"><summary class="tab">Advanced<\/summary><button[^>]*>(<abbr[^>]*>)?Operator automation/);
  assert.deepEqual(tabs(dashboard(), 'lead'), ['Lead', 'Product']);
  assert.deepEqual(tabs(dashboard(), 'home'), [], 'Home alone draws no tab row');

  // Admin-only pages are hidden from reader and worker sessions, even when configured.
  const configured = { validation: true, releases: true, automation: true };
  assert.deepEqual(tabs(dashboard({}, 'reader', configured), 'agents'), ['Agents', 'Workers', 'Costs', 'Delivery', 'Help'], 'a reader sees Agents, Workers, Costs, Delivery and Help, not Setup');
  for (const role of ['reader', 'worker']) assert.ok(!visibleViews(dashboard({}, role, configured)).some(view => view.adminOnly), role);
  // A feature with nothing configured is hidden, not rendered as an empty explainer; an unknown one stays.
  const probed = await probeFeatures(async path => path === 'operator-agents' ? [] : { environments: [], releases: [], requests: [], candidates: [] }, true, false);
  assert.deepEqual(probed.features, { releases: false, validation: false, automation: false });
  const none = dashboard({}, 'admin', probed.features);
  assert.ok(!tabs(none, 'work').includes('Releases'), 'Releases hidden when unconfigured');
  assert.deepEqual(tabs(none, 'agents'), ['Agents', 'Workers', 'Costs', 'Setup', 'Delivery', 'Help'], 'no Advanced fold while automation is unconfigured');
  const failing = await probeFeatures(async () => { throw new Error('unavailable'); }, true, false);
  assert.deepEqual(failing.features, { releases: null, validation: false, automation: null }, 'an outage never hides a page');
  // An outage and an empty registry mean opposite things, so the page never reports one as the other.
  assert.equal(probed.operatorAgentsError, null);
  assert.equal(failing.operatorAgentsError, 'unavailable');
  const unread = markup(createElement(AutomationPage, { operatorAgents: [], operatorAgentsError: 'unavailable' }));
  assert.match(text(unread), /Operator automation could not be read, so what is configured is unknown: unavailable/);
  assert.doesNotMatch(text(unread), /safe bootstrap default/);
  assert.match(unread, /Configured identities <span class="count">—<\/span>/, 'an unknown count is never drawn as zero');
  assert.match(text(markup(createElement(AutomationPage, { operatorAgents: [], operatorAgentsError: null }))), /None set up\..*No automation identities\./);
  assert.equal((await probeFeatures(async () => ({ requests: [] }), false, true)).features.validation, false, 'repository cases do not enable the retired validation runner');
  // Delivery slices are about who works on what: on the Workers page once a slice has a lead, never on Work.
  const led = fixtureStatus('admin'); led.delegation.slices[0].lead = { id: 'lead', displayName: 'Pine', sessionKind: 'ai' } as any;
  assert.doesNotMatch(home(dashboard({ status: led })), /Delivery slices/);
  assert.doesNotMatch(markup(createElement(WorkersPage, dashboard())), /Delivery slices/);
  assert.match(markup(createElement(WorkersPage, dashboard({ status: led }))), /Delivery slices/);
  // web/main.tsx renders MainTopBar instead of Sidebar.
  assert.match(await read('web/main.tsx'), /<MainTopBar/);
});

test('integration:dashboard-word-budget — the home page answers what needs you, what is blocked, what is moving and what shipped on one screen in at most 165 words', () => {
  const page = home();
  const count = words(page).length;
  // Keep the existing budget: the Lead entry replaces the duplicate sidebar repository name.
  assert.ok(count <= 165, `home renders ${count} words excluding item titles: ${text(page)}`);
  for (const gone of ['Delivery slices', 'NO LEAD ASSIGNED', 'ENGINEERING, IN VIEW', 'Every change has an owner', 'Explicit reasons, actionable next steps', 'No delivery requires', 'sessions retain goals', 'leads coordinate only', 'Ownership is explicit', 'Agent fleet'])
    assert.ok(!text(page).includes(gone), `no ${gone}`);
  assert.doesNotMatch(text(page), /\bp50\b|\bp95\b/, 'no percentile microtext by default');
  // GY-3600: rows in order within their goal: stuck first, then moving, up next, backlog.
  const order = ['group-blocked', 'group-moving', 'group-up-next', 'group-backlog'].map(group => page.indexOf(`class="task-row ${group}`));
  assert.ok(order.every(index => index > 0) && order.every((index, i) => i === 0 || index > order[i - 1]), `rows in order: ${order}`);
  assert.ok(page.indexOf('Move sessions to Postgres') < page.indexOf('Add dark mode to settings'), 'the stuck item is listed first');
  assert.match(text(page), /a fault blocks it; the master agent clears it/i);
});

test('integration:item-view-structure — state, who acts next and why on the plate; the steps; each criterion once; edits in an admin menu; at most 250 words', () => {
  const view = itemView('GY-16');
  const visible = text(view);
  const count = words(view).length;
  assert.ok(count <= 250, `item view renders ${count} words: ${visible}`);
  const at = (needle: string) => { const index = visible.indexOf(words(needle).join(' ')); assert.ok(index >= 0, `shows ${needle}: ${visible}`); return index; };
  // GY-3392: the plate answers who acts next and why, with no pull request wording anywhere; the
  // gate detail folds under Technical details, so its lines read on the opened fold.
  const opened = (html: string) => text(html.replaceAll(' hidden=""', '').replace('<details class="more-details"', '<details open class="more-details"'));
  const order = [at('Moving'), at('Testing 2 of 3 proofs passed'), at('Next: Prover agent')];
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'state, why, who acts next');
  assert.ok(opened(view).indexOf('What is left') < opened(view).indexOf('The proof integration:login-latency has not passed yet'), 'the folded gate detail keeps its plain lines');
  // Only the current step's reasons are listed as what is left, inside the collapsed Technical
  // details (GY-3392); the gates' raw reasons stay there too.
  const review = itemView('GY-15');
  assert.match(opened(review), /Waiting for someone else to approve the latest code/);
  assert.doesNotMatch(text(review), /Proven to work:/, 'later steps are collapsed');
  assert.doesNotMatch(text(review), /What is left/, 'the gate detail is one click down');
  for (const raw of ['needs trusted passing evidence', 'Policy v', 'Revision ', 'assignment 1', 'GitHub observation missing']) assert.ok(!text(review).includes(raw) && !visible.includes(raw), `no ${raw} by default`);
  // Requirements sit below the plate (GY-161 AC-10, GY-171 AC-1), folded with the description under Details
  // (GY-2011 AC-3): one line per criterion, its full text folded; each criterion appears once in Requirements (the Tests panel
  // names its proofs' criterion too, GY-2091), with one marker per proof.
  assert.match(view, /<details class="panel item-details-fold" aria-label="Description and criteria"><summary>Description and criteria<\/summary>[\s\S]*<section class="requirements" aria-label="Requirements">/);
  const requirements = view.slice(view.indexOf('aria-label="Requirements"'), view.indexOf('aria-label="Activity"'));
  for (const ac of find('GY-16').criteria) assert.equal(text(requirements).split(/\s+/).filter((word: string) => word === ac.id).length, 1, `${ac.id} once in Requirements`);
  assert.equal(view.match(/class="marker-pass"/g)?.length, 2); assert.equal(view.match(/class="marker-pending"/g)?.length, 1);
  const lines = text(view.replaceAll(' hidden=""', '').replace('<details class="panel item-details-fold"', '<details open class="panel item-details-fold"'));
  assert.match(lines, /AC-1 More than ten failed logins from one address in a minute are refused\. integration:login-rate-limit passed/);
  assert.match(view, /<li class="marker-pass">✓ <abbr class="term"[^>]*>integration:login-rate-limit<\/abbr> passed<\/li>/);
  // Policy-changing actions sit in a closed, admin-only Edit menu.
  assert.match(view, /<details class="edit-menu"><summary>Edit<\/summary>[\s\S]*Revise requirements[\s\S]*<\/details>/);
  assert.ok(!visible.includes('Use Codex cloud review') && !visible.includes('Revise requirements'));
  for (const role of ['reader', 'worker']) { const other = itemView('GY-16', role); assert.doesNotMatch(other, /edit-menu|Use Codex cloud review|Revise requirements/, role); }
});

// The words a newcomer cannot guess: abbreviations, proof names and a commit. Wherever one is
// visible by default it must carry its glossary definition in place — the same screens the
// manual plain-language review reads, which found PR, the commit, E2E and the form's terms bare.
const cannotGuess = [/^PR$/, /^SHA(-\d+)?$/i, /^CI$/, /^E2E$/i, /^(unit|integration|e2e|manual):/, /^p(50|90|95)$/, /^[0-9a-f]{40}$/];
const bare = (html: string) => unexplainedWords(html)
  .map((word: string) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}:]+$/gu, ''))
  .filter((word: string) => cannotGuess.some(pattern => pattern.test(word)));

test('plain-language support for manual:plain-language-review — every visible technical term has a hover definition from the shared glossary; the guide is under 550 words; the create form explains proofs', () => {
  // GY-3295: the guide became the newcomer's Docs page (who decides, a first item, two diagrams); its FAQ and reference stay folded.
  const guide = markup(createElement(GuidePage));
  assert.ok(words(guide).length <= 550, `guide is ${words(guide).length} words`);
  const form = markup(createElement(CreateWork, dashboard({ creating: true })));
  const screens: [string, string][] = [
    ['How Mainworks works', guide],
    ['home', home(dashboard({ status: (() => { const s = fixtureStatus('admin'); s.delegation.slices[0].lead = { id: 'l', displayName: 'Pine', sessionKind: 'ai' } as any; return s; })() }))],
    ['item view', itemView('GY-16')],
    ['create form', form],
    ['test cases', markup(createElement(ScenarioLibrary, { api: async () => [], canEdit: true }))],
  ];
  for (const [name, html] of screens) {
    // Every definition on screen is the shared glossary's own wording, and none is written twice.
    for (const [, title] of html.matchAll(/<abbr class="term" title="([^"]*)"/g)) assert.ok(Object.values(glossary).includes(title.replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&') as any), `${name}: definition from the glossary: ${title}`);
    assert.deepEqual(bare(html), [], `${name}: every technical word a newcomer cannot guess carries its definition in place`);
  }
  // The item view's commit and pull request are the glossary's, not a bare identifier.
  assert.match(itemView('GY-16'), /<abbr class="term" title="[^"]*forty letters[^"]*"[^>]*><code class="sha" title="e{40}">e{8}<\/code><\/abbr>/);
  assert.match(home(), /<abbr class="term" title="The proposed code change on GitHub[^"]*"[^>]*>PR<\/abbr> #42/);
  assert.match(form, /A proof name starts with its kind/);
  for (const example of ['unit:login-rejects-bad-password', 'integration:claim-safety', 'e2e:checkout', 'manual:copy-review']) assert.ok(form.includes(example), example);
  assert.match(form, /Add another criterion/);
});

test('integration:dashboard-capability-parity — nothing removed from a default view is lost; the API is unchanged; the fixture reproduces the audit views; the sidebar spans the page', async () => {
  // The item view keeps every datum and action, under Technical details or the Edit menu.
  const item = find('GY-16');
  const view = itemView('GY-16');
  for (const needle of ['Policy v1', 'Revision 1', 'P2', 'Worker ID: worker-2', 'Owner', 'Blocking now:', 'Coordination', 'Code review', 'Gate decisions', 'Evidence (2)', 'Work history', 'Revise requirements', 'build-1:/work/gy-16-1', 'In this step for'])
    assert.ok(view.includes(needle), needle);
  for (const gate of item.gates) for (const reason of gate.reasons) assert.ok(view.includes(reason.replace(/&/g, '&amp;').replace(/>/g, '&gt;')), `raw reason kept: ${reason}`);
  for (const ac of item.criteria) assert.ok(view.includes(ac.text), `full criterion kept: ${ac.id}`);
  // The Work page keeps search and a way to every shipped item (GY-3600): Shipped today is a filter, and search finds any shipped task.
  const page = home();
  for (const control of ['aria-label="Search work"', 'data-filter="shipped-today"']) assert.ok(page.includes(control), control);
  for (const key of ['GY-18', 'GY-19', 'GY-9']) assert.ok(home(dashboard({ query: key })).includes(`data-row="${key}"`), key);
  // Every page in the registry stays reachable for an admin while its feature is unknown or configured.
  const admin = dashboard();
  for (const view of views) assert.ok(visibleViews(admin).includes(view), `${view.label} reachable`);
  // The dashboard calls only endpoints the server already serves: the API is unchanged.
  const served = apiRoutes.flatMap(module => module.routes).map(route => route.path);
  const matches = (path: string) => served.some(route => typeof route === 'string' ? route === `/api/${path}` : route.test(`/api/${path}`));
  for (const file of ['web/features.ts', 'web/main.tsx', 'web/pages/create-work.tsx', 'web/pages/work-details.tsx'])
    for (const [, path] of (await read(file)).matchAll(/(?:api|request|read)\(`([^`$?]+)[`$?]/g)) assert.ok(matches(path.replace(/\/$/, '')) || matches(`${path}x`), `${file}: /api/${path}`);
  for (const path of ['delivery', 'validation', 'operator-agents', 'work']) assert.ok(matches(path), path);
  const source = (await Promise.all(['web/pages/work-details.tsx', 'src/model/plain-status.ts'].map(read))).join('\n');
  assert.doesNotMatch(source, /api\((['`])work\/[^'`]*\/(stage|state)/, 'no client-controlled lifecycle state');
  // The fixture reproduces the audit's cases (the stage table in unit:plain-status-copy covers the rest), and the script the views.
  for (const phase of ['not-started', 'needs-worker', 'building', 'review', 'proof', 'shipped'] as const) assert.ok(work.some(w => phaseOf(w, NOW) === phase), phase);
  assert.ok(work.some(w => w.blocker) && work.some(w => w.stage === 'build' && !w.submission && Date.parse(w.lease?.expiresAt ?? '') < NOW), 'a blocked item and a lapsed claim');
  const script = await read('scripts/dashboard-fixture.mjs');
  for (const view of ['01-home', '02-item-view', '09-create-form']) assert.ok(script.includes(`'${view}'`), view);
  // The sidebar is a full-height flex column whose contents stick; no later rule pins it to one viewport.
  const css = await read('web/style.css');
  const sidebarRules = [...css.matchAll(/(?:^|[}\s])\.sidebar\{([^}]*)\}/g)].map(match => match[1]);
  const last = sidebarRules.filter(rule => /position:/.test(rule)).at(-1)!;
  assert.match(last, /position:relative/); assert.match(last, /align-self:stretch/);
  assert.match(css, /\.sidebar-inner\{position:sticky;top:0;height:100vh/);
  assert.match(css, /\.main\{margin-left:0\}/);
});

// GY-3600: Work shows one row of filter counts, In flight, Stuck, Up next and Shipped today, each drawn from the board's groups.
const filterCounts = (page: string) => [...page.matchAll(/data-filter="([\w-]+)">[^<]*<span class="count">(\d+)<\/span>/g)].map(match => [match[1], Number(match[2])] as const);

test('unit:dashboard-simplification — the home page renders its numbers without web/home-numbers.ts: every count is drawn from the board\'s groups', () => {
  const page = home();
  const { byGroup } = classify(work, NOW);
  const counts = Object.fromEntries(filterCounts(page));
  assert.equal(counts['in-flight'], byGroup['needs-you'].length + byGroup.blocked.length + byGroup.moving.length);
  assert.equal(counts.stuck, byGroup.blocked.length);
  assert.equal(counts['up-next'], byGroup['up-next'].length);
});

test('unit:work-page-single-count-row — the page shows one row of counts, the filters; no count appears twice and no two labels differ only by grammatical form', () => {
  const page = home();
  assert.deepEqual(filterCounts(page).map(([filter]) => filter), ['in-flight', 'stuck', 'up-next', 'shipped-today'], 'one count per filter, in order');
  assert.equal((page.match(/role="group" aria-label="Filter work"/g) ?? []).length, 1, 'one count row');
  assert.ok(!page.includes('data-tile='), 'the old tiles are gone');
  assert.ok(!/<nav [\s\S]*?<small>\d+<\/small>[\s\S]*?<\/nav>/.test(page), 'no sidebar entry carries a count');
  const labels = ['In flight', 'Stuck', 'Up next', 'Shipped today'];
  const stem = (label: string) => label.toLowerCase().split(/\s+/).map(word => word.replace(/ies$/, 'y').replace(/s$/, '')).join(' ');
  assert.equal(new Set(labels.map(stem)).size, labels.length, `no grammatical-twin labels: ${labels.join(' | ')}`);
});

test('unit:work-page-no-derived-totals — the heading carries no count; the in-flight total is said once in the header line and matches its filter', () => {
  const page = home();
  assert.ok(!page.includes('aria-label="Open items"'), 'no Open count');
  assert.match(page, /<h1>Work<\/h1>/, 'the heading carries no derived count');
  const line = /data-work-header="true">([^<]*)<\/p>/.exec(page)![1];
  assert.match(line, new RegExp(`^${Object.fromEntries(filterCounts(page))['in-flight']} in flight · `));
});

test('integration:work-page-density — an empty Needs you draws no strip, and the page answers what is stuck and why, what is moving and what shipped within the 165-word budget', () => {
  const page = home();
  const { byGroup } = classify(work, NOW);
  assert.equal(byGroup['needs-you'].length, 0);
  assert.ok(!page.includes('aria-label="Needs you"'), 'no empty Needs you strip');
  assert.match(text(page), /a fault blocks it; the master agent clears it/i, 'the stuck row says why');
  for (const item of byGroup.moving) assert.ok(page.includes(`data-row="${item.key}"`), item.key);
  assert.ok(words(page).length <= 165, `home renders ${words(page).length} words excluding item titles: ${text(page)}`);
});
