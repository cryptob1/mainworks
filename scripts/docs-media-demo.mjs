// The README media's one demo state (GY-3926): a made-up storefront project whose header counts,
// Work rows, change detail and live sessions agree. scripts/docs-media.mjs serves it to the real
// dashboard; tests/readme-media-exist-and-fit.test.ts checks the counts agree.

export const NOW = Date.parse('2026-10-14T15:30:00.000Z');
const min = 60_000, hr = 60 * min;
export const at = (offset) => new Date(NOW + offset).toISOString();
const sha = (seed) => `${seed}4f8a2c91d7e3b60582a19c4d7e6f0312b8c9d4e5`.slice(0, 40);
const baseSha = sha('b');

function makeGates(reasons, criteria) {
  const acceptance = reasons.acceptance ?? [];
  return ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map((name) => {
    const list = name === 'acceptance' ? acceptance : reasons[name] ?? [];
    return { name, passed: list.length === 0, reasons: list };
  });
}

function makeObservation(pr, headSha, when, { reviews = [], merged = false, opened = when - 40 * min, files = ['src/app.ts'] } = {}) {
  return {
    candidate: { sha: headSha, baseSha, pr, branch: `demo/pr-${pr}`, author: 'builder', createdAt: at(opened) },
    checks: [
      { name: 'test', result: 'success', appId: 1 },
      { name: 'typecheck', result: 'success', appId: 1 },
    ],
    reviews,
    protected: true,
    mergeable: true,
    merged,
    mergeSha: merged ? sha(String((pr % 9) + 1)) : null,
    mergedAt: merged ? at(when) : null,
    files,
    scopeFiles: [],
    at: at(Math.min(when, -min)),
  };
}

const passedEvidence = (proof, headSha, when, producer = 'ci-verifier') => ({
  id: `ev-${proof}`,
  proof,
  sha: headSha,
  baseSha,
  policyRevision: 1,
  producer,
  trusted: true,
  result: 'pass',
  executed: 12,
  skipped: 0,
  at: at(when),
});

/** A live agent session on an item, seen working a few seconds ago — what the header counts as an agent working. */
const session = (kind, principal, runtime, startedAt) => ({
  id: `${principal}:1`, kind, principal, epoch: 1, runtime, host: 'demo', workspace: null, tab: null, pane: null,
  agentName: null, role: kind, head: null, attach: null, transcript: null, subject: kind === 'review' ? 'Reviewing the change' : 'Writing the change',
  startedAt: at(startedAt), updatedAt: at(-20_000), endedAt: null, state: 'running', outcome: null,
  observed: 'working', observedAt: at(-20_000), missedReports: 0,
});

function makeItem(n, title, fields = {}) {
  const criteria = fields.criteria ?? [
    { id: 'AC-1', text: 'The change works for a signed-in customer.', proofs: [`integration:demo-${n}`] },
  ];
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    key: `DEMO-${n}`,
    goal: fields.goal ?? 'Customer sign-in & billing',
    title,
    why: fields.why ?? title,
    summary: fields.summary ?? title,
    simplest: fields.simplest ?? '',
    description: fields.description ?? `${title}.`,
    type: 'feature',
    priority: 2,
    dependencies: [],
    criteria,
    policy: { checks: ['test', 'typecheck'], review: true, reviewProvider: 'github' },
    scenarioRequirements: [],
    stage: 'ready',
    revision: 3,
    policyRevision: 1,
    createdAt: at(-6 * hr),
    updatedAt: at(-2 * min),
    stageEnteredAt: at(-18 * min),
    ready: true,
    epoch: 1,
    lease: null,
    workspaces: [],
    candidate: null,
    submission: null,
    reworkRequested: false,
    evidence: [],
    observation: null,
    blocker: null,
    violations: [],
    ...fields,
    criteria,
    gates: makeGates(fields.reasons ?? {}, criteria),
    reasons: undefined,
  };
}

