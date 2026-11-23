import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';
import { friendlyName } from '../web/fun';

// GY-3599: the Task page shows the evidence. A task whose merge trial failed on one slow file opens on its
// title, state, pull request, Builder, model, diff stats and one action; a pipeline row says where the
// time went; tabs hold the checks and diff, the Builder's read-only session, the Lead's decisions and the details.
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const head = 'a'.repeat(40), base = 'b'.repeat(40), merge = 'c'.repeat(40), run = '11111111-2222-4333-8444-555555555555';
const builder = 'claude-builder-7', slow = 'tests/remote-shards.test.ts';
const output = `trial failed: ${slow}\n  ✓ a hot local host keeps its room (412 ms)\n  × a remote host with a hot reading gets no shard\n    a CPU sensor reads 96C, at or over 85C`;
const candidate = { sha: head, baseSha: base, pr: 412, branch: 'graphyard/gy-3588-3', author: builder };
const item = {
  dependencies: [], scenarioRequirements: [], id: 'w-3588', key: 'GY-3588', title: 'Trials stop running one test group at a time when hot',
  why: 'A hot reading made every trial slow.', description: 'The launcher already waits on heat per container.', type: 'feature', priority: 1,
  stage: 'test', stageEnteredAt: at(21), ready: true, epoch: 3, lease: null, owner: builder, lastAssignment: { owner: builder, epoch: 3, claimedAt: at(41) },
  policy: { review: true, checks: ['test'] }, policyRevision: 1, revision: 9, violations: [], blocker: null, reworkRequested: false,
  workspaces: [{ host: 'vish-msi', path: '/work/gy-3588', branch: candidate.branch, epoch: 3, owner: builder }],
  submission: { epoch: 3, pr: 412 }, candidate,
  observation: { candidate, checks: [], reviews: [{ reviewer: 'otis-reviewer', sha: head, state: 'APPROVED', submittedAt: at(26) }], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/merge-writer/remote-shards.ts', slow, 'e2e/cases/verification-uses-remote-hosts.json'], at: at(30), baseTip: base, mergeBase: base },
  criteria: [{ id: 'AC-1', text: 'A hot local host keeps its room', proofs: ['unit:remote-shards'] }], evidence: [],
  gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] },
    { name: 'test', passed: false, reasons: [`trial failed: ${slow}`] }, { name: 'merge', passed: false, reasons: ['The merge writer refused this head'] }],
  pipeline: { attempts: [{ epoch: 3, owner: builder, claimedAt: at(41), endedAt: at(30), end: 'submitted' }], submittedAt: at(30), resubmittedAt: at(30), reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
  mergeLedger: { key: 'GY-3588', state: 'refused', head, baseTip: base, mergeSha: merge, risk: 'normal', intentAt: at(21), pushedAt: null, observedTip: null, refusal: { kind: 'merge', reason: output }, events: 3 },
  sessions: [{ id: `${builder}:3`, kind: 'implementation', principal: builder, epoch: 3, runtime: 'claude', host: 'vish-msi', transcript: `run:${run}`, subject: 'GY-3588', state: 'running', observed: 'working', observedAt: at(0), startedAt: at(41), updatedAt: at(0), seenAt: at(0) }],
  createdAt: at(60), updatedAt: at(0),
};
const timings = { releasedAt: at(41), checkout: '/srv/mainworks/checkout', trial: { head, startedAt: at(21), finishedAt: at(2) as string | null, durationMs: 19 * 60_000, output: null as string | null,
  steps: [{ step: 'checkout', durationMs: 20_000, result: 'passed' }, { step: 'install', durationMs: 60_000, result: 'passed' }, { step: 'build', durationMs: 40_000, result: 'passed' }, { step: 'tests', durationMs: 17 * 60_000, result: 'failed' }],
  groups: [{ name: 'tests', passed: 39, failed: 1, total: 40 }, { name: 'e2e', passed: 2, failed: 0, total: 2 }], slowest: { file: slow, durationMs: 14 * 60_000 } as { file: string; durationMs: number } | null, soFar: false } };
