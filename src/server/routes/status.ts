import { newestCaretakerReport } from './caretaker.js';
import { pendingWorkerVerifications } from '../worker-verification-queue.js';
import { readWorkReplay } from '../work-replay.js';
import { z } from 'zod';
import { demand, type Work } from '../../model.js';
import type { IntegrationJob } from '../../coordination.js';
import { parseEventHistoryQuery, readEventHistory } from '../../events-history.js';
import { delegationSnapshot } from '../../delegation.js';
import { loopAlerts, loopAlertsHeader, loopCheckoutTrust, loopCheckoutTrustHeader, loopCpu, loopCpuHeader, loopHosts, loopHostsHeader, loopSessions, loopSessionsHeader, loopFetchRefusalHeader, loopStallAlarmHeader, loopStepFailureHeader, loopSupervision, loopSupervisionHeader, loopWorkerGrowthHeader, loopPresenceHeader, loopPresenceInterval, loopPanes, loopPanesHeader, loopPanesRegistry, loopRegistry, reportedLoopMerger } from '../../model/loop-presence.js';
import { loopWhere, loopWhereHeader, loopWhereRegistry } from '../../model/where-things-run.js';
import { releaseInfo, schemaVersion } from '../../release.js';
import { databaseBoundWarning, readDatabaseCapacity } from '../plane-health.js';
import { openHumanOnly } from '../../model/human-request.js';
import { humanOnlySubjects } from '../waits.js';
import { defineRoutes } from '../routes.js';
import { coordinationSnapshot, coordinationViewHeader } from '../work-view.js';
import { executorHost } from './agent-registry.js';
import { projectDelivery } from '../../model-boundary/project-applications.js';
import { repositoryPolicy } from '../../model-boundary/repository-policy.js';
import { productionEnvironmentFromEnv } from '../../production-environment.js';
import { liveRelease, managedDeploy, readDeployHistory, repositoryToplevel, servingReport } from '../../deploy-watch.js';
import { mainworksRepository } from '../../scenarios.js';
import { gitRunnerFor } from '../../merge-writer/local-observation.js';
import { boardFromStatus } from '../../model/board.js';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { appRelease } from '../../app-url.js';
import { thisWeekReport } from '../../project-memory.js';
import { currentMergeStep } from '../../model/merge-ledger.js';
import { codeSizeSummary, gateRecordPath, readGateRecord } from '../../batch-gate.js';
import { boundedSnapshot, workDocument } from '../../store/bounded-snapshot.js';
import { snapshotPage } from '../../store/paged-snapshot.js';
import { pipelineItems, pipelineTime } from '../../pipeline-speed.js';
import { releaseCheckSince } from '../../model/incidents.js';
import { readFlow, sharedFlow, sharedNotMoving } from '../flow.js';
import { boundedHistoryRead } from '../history-reads.js';
import { longestLockHold, slowestQuery } from '../../store/slow-queries.js';
import { publicLinkOff } from './team-access.js';
import { checkInOwner } from '../../store/check-in-owner.js';
import { setting } from '../../setting.js';


/** Control-plane status and the work reads every client polls. */

