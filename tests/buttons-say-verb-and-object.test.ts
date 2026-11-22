import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../src/model.js';
import { NOW, boardApi, boardStatus, boardWork } from '../browser-tests/ui-board.js';
import { boardFromStatus } from '../src/model/board.js';
import { defaultChoices, humanDecisionKinds, openHumanRequests } from '../src/model/human-request.js';
import { humanRequestSchema } from '../src/model-boundary/human-request.js';
import { parkInput } from '../src/cli/park-command.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import OverviewPage from '../web/pages/overview.js';
import HomePage from '../web/pages/home.js';
import WorkDetails from '../web/pages/work-details.js';
import HumanRequestsPage from '../web/pages/human-requests.js';
import ShippedPage from '../web/pages/shipped.js';
import NowPage from '../web/pages/now.js';
import WorkersPage from '../web/pages/workers.js';
import MasterPage from '../web/pages/master.js';
import SetupPage from '../web/pages/setup.js';
import TopBar, { MainTopBar } from '../web/components/top-bar.js';
import WorkCard from '../web/components/work-card.js';
import CreateWork from '../web/pages/create-work.js';

const BANNED_BARE_LABELS = [
  'Approve',
  'Decline',
  'Decide',
  'Confirm',
  'OK',
  'Yes',
  'No',
  'Go ahead as asked',
  'Go ahead differently',
] as const;

const normalizeLabel = (text: string) => text.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().replace(/[….:]+$/, '').toLowerCase();
const bannedSet = new Set(BANNED_BARE_LABELS.map(label => label.toLowerCase()));

function extractControlLabels(html: string): string[] {
  const labels: string[] = [];
  for (const match of html.matchAll(/<(button|a)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const label = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (label) labels.push(label);
  }
  return labels;
}

const noop = () => {};
function makeDashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  const work = overrides.work ?? (boardWork() as unknown as Work[]);
  const status = overrides.status ?? boardStatus('admin');
  const d: Dashboard = {
    token: 'fixture', work, status, error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop,
    filter: null, setFilter: noop, shippedFilter: null, setShippedFilter: noop, selected: null, setSelected: noop,
    creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: NOW, jobs: [], query: '', setQuery: noop,
    operatorAgents: [], operatorAgentsError: null, features: { validation: null, releases: null, automation: null },
    events: [], editingRequirements: false, setEditingRequirements: noop, sessionEpoch: { current: 0 },
    api: async (path: string) => boardApi(path, 'admin'), refresh: async () => {}, action: async () => {},
    setError: noop, signOut: noop, ...overrides,
  };
  return 'board' in overrides ? d : { ...d, board: boardFromStatus(d.work, d.observedAt, d.status) };
}

const markup = (element: ReactElement) => renderToStaticMarkup(element);