export function buildDemoState(heroPhase = 'static') {
  const sha101 = sha('1');
  const sha102 = sha('2');
  const sha103 = sha('e');
  const sha104 = sha('d');
  const sha105 = sha('c');

  const rateLimitCriteria = [
    { id: 'AC-1', text: 'More than ten failed logins from one address in a minute return HTTP 429.', proofs: ['integration:login-rate-limit'] },
    { id: 'AC-2', text: 'A refused login tells the customer when to try again.', proofs: ['unit:retry-after-copy'] },
    { id: 'AC-3', text: 'Normal sign-ins add less than 2 ms of overhead.', proofs: ['integration:login-latency'] },
  ];

  const item101 = makeItem(101, 'Speed up product search results', {
    stage: 'done',
    stageEnteredAt: at(-2 * hr),
    submission: { epoch: 1, pr: 84 },
    candidate: makeObservation(84, sha101, -2 * hr, { opened: -3 * hr }).candidate,
    observation: makeObservation(84, sha101, -2 * hr, {
      opened: -3 * hr,
      merged: true,
      reviews: [{ reviewer: 'reviewer-codex', sha: sha101, state: 'APPROVED', id: 901, submittedAt: at(-130 * min) }],
    }),
    delivery: { mergedAt: at(-2 * hr), mergeSha: sha('6'), authorizationRevision: 1 },
    releaseDeliveries: [{ environment: 'production', verifiedAt: at(-112 * min), releaseId: 'rel-84', releaseRevision: 1, generation: 1 }],
    pipeline: { submittedAt: at(-145 * min), attempts: [{ epoch: 1, claimedAt: at(-160 * min) }] },
    evidence: [passedEvidence('integration:demo-101', sha101, -135 * min)],
    lastAssignment: { owner: 'builder-2', epoch: 1, runtime: 'Codex' },
    reasons: {},
  });

  const item102 = makeItem(102, 'Fix timezone in weekly digest email', {
    stage: 'done',
    stageEnteredAt: at(-28 * min),
    submission: { epoch: 1, pr: 85 },
    candidate: makeObservation(85, sha102, -28 * min, { opened: -52 * min }).candidate,
    observation: makeObservation(85, sha102, -28 * min, {
      opened: -52 * min,
      merged: true,
      reviews: [{ reviewer: 'reviewer-claude', sha: sha102, state: 'APPROVED', id: 902, submittedAt: at(-36 * min) }],
    }),
    delivery: { mergedAt: at(-28 * min), mergeSha: sha('7'), authorizationRevision: 1 },
    releaseDeliveries: [{ environment: 'production', verifiedAt: at(-24 * min), releaseId: 'rel-85', releaseRevision: 1, generation: 1 }],
    pipeline: { submittedAt: at(-42 * min), attempts: [{ epoch: 1, claimedAt: at(-56 * min) }] },
    evidence: [passedEvidence('integration:demo-102', sha102, -38 * min)],
    lastAssignment: { owner: 'builder-1', epoch: 1, runtime: 'Claude' },
    reasons: {},
  });

  const item103 = makeItem(103, 'Rate-limit the login endpoint', {
    why: 'Stop credential stuffing on /login without slowing down real customers.',
    summary: '',
    simplest: '',
    description: 'Protect the sign-in route from brute-force attempts while keeping normal logins fast.',
    stage: 'test',
    stageEnteredAt: at(-4 * min),
    submission: { epoch: 1, pr: 86 },
    candidate: makeObservation(86, sha103, -10 * min, {
      opened: -22 * min,
      files: ['src/auth/rate-limit.ts', 'src/routes/login.ts', 'tests/login-rate-limit.test.ts'],
    }).candidate,
    observation: makeObservation(86, sha103, -2 * min, {
      opened: -22 * min,
      files: ['src/auth/rate-limit.ts', 'src/routes/login.ts', 'tests/login-rate-limit.test.ts'],
      reviews: [{ reviewer: 'reviewer-codex', sha: sha103, state: 'APPROVED', id: 903, submittedAt: at(-6 * min) }],
    }),
    pipeline: { submittedAt: at(-11 * min), attempts: [{ epoch: 1, claimedAt: at(-22 * min) }] },
    mergeLedger: { head: sha103, state: 'running', step: 'running test suite', at: at(-2 * min), intentAt: at(-5 * min) },
    criteria: rateLimitCriteria,
    evidence: [
      passedEvidence('integration:login-rate-limit', sha103, -7 * min),
      passedEvidence('unit:retry-after-copy', sha103, -7 * min),
      passedEvidence('integration:login-latency', sha103, -6 * min),
    ],
    productReview: {
      verdict: 'approved',
      sha: sha103,
      reviewer: 'reviewer-codex',
      at: at(-6 * min),
      findings: [
        'Approved. All three criteria pass with trusted proof:',
        '- AC-1: More than ten failed logins from one address in a minute return HTTP 429 (integration:login-rate-limit passed).',
        '- AC-2: A refused login tells the customer when to try again (unit:retry-after-copy passed).',
        '- AC-3: Normal sign-ins add less than 2 ms of overhead (integration:login-latency passed).',
      ].join('\n'),
      screenshots: [],
    },
    lastAssignment: { owner: 'builder-3', epoch: 1, runtime: 'Claude' },
    reasons: { merge: ['Merge trial in progress'] },
  });

  const item104 = makeItem(104, 'Add dark mode to account settings', {
    why: 'Let customers switch between light and dark appearance in Settings.',
    stage: 'review',
    stageEnteredAt: at(-9 * min),
    submission: { epoch: 1, pr: 87 },
    candidate: makeObservation(87, sha104, -9 * min, { opened: -25 * min }).candidate,
    observation: makeObservation(87, sha104, -2 * min, { opened: -25 * min }),
    pipeline: { submittedAt: at(-9 * min), attempts: [{ epoch: 1, claimedAt: at(-25 * min) }] },
    lastAssignment: { owner: 'builder-2', epoch: 1, runtime: 'Codex' },
    sessions: [session('review', 'reviewer-claude', 'claude', -9 * min)],
    reasons: { review: ['Independent review in progress'] },
  });

  const makeItem105 = (phase) => {
    const base = {
      why: 'Customers can download their billing history for accounting.',
      simplest: 'One CSV button on the Billing page using existing invoice rows.',
      description: 'Add a CSV export button on the Billing page with date, amount and status columns.',
    };
    if (phase === 'build' || phase === 'static') {
      return makeItem(105, 'Export monthly invoices as CSV', {
        ...base,
        stage: 'build',
        stageEnteredAt: at(-6 * min),
        lease: { owner: 'builder-1', epoch: 1, expiresAt: at(24 * min) },
        lastAssignment: { owner: 'builder-1', epoch: 1, runtime: 'Claude', claimedAt: at(-6 * min) },
        sessions: [session('implementation', 'builder-1', 'claude', -6 * min)],
        reasons: { build: ['Builder is writing the change and tests'] },
      });
    }
    if (phase === 'review') {
      return makeItem(105, 'Export monthly invoices as CSV', {
        ...base,
        stage: 'review',
        stageEnteredAt: at(-3 * min),
        submission: { epoch: 1, pr: 88 },
        candidate: makeObservation(88, sha105, -3 * min, { opened: -12 * min }).candidate,
        observation: makeObservation(88, sha105, -1 * min, { opened: -12 * min }),
        lastAssignment: { owner: 'builder-1', epoch: 1, runtime: 'Claude' },
        sessions: [session('review', 'reviewer-codex', 'codex', -3 * min)],
        reasons: { review: ['Waiting for the reviewer'] },
      });
    }
    if (phase === 'test') {
      return makeItem(105, 'Export monthly invoices as CSV', {
        ...base,
        stage: 'test',
        stageEnteredAt: at(-2 * min),
        submission: { epoch: 1, pr: 88 },
        candidate: makeObservation(88, sha105, -2 * min, { opened: -16 * min }).candidate,
        observation: makeObservation(88, sha105, -1 * min, {
          opened: -16 * min,
          reviews: [{ reviewer: 'reviewer-codex', sha: sha105, state: 'APPROVED', id: 905, submittedAt: at(-3 * min) }],
        }),
        mergeLedger: { head: sha105, state: 'running', step: 'running test suite', at: at(-1 * min), intentAt: at(-2 * min) },
        evidence: [passedEvidence('integration:demo-105', sha105, -3 * min)],
        lastAssignment: { owner: 'builder-1', epoch: 1, runtime: 'Claude' },
        reasons: { merge: ['Merge trial in progress'] },
      });
    }
    if (phase === 'merged') {
      return makeItem(105, 'Export monthly invoices as CSV', {
        ...base,
        stage: 'done',
        stageEnteredAt: at(-1 * min),
        submission: { epoch: 1, pr: 88 },
        candidate: makeObservation(88, sha105, -1 * min, { opened: -20 * min }).candidate,
        observation: makeObservation(88, sha105, -1 * min, {
          opened: -20 * min,
          merged: true,
          reviews: [{ reviewer: 'reviewer-codex', sha: sha105, state: 'APPROVED', id: 905, submittedAt: at(-5 * min) }],
        }),
        delivery: { mergedAt: at(-1 * min), mergeSha: sha('8'), authorizationRevision: 1 },
        pipeline: { submittedAt: at(-8 * min), attempts: [{ epoch: 1, claimedAt: at(-20 * min) }] },
        evidence: [passedEvidence('integration:demo-105', sha105, -5 * min)],
        lastAssignment: { owner: 'builder-1', epoch: 1, runtime: 'Claude' },
        reasons: {},
      });
    }
    // live
    return makeItem(105, 'Export monthly invoices as CSV', {
      ...base,
      stage: 'done',
      stageEnteredAt: at(-1 * min),
      submission: { epoch: 1, pr: 88 },
      candidate: makeObservation(88, sha105, -1 * min, { opened: -22 * min }).candidate,
      observation: makeObservation(88, sha105, -1 * min, {
        opened: -22 * min,
        merged: true,
        reviews: [{ reviewer: 'reviewer-codex', sha: sha105, state: 'APPROVED', id: 905, submittedAt: at(-6 * min) }],
      }),
      delivery: { mergedAt: at(-2 * min), mergeSha: sha('9'), authorizationRevision: 1 },
      releaseDeliveries: [{ environment: 'production', verifiedAt: at(-30_000), releaseId: 'rel-88', releaseRevision: 1, generation: 1 }],
      pipeline: { submittedAt: at(-10 * min), attempts: [{ epoch: 1, claimedAt: at(-22 * min) }] },
      evidence: [passedEvidence('integration:demo-105', sha105, -6 * min)],
      lastAssignment: { owner: 'builder-1', epoch: 1, runtime: 'Claude' },
      reasons: {},
    });
  };

  // A healthy line (GY-3962): sixteen more changes merged and live over the last six hours, so Work
  // reads 3 merges an hour; they sit under their own goal, below the one the captures follow.
  const polish = ['Show stock levels on product cards', 'Remember the last shipping address', 'Sort orders by newest first', 'Add alt text to product photos',
    'Cache category pages for five minutes', 'Fix the cart badge count after removal', 'Trim whitespace in coupon codes', 'Show delivery estimates at checkout',
    'Link order emails to the order page', 'Keep filters when paging results', 'Round prices the same way everywhere', 'Explain why a card was declined',
    'Lazy-load images below the fold', 'Add a print view for receipts', 'Hide sold-out sizes by default', 'Speed up the account page'].map((title, n) => {
    const merged = -(34 + n * 19) * min, head = sha(String.fromCharCode(102 + n));
    return makeItem(110 + n, title, {
      goal: 'Storefront polish', stage: 'done', stageEnteredAt: at(merged),
      submission: { epoch: 1, pr: 60 + n },
      candidate: makeObservation(60 + n, head, merged).candidate,
      observation: makeObservation(60 + n, head, merged, { merged: true }),
      delivery: { mergedAt: at(merged), mergeSha: sha(String((n % 9) + 1)), authorizationRevision: 1 },
      releaseDeliveries: [{ environment: 'production', verifiedAt: at(merged + 4 * min), releaseId: `rel-${60 + n}`, releaseRevision: 1, generation: 1 }],
      pipeline: { submittedAt: at(merged - 14 * min), attempts: [{ epoch: 1, claimedAt: at(merged - 30 * min) }] },
      lastAssignment: { owner: `builder-${(n % 3) + 1}`, epoch: 1, runtime: n % 2 ? 'Codex' : 'Claude' },
      reasons: {},
    });
  });
  const work = heroPhase === 'before-create'
    ? [item104, item103, item102, item101, ...polish]
    : [makeItem105(heroPhase), item104, item103, item102, item101, ...polish];

  const movingEntries = [];
  if (heroPhase === 'static' || heroPhase === 'build') {
    movingEntries.push({ id: work[0].id, key: 'DEMO-105', group: 'moving', who: 'Tilly', does: 'Writing code and tests', since: at(-6 * min) });
  } else if (heroPhase === 'review') {
    movingEntries.push({ id: work[0].id, key: 'DEMO-105', group: 'moving', who: 'Reviewer', does: 'In review · waiting for the reviewer', since: at(-3 * min) });
  } else if (heroPhase === 'test') {
    movingEntries.push({ id: work[0].id, key: 'DEMO-105', group: 'moving', who: 'Merge queue', does: 'Testing · being tested before it merges', since: at(-2 * min), queue: true });
  }
  movingEntries.push(
    { id: item104.id, key: 'DEMO-104', group: 'moving', who: 'Reviewer', does: 'In review · waiting for the reviewer', since: at(-9 * min) },
    { id: item103.id, key: 'DEMO-103', group: 'moving', who: 'Merge queue', does: 'Testing · being tested before it merges', since: at(-4 * min), queue: true },
  );

  const board = {
    groups: {
      'needs-you': [],
      blocked: [],
      moving: movingEntries,
      'up-next': [],
      backlog: [],
    },
  };

  const humanOnly = [
    {
      id: '00000000-0000-4000-8000-000000000106',
      key: 'DEMO-106',
      title: 'Add a second test machine for merge trials',
      work: 'DEMO-106',
      waitedMs: 14 * min,
      rule: 'human-request',
      decision: 'Money or accounts',
      refusal: 'Only the owner decides spending.',
      request: {
        id: 'hr-demo-106',
        kind: 'money-or-accounts',
        ask: 'Approve adding one dedicated test machine (~$65/month) to keep merge-trial wait under 3 minutes?',
        recommendation: 'Approve — test queue peaked at 8 minutes this morning.',
        needed: 'A yes or no on one more test machine.',
        reason: 'Merge trials queued up to 8 minutes this morning.',
        requestedBy: 'Lead',
        at: at(-14 * min),
      },
      choices: [
        { label: 'Approve spend', input: 'none', recommended: true, body: { decision: 'approve' } },
        { label: 'Keep current machines', input: 'none', recommended: false, body: { decision: 'decline' } },
      ],
      answer: { cli: 'mainworks answer DEMO-106 "yes"', decline: 'mainworks answer DEMO-106 --decline', dashboard: 'Work → Needs you → Answer', api: 'POST /api/work/DEMO-106/answer', post: { command: 'answer', body: { request: 'hr-demo-106', outcome: 'provided' }, field: 'answer', submit: 'Answer and resume DEMO-106' } },
    },
  ];

  const liveWaiting = heroPhase === 'merged' ? ['DEMO-105'] : [];

  const status = {
    actor: { id: 'owner', role: 'admin', sessionKind: 'human' },
    github: true,
    reviewProviders: ['github'],
    repository: 'acme/storefront',
    baseBranch: 'main',
    jobs: [],
    live: { commit: sha('9'), waiting: liveWaiting },
    app: { deployedAt: at(-4 * min) },
    pipelineTime: { median: 24 },
    humanOnly,
    // The header: agents working are the live sessions above plus the Lead's pane; checks running are the rows testing.
    checksRunning: work.filter((item) => item.stage === 'test').length,
    setup: { loop: true, panes: { master: '1' } },
    // The Setup capture: the writing account is connected, the reviewing one not yet.
    ...(heroPhase === 'setup' ? {
      serving: { onboarding: { onboarded: true } },
      fleet: {
        roles: [{ role: 'worker', accounts: ['claude-demo'] }, { role: 'reviewer', accounts: [] }],
        accounts: [{ name: 'claude-demo', enabled: true, loggedIn: true, eligible: true, roles: [{ role: 'worker' }] }],
      },
    } : {}),
    delegation: {
      limits: { maxLeads: 3, minReviewers: 1, maxReviewers: 2 },
      slices: [
        { id: 'product', name: 'Product', lead: null, workers: [], bottlenecks: [] },
        { id: 'infrastructure', name: 'Infrastructure', lead: null, workers: [], bottlenecks: [] },
      ],
      reviewers: [],
    },
  };

  const flow = {
    ageSeconds: 12,
    '24h': {
      attemptsPerHour: 3.4,
      firstPassYield: 0.74,
      trials: 19,
      flakyRate: 0.05,
      revertRate: 0.0,
      stations: {
        build: { median: 11, p90: 19, oldest: { key: 'DEMO-105', minutes: 6 } },
        review: { median: 4, p90: 8, oldest: { key: 'DEMO-104', minutes: 9 } },
        trial: { median: 5, p90: 7, oldest: { key: 'DEMO-103', minutes: 4 } },
      },
      rework: { review: 2, trial: 1 },
    },
  };

  const item103Timings = {
    releasedAt: at(-24 * min),
    checkout: '/srv/acme-storefront',
    trial: {
      head: sha103,
      startedAt: at(-4 * min),
      finishedAt: null,
      durationMs: 4 * min,
      soFar: true,
      steps: [
        { step: 'build', result: 'passed', durationMs: 14_000 },
        { step: 'typecheck', result: 'passed', durationMs: 8_000 },
        { step: 'tests', result: 'passed', durationMs: 162_000 },
        { step: 'e2e:smoke', result: 'running', durationMs: 36_000 },
      ],
      groups: [
        { name: 'tests', passed: 42, failed: 0, total: 42 },
        { name: 'e2e', passed: 4, failed: 0, total: 6 },
      ],
    },
  };

  const item103Diff = {
    files: [
      { path: 'src/auth/rate-limit.ts', additions: 62, deletions: 4 },
      { path: 'src/routes/login.ts', additions: 14, deletions: 8 },
      { path: 'tests/login-rate-limit.test.ts', additions: 18, deletions: 0 },
    ],
  };

  const leadEvents = [
    {
      seq: '204',
      kind: 'priority',
      actor: 'master-lead',
      work_id: item103.id,
      created_at: at(-26 * min),
      details: { priority: 1, previous: 2, reason: 'Moved login rate limiting ahead of dark mode as requested.' },
    },
    {
      seq: '205',
      kind: 'requirements',
      actor: 'master-lead',
      work_id: work[0].id,
      created_at: at(-18 * min),
      details: { reason: 'Turned the CSV export goal into 3 checkable criteria with bound tests and released it to builder Tilly.' },
    },
  ];

  const typed = [
    { who: 'You', at: at(-30 * min), text: 'Prioritize login rate limiting before dark mode.' },
  ];

  if (heroPhase === 'empty') {
    // A fresh install's first run: nothing filed, nothing waiting, no flow yet.
    return {
      work: [], board: { groups: { 'needs-you': [], blocked: [], moving: [], 'up-next': [], backlog: [] } },
      status: { ...status, humanOnly: [], checksRunning: 0, live: { commit: null, waiting: [] } },
      flow: null, item103, item103Timings, item103Diff, leadEvents: [], typed: [],
    };
  }
  return { work, board, status, flow, item103, item103Timings, item103Diff, leadEvents, typed };
}