export const statusRoutes = defineRoutes('status', [
  { method: 'GET', path: '/api/work-replay', async handle({ services, url, operatorVisible }) {
    const hours = Number(url.searchParams.get('hours') ?? 24);
    demand(hours === 24 || hours === 72, 'Replay window must be 24 or 72 hours', 400);
    const replay = await readWorkReplay(services.engine.store.pool, hours);
    return { ...replay, items: operatorVisible(replay.items) };
  } },
  // GY-3624: the flow numbers, for master status and the Work page; /api/status does not carry them (GY-3677).
  // GY-3763: computed at most once a minute and served from memory with its age.
  ...((computeFlow) => [
    { method: 'GET' as const, path: '/api/flow', handle: ({ services, operatorVisible }: any) => sharedFlow(services.engine.store, Date.now(), now => computeFlow(services, now), operatorVisible) },
    { method: 'GET' as const, path: '/api/not-moving', handle: ({ services, operatorVisible }: any) => sharedNotMoving(services.engine.store, Date.now(), now => computeFlow(services, now), operatorVisible) },
  ])(async (services: any, now: number) => {
    const { engine, repository } = services;
    const runner = engine.gitRunner === undefined ? engine.gitRunner = gitRunnerFor(setting('REPOSITORY_ROOT') ?? process.cwd()) : engine.gitRunner;
    const servingRoot = setting('REPOSITORY_ROOT')?.trim() ? resolve(setting('REPOSITORY_ROOT')!) : repositoryToplevel(process.cwd());
    const read = runner ? async (args: readonly string[]) => { const result = await runner(args); if (result.status !== 0) throw new Error(result.stderr); return result.stdout; } : null;
    const deploys = servingRoot ? readDeployHistory(servingRoot, repository ?? null) : [];
    const work = await engine.store.fleet();
    return { at: now, work, flow: await readFlow(engine.store.pool, work, now, { deploys, git: read, releaseFlakes: servingRoot ? readGateRecord(gateRecordPath(servingRoot))?.flakes : [] }) };
  }),
  // GY-3757: the slowest database query of the last 10 minutes when it ran past 3 s, for master status; `name` keeps the queries whose name starts with it.
  // GY-3799: with the longest coordination-lock hold of the last 10 minutes, 1 s or more.
  // GY-4005: the line /healthz shows once the database passes 80% of its bound, for master status.
  { method: 'GET', path: '/api/database-bound', handle: async ({ services }) => ({ warning: databaseBoundWarning(await readDatabaseCapacity(services.engine.store.pool)) }) },
  { method: 'GET', path: '/api/slowest-query', handle: async ({ url }) => ({ slowest: slowestQuery(Date.now(), url.searchParams.get('name') ?? ''), lockHold: longestLockHold() }) },
  {
    method: 'GET', path: '/api/status',
    async handle({ actor, req, url, services, operatorVisible }) {
      const { engine, repository, principals, limits, build, production } = services;
      const jobs = actor.role === 'operator-agent' ? [] : (await engine.store.pool.query('SELECT work_id,available_at,locked_until,attempts,error FROM jobs WHERE error IS NOT NULL ORDER BY available_at LIMIT 50')).rows;
      // Observation jobs rescheduled three times in a row without an observation (GY-506): the
      // merge-queue deadlock shape, raised by master status rather than left for someone to diagnose.
      const starvedJobs = actor.role === 'operator-agent' ? [] : await engine.store.starvedJobs();
      const observedAt = (await engine.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      // Settled deliveries as the work index's summary (GY-1376): this read never loads every document.
      const work = await engine.store.fleet();
      const visibleWork = operatorVisible(work);
      // What waits on the operator, derived from the human-only rule table (model/human-request.ts)
      // on the read every client polls, so the Needs you page renders that table (GY-102).
      // The production environment this process is configured with (GRAPHYARD_PRODUCTION_ENVIRONMENT,
      // else `production`), so the dashboard reads a release under the name production watches.
      const productionEnvironment = productionEnvironmentFromEnv();
      const humanOnly = openHumanOnly(await humanOnlySubjects(services, visibleWork), observedAt.getTime());
      const loop = await reportedLoopMerger(loopRegistry(engine), (text, values) => engine.store.pool.query(text, values), observedAt);
      // The managed repository's own serving (GY-2964), for every install managing a repository other
      // than Mainworks's own: what the deploy record naming it serves and how far the base branch the
      // shared checkout holds is ahead. This process's build and the production watch observe the
      // control plane's own code, never another repository's release, so its header reads from here;
      // an install managing Mainworks itself keeps the production watch's release line.
      const runner = engine.gitRunner === undefined ? engine.gitRunner = gitRunnerFor(setting('REPOSITORY_ROOT') ?? process.cwd()) : engine.gitRunner;
      const deploy = repository && repository.toLowerCase() !== mainworksRepository
        ? await managedDeploy(repository, engine.baseBranch, setting('REPOSITORY_ROOT'), runner)
        : null;
      // Master status's serving block over the API (GY-2976): what the deploy record naming this
      // repository, or the repository's declared serve, serves — the served commit, whether it is
      // main, the URL and the last build failure, with the serve fields null when nothing is
      // declared. Read from the checkout this process serves from: GRAPHYARD_REPOSITORY_ROOT, else
      // its own working directory's git toplevel, so a served head reports its own serving.
      const servingRoot = setting('REPOSITORY_ROOT')?.trim() ? resolve(setting('REPOSITORY_ROOT')!) : repositoryToplevel(process.cwd());
      const read = runner ? async (args: readonly string[]) => { const result = await runner(args); if (result.status !== 0) throw new Error(result.stderr); return result.stdout; } : null;
      const serving = await servingReport(servingRoot, repository ?? '', engine.baseBranch, read && (async args => (await read(args)).trim()));
      // GY-3452: what users have — the commit app.healthUrl answers, else the one served here or
      // the production watch observed — and the merged items it does not contain yet, so the top
      // bar and the Work page count shipped as live, both from this one answer.
      const watched = production?.status();
      const live = actor.role === 'operator-agent' ? null : await liveRelease(servingRoot, serving.commit ?? (watched?.observedAt && !watched.error ? watched.serving : null), serving.main, visibleWork, read);
      // GY-3434: where the app runs — main's app.url, the machine the loop names as its own, the served commit and deploy time.
      const app = await appRelease(read, serving, loopRegistry(engine).live(observedAt)?.hosts?.find(host => host.local)?.host ?? hostname());
      // GY-3527: merges in the last 24 hours, release-to-merge time over the last 10 merges and the open item released longest ago, for the Work page's speed line.
      const timed = pipelineItems(visibleWork);
      const gate = servingRoot ? readGateRecord(gateRecordPath(servingRoot)) : null;
      const released = new Map<string, number>((await engine.store.pool.query("SELECT work_id, min(created_at) AS at FROM events WHERE kind='ready' AND work_id = ANY($1::uuid[]) GROUP BY work_id", [timed.map(item => item.id)])).rows.map(row => [row.work_id, (row.at as Date).getTime()]));
      return { workerVerifications: pendingWorkerVerifications(services, actor, visibleWork), actor, humanOnly, app, delegation: delegationSnapshot(principals.map(p => p.actor), visibleWork, observedAt.getTime(), limits), repository: repository || null,
        baseBranch: process.env.GITHUB_BASE_BRANCH ?? 'main', starvedJobs, jobs, deploy, serving, live, pipelineTime: pipelineTime(timed, released, observedAt.getTime()),
        // GY-3399: the week's batch-gate reverts beside the week's gates removed, each naming its items, for the header.
        thisWeek: servingRoot && actor.role !== 'operator-agent' ? await thisWeekReport(servingRoot, observedAt.getTime()) : null,
        // GY-3833: non-blank lines in src/ and tests/ at the latest verified commit, with the seven-day change, for Home's status line.
        codeSize: codeSizeSummary(gate),
        // GY-3601: since when the release check on main has tried without passing, across runs and holds, for Home's incidents.
        releaseCheck: (since => since ? { since } : null)(releaseCheckSince(gate, visibleWork)),
        // GY-3690: invited people are locked out while the install's public link is off, for Home's incidents.
        publicLink: actor.role === 'operator-agent' ? null : await publicLinkOff(engine.store.pool, observedAt),
        // GY-3850: who every commit is authored by, for Settings and the attention line while none is named.
        owner: (owner => owner && { name: owner.name, email: owner.email })(await checkInOwner(engine.store.pool)),
        // GY-3483: the checks running now, for the header — merge trials the merge writer has in flight
        // (an intent with no trial verdict yet) and a batch gate run on main.
        checksRunning: visibleWork.filter(item => item.mergeLedger?.state === 'intent' && !item.mergeLedger.trial && currentMergeStep(item, observedAt.getTime())?.fresh).length
          + (gate?.inFlight ? 1 : 0),
        // GY-3348: the host's CPU as the live loop last named it on its coordination read — the
        // Workers page's pressure and steal figures; null while no live loop names any.
        cpu: loopRegistry(engine).live(observedAt)?.cpu ?? null,
        // GY-3407: every host the live loop reads — this machine and each added one — for the Workers page's host list.
        hosts: loopRegistry(engine).live(observedAt)?.hosts ?? [],
        // GY-3438: every live agent session's CPU and memory use against its caps, for the Workers page.
        sessions: loopRegistry(engine).live(observedAt)?.sessions ?? [],
        // GY-3593: the caretaker's newest report; Home shows its "needs the owner" lines under Needs you.
        caretaker: actor.role === 'operator-agent' || actor.role === 'reporter' ? null : await newestCaretakerReport(engine.store.pool),
        // The installation facts the master and doctor raise as attention: capacity variables
        // that no longer cover the roster, what production serves against the base branch, and
        // the build/protocol the CLI checks before brokering a merge. Production names work
        // items across the repository, so a scoped operator agent does not see it.
        delegationLimits: services.delegationLimits, build, repositoryPolicy: repositoryPolicy(), production: actor.role === 'operator-agent' ? null : production?.status() ?? null, productionEnvironment,
        // The fleet as the registry holds it: each account's runtime, model, eligibility, sessions,
        // quota and reset time. `?host=` (or the executor-host header) judges placement for that
        // executor. It names hosts and login homes, so implementers and producers do not read it.
        fleet: ['admin', 'coordinator', 'reader', 'slice-lead'].includes(actor.role) ? await services.agentRegistry.snapshot(executorHost(url, req)) : null,
        // Delivery defaults, applications and case bindings (GY-1901).
        project: projectDelivery(),
        // The first-run facts the Setup page and `mainworks up` read beside the App and the fleet (GY-1419):
        // whether a master loop is live, and who reviews and merges as the live loop names it (GY-1501):
        // `supervised` drops the reviewer App and reviewing account from the Setup checklist.
        setup: { loop: !!loop?.live, supervision: loopRegistry(engine).live(observedAt)?.supervision ?? null,
          // GY-3101: and whether the loop alerts the operator directly when queued work can neither start nor merge (null while the live loop names nothing, an older loop).
          alerts: loopRegistry(engine).live(observedAt)?.alerts ?? null,
          // GY-3225: and the standing checkout-trust refusal the live loop raised (an untrusted checkout carrying repository Claude configuration), for the Setup checklist's one item.
          checkoutTrust: loopRegistry(engine).live(observedAt)?.checkoutTrust ?? null,
          // GY-3299: and the loop's standing worker-pool growth failure, for Needs you.
          workerGrowth: loopRegistry(engine).live(observedAt)?.workerGrowth ?? null,
          // GY-3293: and the standing repeated step-failure line the live loop raised (a cycle step failing the same way ten consecutive cycles), for the Setup checklist's Needs you item.
          stepFailure: loopRegistry(engine).live(observedAt)?.stepFailure ?? null,
          // GY-3336: and the standing fetch refusal the live loop raised (the remote refusing the base branch's fetch), quoting the remote's words and the fix, for the Setup checklist's one item.
          fetchRefusal: loopRegistry(engine).live(observedAt)?.fetchRefusal ?? null,
          // GY-3432: and the stall alarm the live loop raised, for the Master page.
          stallAlarm: loopRegistry(engine).live(observedAt)?.stallAlarm ?? null,
          // and the pane server its agents run in as that loop last named it (GY-1511).
          panes: loopRegistry(engine).live(observedAt) ? loopPanesRegistry(engine).latest : null,
          // GY-3277: and where this install's parts run as it last named them — units, containers, port, URL, directories, CLI — for the Setup page's panel.
          where: loopRegistry(engine).live(observedAt) ? loopWhereRegistry(engine).latest : null },
        now: observedAt.toISOString(), release: releaseInfo(), schema: schemaVersion };
    },
  },
  {
    // The board (GY-200): every open item in its group with who acts next, the command that acts,
    // since when and whether it is overdue — the classification the Work page renders and
    // `master status` lists its owed items from, over the same human-only rows and production
    // view /api/status carries, so no client derives groups of its own.
    method: 'GET', path: '/api/board',
    async handle({ actor, services, operatorVisible }) {
      const { engine, production } = services;
      const now = ((await engine.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).getTime();
      const work = operatorVisible(await engine.store.fleet());
      return boardFromStatus(work, now, { humanOnly: openHumanOnly(await humanOnlySubjects(services, work), now), productionEnvironment: productionEnvironmentFromEnv(),
        production: actor.role === 'operator-agent' ? null : production?.status() ?? null });
    },
  },
  {
    method: 'GET', path: '/api/work-snapshot',
    async handle({ actor, req, url, services, operatorVisible }) {
      // Three views. The default (GY-422) is what every reader uses: open items whole, and each
      // settled delivery as its summary (key, stage, delivery; store/summary-sql.ts), whose history
      // `GET /api/work/:id` answers per item. The coordination view is the bounded read the master
      // loop and dispatcher poll (work-view.ts). `view=full` carries every document whole, for an
      // export; no product reader asks for it, as it grows with the ledger.
      const requested = url.searchParams.get('view') ?? req.headers[coordinationViewHeader.toLowerCase()];
      const view = z.enum(['bounded', 'full', 'coordination']).parse(Array.isArray(requested) ? requested[0] : requested ?? 'bounded');
      // The loop's own read is its presence (GY-916): it merges while it lives, however long nothing is mergeable.
      const loopInterval = actor.role === 'coordinator' ? loopPresenceInterval(req.headers[loopPresenceHeader.toLowerCase()]) : null;
      if (loopInterval !== null) loopRegistry(services.engine).observe({ principal: actor.id, intervalSeconds: loopInterval, supervision: loopSupervision(req.headers[loopSupervisionHeader.toLowerCase()]), alerts: loopAlerts(req.headers[loopAlertsHeader.toLowerCase()]), checkoutTrust: loopCheckoutTrust(req.headers[loopCheckoutTrustHeader.toLowerCase()]) ?? undefined, workerGrowth: loopCheckoutTrust(req.headers[loopWorkerGrowthHeader.toLowerCase()]), stepFailure: loopCheckoutTrust(req.headers[loopStepFailureHeader.toLowerCase()]), fetchRefusal: loopCheckoutTrust(req.headers[loopFetchRefusalHeader.toLowerCase()]), stallAlarm: loopCheckoutTrust(req.headers[loopStallAlarmHeader.toLowerCase()]), cpu: loopCpu(req.headers[loopCpuHeader.toLowerCase()]), hosts: loopHosts(req.headers[loopHostsHeader.toLowerCase()]), sessions: loopSessions(req.headers[loopSessionsHeader.toLowerCase()]) }, new Date());
      if (loopInterval !== null) loopPanesRegistry(services.engine).observe(loopPanes(req.headers[loopPanesHeader.toLowerCase()]));
      if (loopInterval !== null) loopWhereRegistry(services.engine).observe(loopWhere(req.headers[loopWhereHeader.toLowerCase()]));
      const scope = <T extends { work: Work[]; jobs: IntegrationJob[] }>(snapshot: T) => {
        const visibleWork = operatorVisible(snapshot.work);
        return { ...snapshot, workerVerifications: pendingWorkerVerifications(services, actor, visibleWork), work: visibleWork, jobs: actor.role === 'operator-agent' ? snapshot.jobs.filter(job => visibleWork.some(work => work.id === job.work_id)) : snapshot.jobs };
      };
      // Paging (GY-864): a reader that must still walk every document — an export, a migration —
      // asks for `cursor` (the number of the work item it last saw, the suffix of its key) and
      // `pageSize`, and streams page by page. The page is chosen in the database, so a page reads
      // only its own documents, never the whole ledger. Only a request that names one of the two
      // is paged; every other response is what it always was, so no reader is truncated
      // silently. The coordination view, the loop's own bounded poll, is not paged.
      const cursorParam = url.searchParams.get('cursor'), pageSizeParam = url.searchParams.get('pageSize');
      const maxPageSize = 1000, defaultPageSize = 100;
      if (view === 'full') demand(cursorParam !== null && pageSizeParam !== null, `Pass both cursor (0 to start) and pageSize (1 to ${maxPageSize}) with view=full`, 400);
      if (cursorParam !== null || pageSizeParam !== null) {
        const cursor = cursorParam === null ? undefined : Number(cursorParam);
        const pageSize = pageSizeParam === null ? defaultPageSize : Number(pageSizeParam);
        demand(cursor === undefined || Number.isSafeInteger(cursor) && cursor >= 0, 'cursor must be a work item number', 400);
        demand(Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= maxPageSize, `pageSize must be an integer from 1 to ${maxPageSize}`, 400);
        demand(view !== 'coordination', 'the coordination view is not paged; it is the bounded read the loop polls', 400);
        // A scoped operator agent's page is chosen from its own work, so the cursor and `hasMore`
        // disclose nothing of the items outside its scope.
        const visible = actor.role === 'operator-agent' && !actor.scope?.workItems.includes('*') ? actor.scope?.workItems ?? [] : undefined;
        const page = scope(await snapshotPage(services.engine.store.pool, view as 'bounded' | 'full', { cursor, pageSize, visible }));
        return view === 'bounded' ? { ...page, view } : page;
      }
      if (view === 'bounded') return { ...scope(await boundedSnapshot(services.engine.store.pool, url.searchParams.get('since'))), view };
      // The coordination view is trimmed in the database (GY-185): the histories it bounds never
      // leave it whole, and what the SQL cut is added to what the view says it left out. The live
      // loop's own poll (GY-3341, the read that names its presence) reads it open-only: a cycle
      // holds open items and what they reference, never every settled summary the ledger keeps.
      const { trimmed, ...snapshot } = await services.engine.store.coordinationSnapshot({ openOnly: loopInterval !== null });
      const trimmedView = coordinationSnapshot(scope(snapshot));
      for (const work of trimmedView.work) {
        const cut = trimmed.get(work.id);
        if (cut) { trimmedView.omitted.evidence += cut.evidence; trimmedView.omitted.dispatchHistory += cut.dispatchHistory; trimmedView.omitted.queueHistory += cut.queueHistory; trimmedView.omitted.actionHistory += cut.actionHistory; trimmedView.omitted.sessions += cut.sessions; }
      }
      return trimmedView;
    },
  },
  {
    // The work list is the bounded fleet read (GY-1778): every open item whole and each settled
    // delivery as the work index's stored summary (store.fleet, GY-1376). store.list() served every
    // document whole here: 134 MB on a 1,777-item ledger, past the plan's abort on every acceptance run.
    method: 'GET', path: '/api/work',
    async handle({ services, operatorVisible }) {
      return operatorVisible(await services.engine.store.fleet());
    },
  },
  {
    // One item's whole document, history included, by id or display key (GY-422): what a reader
    // asks for when the snapshot's summary of a settled delivery is not enough.
    method: 'GET', path: /^\/api\/work\/([^/]+)$/,
    async handle({ services, operatorVisible }, [id]) {
      const work = await workDocument(services.engine.store.pool, decodeURIComponent(id));
      demand(work && operatorVisible([work]).length, 'Work item not found', 404);
      return work!;
    },
  },
  {
    // The history read: filtered by kind and time, paged by ledger sequence, with the routine
    // rows the control plane writes continuously summarised instead of paged through. `rows`
    // answers with the event array every existing client reads; `view=history` adds the cursor
    // and the disclosure of what the filter left out, and `view=page` the cursor alone, for the
    // later pages of one walk. All share one set of defaults.
    method: 'GET', path: '/api/events',
    async handle({ actor, res, url, services, operatorVisible }) {
      const query = parseEventHistoryQuery(url.searchParams);
      // The master's identity, scoped to every item, reads the ledger whole; every other operator agent names its item.
      const wholeLedger = actor.role === 'operator-agent' && !!actor.scope?.workItems.includes('*');
      if (actor.role === 'operator-agent' && !wholeLedger) { demand(query.work, 'Operator-agent history reads require a scoped work item', 403); const item = await services.engine.store.workDocument(query.work!); demand(item && item.id === query.work && operatorVisible([item]).length, 'Work item is outside this operator-agent scope', 403); }
      // GY-3757: one item's history shares four slots; a read kept waiting gets the last answer, its age in seconds in `Age`.
      const read = async () => { const history = await readEventHistory(services.engine.store.pool, query); return query.view === 'rows' ? history.events : history; };
      if (!query.work) return read();
      const { answer, ageMs } = await boundedHistoryRead(`${url.pathname}${url.search}`, read);
      if (ageMs !== null) res.setHeader('Age', String(Math.round(ageMs / 1000)));
      return answer;
    },
  },
]);