const files = [{ path: 'src/merge-writer/remote-shards.ts', additions: 9, deletions: 4 }, { path: slow, additions: 77, deletions: 0 }, { path: 'e2e/cases/verification-uses-remote-hosts.json', additions: 0, deletions: 27 }];
const patch = '@@ -1,2 +1,3 @@\n-const usable = host => underHeatLimit(host.reading);\n+// This machine\'s launcher already waits on heat per container.\n+const usable = host => host === hosts[0] || underHeatLimit(host.reading);';
const events = [
  { seq: 3, kind: 'message', actor: 'graphyard-master-project', created_at: at(35), payload: { details: { text: 'Keep the local host in placement.' } } },
  { seq: 2, kind: 'claim', actor: builder, created_at: at(41), payload: {} },
  { seq: 1, kind: 'ready', actor: 'graphyard-master-project', created_at: at(41), payload: { details: { reason: 'Hotfix for the trial bottleneck' } } },
];

async function open(page: Page, width: number, task: typeof item = item, trialTimings: Omit<typeof timings, 'trial'> & { trial: typeof timings.trial | null } = timings) {
  const writes: string[] = [];
  let log = { run: { account: 'claude-a', kind: 'claude' }, lines: [{ at: at(1), stream: 'stdout', text: '$ npm run test:affected -- tests/remote-shards.test.ts' }], cursor: 1, ended: false };
  page.on('websocket', socket => writes.push(`websocket ${socket.url()}`));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() !== 'GET') { writes.push(`${request.method()} ${path}`); return route.fulfill({ json: {} }); }
    const now = new Date().toISOString();
    if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'operator', role: 'admin', sessionKind: 'human' }, repository: 'fixture/repository', jobs: [], pipelineTime: { merged24h: 31, median: 29, p90: 95, samples: 10, lastMergeAt: at(12), oldest: null } } });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work: [task], now } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus([task] as never, Date.parse(now), null) });
    if (path.endsWith('/events')) return route.fulfill({ json: events });
    if (path.endsWith('/costs')) return route.fulfill({ json: { builder: { account: 'claude-a', model: 'claude-opus-5-5', accountModel: 'claude-sonnet-5-5', differs: true } } });
    if (path.endsWith('/w-3588/timings')) return route.fulfill({ json: trialTimings });
    if (path.endsWith('/w-3588/diff')) return route.fulfill({ json: url.searchParams.get('path') ? { diff: patch } : { files } });
    if (path.endsWith(`/runs/${run}/log`)) return route.fulfill({ json: Number(url.searchParams.get('cursor')) ? { ...log, lines: [] } : log });
    return route.fulfill({ json: [] });
  });
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/?sign-in#GY-3588');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.locator('article.item-page')).toBeVisible();
  writes.length = 0;
  return { writes, end: () => { log = { ...log, ended: true }; } };
}
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const width of [1280, 390]) {
  test(`e2e:task-shows-evidence — at ${width}px the header, the pipeline row and each tab show the task's evidence, and the live session is read-only`, async ({ page }) => {
    const { writes, end } = await open(page, width);
    const task = page.locator('article.item-page'), header = task.locator('.task-header');

    // AC-1: title, state with time in state, pull request, Builder, model with its mark, diff stats, one action, key and commit small.
    await expect(header.getByRole('heading', { level: 1 })).toHaveText(item.title);
    // Its time in state counts from when the trial failed, two minutes ago, not from when the change was handed in; the badge says it is stuck.
    await expect(header.locator('[data-task-state]')).toHaveText(/^Stuck\s*Test merge failed · 2m$/);
    await expect(header.getByRole('link', { name: /PR #412/ })).toHaveAttribute('href', 'https://github.com/fixture/repository/pull/412');
    await expect(header.locator('[data-builder]')).toHaveText(`Builder ${friendlyName(builder)}`);
    const model = header.locator('[data-model]');
    await expect(model).toContainText('claude-opus-5-5');
    await expect(model).toHaveAttribute('data-model', 'differs');
    await expect(model).toContainText('not the account\'s claude-sonnet-5-5');
    await expect(header.locator('[data-diff-stats]')).toHaveText('+86 −31 · 3 files');
    await expect(header.getByRole('button')).toHaveCount(1);
    await expect(header.getByRole('button', { name: 'Hold task' })).toBeVisible();
    const small = header.locator('[data-task-ids]');
    await expect(small).toHaveText(`GY-3588 · ${head.slice(0, 8)}`);
    expect(await small.evaluate(element => parseFloat(getComputedStyle(element).fontSize) < parseFloat(getComputedStyle(document.querySelector('.task-header h1')!).fontSize))).toBe(true);
    // Stuck: one sentence why, one on what happens next.
    // The why gives the counts; the failing output is shown once, under Checks.
    await expect(task.locator('[data-stuck-why]')).toHaveText('Why: Its merge trial failed: 1 of 40 test files failed.');
    await expect(task.locator('[data-stuck-next]')).toHaveText(/^Next: It goes back to a Builder/);
    for (const part of [header.getByRole('heading', { level: 1 }), header.locator('[data-task-state]'), header.getByRole('link', { name: /PR #412/ }), header.locator('[data-builder]'), model, header.locator('[data-diff-stats]'), small, task.locator('[data-stuck-why]'), task.locator('[data-stuck-next]')])
      await expect(part).toBeVisible();

    // AC-2: each stage with this task's time in it, the total beside the median, the trial's counts and its slowest file.
    const pipeline = task.getByRole('region', { name: 'Pipeline' });
    await expect(pipeline.locator('[data-pipeline-total]')).toHaveText('This task 41 min so far · median 29 min');
    await expect(pipeline.locator('[data-stage]')).toHaveText([/^Built\s*11 min$/, /^Reviewed\s*4 min$/, /^Queued\s*5 min$/, /^Test merge\s*19 min/, /^Ship/]);
    const trial = pipeline.locator('[data-stage="trial"]');
    await expect(trial).toContainText('tests 39/40');
    await expect(trial).toContainText('e2e 2/2');
    await expect(trial).toContainText(`slowest: ${slow} 14 min`);
    await expect(trial).not.toContainText('So far'); // a finished trial's counts are final

    // AC-3: Checks and diff is the default tab.
    const tabs = task.getByRole('tablist', { name: 'Task evidence' });
    await expect(tabs.getByRole('tab')).toHaveText(['Checks and diff', 'Live session', 'Lead', 'Details']);
    await expect(tabs.getByRole('tab', { name: 'Checks and diff' })).toHaveAttribute('aria-selected', 'true');
    const checks = task.getByRole('region', { name: 'Checks' });
    await expect(checks.locator('[data-check]')).toHaveText([/checkout.*passed.*20 s/, /install.*passed.*1 min/, /build.*passed.*40 s/, /tests.*failed.*17 min/]);
    await expect(checks.getByLabel('Test output')).toContainText('a CPU sensor reads 96C, at or over 85C');
    const diff = task.getByRole('region', { name: 'Changed files' });
    await expect(diff.locator('[data-file]')).toHaveText([/src\/merge-writer\/remote-shards\.ts\s*\+9\s*−4/, /tests\/remote-shards\.test\.ts\s*\+77\s*−0/, /verification-uses-remote-hosts\.json\s*\+0\s*−27/]);
    await expect(diff.locator('pre')).toHaveCount(0);
    await diff.getByRole('button', { name: /src\/merge-writer\/remote-shards\.ts/ }).click();
    await expect(diff.locator('pre')).toContainText('+const usable = host => host === hosts[0] || underHeatLimit(host.reading);');
    expect(await noSideScroll(page)).toBe(true);

    // Live session: the Builder's output, live, and nothing typed is sent anywhere.
    await tabs.getByRole('tab', { name: 'Live session' }).click();
    const session = task.getByRole('tabpanel', { name: 'Live session' });
    const terminal = session.getByLabel('Session output');
    await expect(terminal).toContainText('npm run test:affected -- tests/remote-shards.test.ts');
    await expect(session).toContainText(`${friendlyName(builder)}'s session on vish-msi, read-only.`);
    await expect(session.locator('.live-run-state')).toHaveText(/following the output/);
    await expect(session.locator('input, textarea, [contenteditable]')).toHaveCount(0);
    await terminal.click();
    await page.keyboard.type('rm -rf /\n');
    await page.waitForTimeout(500);
    expect(writes, 'typing into the live session sends nothing').toEqual([]);
    // Its saved output once the session has ended.
    end();
    await expect(session.locator('.live-run-state')).toHaveText(/the run has ended/, { timeout: 15_000 });
    await expect(terminal).toContainText('npm run test:affected');
    expect(await noSideScroll(page)).toBe(true);

    // Lead: the Lead's decisions on this task, not the Builder's steps.
    await tabs.getByRole('tab', { name: 'Lead' }).click();
    const lead = task.getByRole('tabpanel', { name: 'Lead' });
    await expect(lead.locator('[data-decision]')).toHaveText([/Master messaged the builder.*Keep the local host in placement\./, /Released for work.*Hotfix for the trial bottleneck/]);
    await expect(lead).not.toContainText('Picked up by a builder');
    expect(await noSideScroll(page)).toBe(true);

    // Details: ids, epochs, criteria and proofs.
    await tabs.getByRole('tab', { name: 'Details' }).click();
    const details = task.getByRole('tabpanel', { name: 'Details' });
    await expect(details).toContainText('A hot local host keeps its room');
    await expect(details).toContainText('unit:remote-shards');
    await expect(details).toContainText('w-3588');
    await expect(details).toContainText('assignment 3');
    // Nothing twice: the Lead's decisions are not listed again, and no fold here is called Details.
    await expect(details.locator('.activity-list')).toHaveCount(0);
    await expect(details.locator('summary', { hasText: /^Details$/ })).toHaveCount(0);
    expect(await noSideScroll(page)).toBe(true);

    // The footer: follow the log, check the branch out.
    const footer = task.locator('.task-commands');
    await expect(footer.locator('code')).toHaveText([`tail -f .graphyard/worker-runs/${run}/log.jsonl`, 'git fetch origin graphyard/gy-3588-3 && git checkout FETCH_HEAD']);
    await expect(footer).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    expect(writes).toEqual([]);
  });
}

// A refusal that is not a failed trial, such as the hold of a trial that passed ahead of review, never reads as a failed trial.
test('e2e:task-shows-evidence — a trial that passed ahead of review is not shown as failed', async ({ page }) => {
  const held = { ...item, mergeLedger: { ...item.mergeLedger, refusal: { kind: 'merge', reason: 'trial passed ahead of review: the trial that passed is kept and the head lands once the same head is approved' } } };
  await open(page, 1280, held, { ...timings, trial: { ...timings.trial, steps: timings.trial.steps.map(step => ({ ...step, result: 'passed' })) } });
  const task = page.locator('article.item-page');
  await expect(task.locator('[data-task-state]')).not.toContainText('Test merge failed');
  await expect(task.locator('[data-stage="trial"]')).not.toHaveAttribute('data-state', 'failed');
  await expect(task.getByText(/It goes back to a Builder/)).toHaveCount(0);
  await expect(task.getByLabel('Test output')).toHaveCount(0);
});

// A running trial shows the output of the tests that ran so far, the counts so far and the slowest file so far; its time in state is its Work row's number.
test('e2e:task-shows-evidence — a running trial shows its test output, counts and slowest file so far', async ({ page }) => {
  const running = { ...item, mergeLedger: { ...item.mergeLedger, state: 'intent', refusal: null }, gates: item.gates.map(gate => ({ ...gate, passed: gate.name !== 'test' && gate.name !== 'merge', reasons: [] })) };
  const sofar = `$ node --test (shard 2)\nnot ok 3 - ${slow}\n  a CPU sensor reads 96C, at or over 85C`;
  await open(page, 390, running as unknown as typeof item, { ...timings, trial: { ...timings.trial, finishedAt: null, groups: [{ name: 'tests', passed: 12, failed: 0, total: 40 }], slowest: { file: 'tests/shard-hosts.test.ts', durationMs: 4 * 60_000 }, soFar: true, output: sofar,
    steps: [...timings.trial.steps.slice(0, 3), { step: 'tests', durationMs: 17 * 60_000, result: 'running' }] } });
  const task = page.locator('article.item-page');
  await expect(task.locator('[data-task-state]')).not.toContainText('Test merge failed');
  await expect(task.locator('[data-task-state]')).toHaveText(/^Moving Testing · 30m$/);
  const checks = task.getByRole('region', { name: 'Checks' });
  await expect(checks.locator('[data-check="tests"]')).toHaveText(/tests.*running.*17 min/);
  await expect(checks.getByLabel('Test output')).toHaveText(sofar);
  const trial = task.locator('[data-stage="trial"]');
  await expect(trial).toContainText('So far: tests 12/40');
  await expect(trial).toContainText('slowest: tests/shard-hosts.test.ts 4 min');
  expect(await noSideScroll(page)).toBe(true);
});

// AC-1: a failed trial the Lead has already sent back is no longer what holds the task. The failing counts stay as the why;
// the state, its time and the next step are the task's own, as its Work row reads them.
for (const width of [1280, 390]) {
  test(`e2e:task-shows-evidence — at ${width}px a failed trial the Lead has sent back shows the task's real state, time and next step`, async ({ page }) => {
    const sentBack = { ...item, stage: 'build', stageEnteredAt: at(12), lease: null, reworkRequested: true,
      lastRework: { reason: `trial failed: ${slow}`, binding: `${head}:merge-writer-trial-failed`, at: at(12) }, pipeline: { ...item.pipeline, reworkRounds: 1 },
      sessions: [{ ...item.sessions[0]!, state: 'ended', observed: 'ended', endedAt: at(12), updatedAt: at(12) }] };
    await open(page, width, sentBack as unknown as typeof item);
    const task = page.locator('article.item-page');
    await expect(task.locator('[data-task-state]')).toHaveText(/^Up next\s*Waiting · 12m$/);
    await expect(task.locator('[data-stuck-why]')).toHaveText('Why: Its merge trial failed: 1 of 40 test files failed.');
    await expect(task.locator('[data-stuck-next]')).toHaveText(/^Next: Mainworks \(assigns a builder\) — Hands it to the next free builder agent$/);
    await expect(task.getByText(/It goes back to a Builder/)).toHaveCount(0);
    // The trial's failure stays on the record: its stage, its counts and its output.
    await expect(task.locator('[data-stage="trial"]')).toHaveAttribute('data-state', 'failed');
    await expect(task.locator('[data-stage="trial"]')).toContainText('tests 39/40');
    await expect(task.getByLabel('Test output')).toContainText('a CPU sensor reads 96C, at or over 85C');
    expect(await noSideScroll(page)).toBe(true);
  });
}

// A task released and waiting for a Builder has a time in state too, counted from where its Work row counts it.
test('e2e:task-shows-evidence — a released task waiting for a Builder shows how long it has waited', async ({ page }) => {
  const waiting = { ...item, stage: 'build', stageEnteredAt: at(41), lease: null, owner: null, lastAssignment: null, candidate: null, submission: null, observation: null, sessions: [], mergeLedger: null,
    workspaces: [], pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } } };
  await open(page, 390, waiting as unknown as typeof item, { ...timings, trial: null });
  const task = page.locator('article.item-page');
  await expect(task.locator('[data-task-state]')).toHaveText(/^Up next\s*Waiting · 41m$/);
  await expect(task.locator('.task-commands')).toHaveCount(0);
  expect(await noSideScroll(page)).toBe(true);
});

// A moving task past the bound says so in its header, in the words and shape its Work row uses (GY-108).
test('e2e:task-shows-evidence — a moving task held past the bound is marked overdue in its header', async ({ page }) => {
  // A trial that passed and waits for its review: nothing failed, the task has simply been handed in for 31 minutes.
  const late = { ...item, mergeLedger: { ...item.mergeLedger, refusal: { kind: 'merge', reason: 'trial passed ahead of review: the trial that passed is kept and the head lands once the same head is approved' } },
    pipeline: { ...item.pipeline, submittedAt: at(31), resubmittedAt: at(31) } };
  await open(page, 390, late, { ...timings, trial: { ...timings.trial, steps: timings.trial.steps.map(step => ({ ...step, result: 'passed' })) } });
  const state = page.locator('article.item-page [data-task-state]');
  await expect(state).toHaveText(/^Moving Testing · ▲ 31m overdue$/);
  expect(await state.locator('.status-age.overdue').count()).toBe(1);
  expect(await noSideScroll(page)).toBe(true);
});

// AC-3: a change the control plane observed itself is never pushed, so no fetch can reach its head: it is checked out by its commit into a worktree of the install's checkout under /tmp, whose own files stay as they are.
test('e2e:task-shows-evidence — a change the control plane observed itself is checked out by its commit from the install\'s checkout, never fetched', async ({ page }) => {
  const observed = { ...item, candidate: { ...candidate, pr: 0 }, submission: { epoch: 3, pr: 0 },
    observation: { ...item.observation, source: 'control-plane', candidate: { ...candidate, pr: 0 } } };
  await open(page, 390, observed as unknown as typeof item);
  const task = page.locator('article.item-page');
  await expect(task.locator('.task-header').getByRole('link', { name: new RegExp(`${head.slice(0, 8)}, open commit for GY-3588 in GitHub`) })).toHaveAttribute('href', `https://github.com/fixture/repository/commit/${head}`);
  await expect(task.locator('.task-header').getByRole('link', { name: /PR #/ })).toHaveCount(0);
  await expect(task.locator('.task-commands code')).toHaveText([`tail -f .graphyard/worker-runs/${run}/log.jsonl`, `git -C /srv/mainworks/checkout worktree add /tmp/GY-3588 ${head}`]);
  expect(await noSideScroll(page)).toBe(true);
});