/** What the demo control plane answers on GET /api/ROUTE: scripts/demo-server.mjs and the browser cases serve it. */
export function demoAnswer(state, route, search = new URLSearchParams()) {
  if (route === 'status') return state.status;
  if (route === 'work-snapshot') return { work: state.work, jobs: [], now: at(0) };
  if (route === 'board') return state.board;
  if (route === 'flow') return state.flow;
  if (route === 'work') return state.work;
  if (route === `work/${state.item103.id}/timings`) return state.item103Timings;
  if (route === `work/${state.item103.id}/diff`) return state.item103Diff;
  if (route.startsWith('work/') && route.endsWith('/timings')) return { releasedAt: at(-10 * min), checkout: '/srv/acme-storefront', trial: null };
  if (route.startsWith('work/') && route.endsWith('/diff')) return { files: [] };
  if (route.startsWith('work/')) return state.work.find((w) => w.id === route.slice('work/'.length)) ?? state.work[0];
  if (route === 'costs') return { builder: { model: 'claude-sonnet-4-6', accountModel: 'claude-sonnet-4-6', differs: false } };
  // One task's history holds its own decisions only.
  if (route === 'events') return search.get('work') ? state.leadEvents.filter((row) => row.work_id === search.get('work')) : state.leadEvents;
  if (route === 'typed-input') return { typed: state.typed };
  if (route === 'team-access') return { teammates: [] };
  if (route === 'master/messages') return { messages: [] };
  if (route === 'delivery') return { environments: [], releases: [], rollbacks: [], now: at(0) };
  if (route.startsWith('validation')) return { requests: [], candidates: [], nextCursor: null };
  return [];
}