test('unit:buttons-say-verb-and-object — no rendered page has a banned bare label on a button or link, and human requests show the worker choice labels', () => {
  const work = boardWork() as unknown as Work[];
  // Add a parked item with explicit verb-and-object worker choices to verify they render verbatim.
  const customParked: Work = {
    ...work.find(item => item.key === 'GY-20')!,
    id: 'custom-parked-1',
    key: 'GY-999',
    title: 'Add seats for builders',
    humanRequest: {
      id: 'req-custom-1',
      kind: 'money-or-accounts',
      needed: 'Approve 2 more Claude seats or keep the current pool',
      reason: 'Builders are queuing on seat limits',
      ask: 'Approve 2 more Claude seats?',
      recommendation: 'Approve 2 more seats',
      why: 'Two more seats clear the builder queue.',
      requestedBy: 'worker-1',
      epoch: 1,
      at: new Date(NOW - 60_000).toISOString(),
      choices: [
        { id: 'seats', label: 'Approve 2 more seats', outcome: 'provided', input: 'none' },
        { id: 'keep', label: 'Keep current seats', outcome: 'declined', input: 'none' },
      ],
    },
  };
  const allWork = [...work, customParked];
  const d = makeDashboard({ work: allWork });

  // Scan every rendered page and component.
  const pages: [string, string][] = [
    ['MainTopBar', markup(createElement(MainTopBar, d))],
    ['TopBar', markup(createElement(TopBar, d))],
    ['HomePage', markup(createElement(HomePage, d))],
    ['OverviewPage', markup(createElement(OverviewPage, d))],
    ['HumanRequestsPage', markup(createElement(HumanRequestsPage, d))],
    ['WorkDetails (parked default)', markup(createElement(WorkDetails, { ...d, item: work.find(item => item.key === 'GY-20')! }))],
    ['WorkDetails (parked custom)', markup(createElement(WorkDetails, { ...d, item: customParked }))],
    ['WorkDetails (moving)', markup(createElement(WorkDetails, { ...d, item: work.find(item => item.key === 'GY-16')! }))],
    ['WorkCard (needs-you)', markup(createElement(WorkCard, { item: work.find(item => item.key === 'GY-20')!, now: NOW, onOpen: noop, group: 'needs-you' }))],
    ['ShippedPage', markup(createElement(ShippedPage, d))],
    ['NowPage', markup(createElement(NowPage, d))],
    ['WorkersPage', markup(createElement(WorkersPage, d))],
    ['MasterPage', markup(createElement(MasterPage, d))],
    ['SetupPage', markup(createElement(SetupPage, { status: d.status, api: d.api, setView: noop }))],
    ['CreateWork', markup(createElement(CreateWork, { ...d, creating: true }))],
  ];

  const violations: string[] = [];
  for (const [name, html] of pages) {
    for (const label of extractControlLabels(html)) {
      if (bannedSet.has(normalizeLabel(label))) violations.push(`${name}: "${label}"`);
    }
  }
  assert.deepEqual(violations, [], `Found banned bare button/link labels:\n${violations.join('\n')}`);

  // Default choices for every human decision kind must also avoid banned bare labels.
  for (const kind of humanDecisionKinds) {
    for (const choice of defaultChoices(kind, false)) {
      assert.ok(!bannedSet.has(normalizeLabel(choice.label)), `defaultChoices(${kind}) has banned label "${choice.label}"`);
    }
  }
  // openHumanRequests post.decline.submit must not be a banned bare label.
  for (const row of openHumanRequests(allWork, NOW)) {
    if (row.answer.post.decline) {
      assert.ok(!bannedSet.has(normalizeLabel(row.answer.post.decline.submit)), `decline submit has banned label "${row.answer.post.decline.submit}"`);
    }
  }

  // Worker's own choice labels are shown verbatim on the HumanRequestsPage.
  const requestsHtml = markup(createElement(HumanRequestsPage, d));
  assert.match(requestsHtml, /Approve 2 more seats/);
  assert.match(requestsHtml, /Keep current seats/);
});

test('unit:buttons-say-verb-and-object — park refuses a generic choice label and accepts verb-and-object labels', () => {
  const basePark = {
    epoch: 1,
    kind: 'goals-and-priorities' as const,
    needed: 'Choose whether to keep the old backend or switch to Postgres',
    reason: 'Owner decides backend direction',
    ask: 'Keep the old backend or switch to Postgres?',
    why: 'Postgres removes the single-host bottleneck.',
  };

  for (const bare of BANNED_BARE_LABELS) {
    const parsed = humanRequestSchema.safeParse({
      ...basePark,
      recommendation: bare,
      choices: [
        { id: 'c1', label: bare, outcome: 'provided', input: 'none' },
        { id: 'c2', label: 'Keep it on the old backend', outcome: 'declined', input: 'none' },
      ],
    });
    assert.equal(parsed.success, false, `humanRequestSchema should refuse generic choice "${bare}"`);

    assert.throws(
      () => parkInput(['1', 'goals-and-priorities', basePark.needed, '--ask', basePark.ask, '--recommend', bare, '--why', basePark.why, '--choice', bare, '--choice', 'Keep it on the old backend', '--', basePark.reason]),
      /generic|verb and object/i,
      `parkInput should refuse generic choice "${bare}"`,
    );
  }

  const valid = humanRequestSchema.safeParse({
    ...basePark,
    recommendation: 'Switch to Postgres',
    choices: [
      { id: 'c1', label: 'Switch to Postgres', outcome: 'provided', input: 'none' },
      { id: 'c2', label: 'Keep it on the old backend', outcome: 'declined', input: 'none' },
    ],
  });
  assert.equal(valid.success, true, 'humanRequestSchema accepts verb-and-object choices');
});
