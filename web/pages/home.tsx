import type { Dashboard } from './dashboard';
import { PageHeader, PageSection } from '../components/page-layout';
import { openHumanOnly } from '../../src/model/human-request';
import { humanAsk } from '../../src/model/human-ask';
import { formatDuration } from '../../src/model/duration';
import { classify, summarySentence } from '../groups';
import { masterOwes } from './master';
import HomeBrief from '../components/home-brief';
import { HomeStatus } from '../components/home';
import { hasMergedWork } from '../../src/model/first-run';
import FirstRunPage from './first-run';
import { hostsNeedingUpdate, hostUpdateCommand } from '../components/top-bar';
import { machineName } from '../../src/model/machine-load';

/**
 * The Home place (GY-3598) answers "is it OK" (GY-3601): the status line and
 * incident cards first, then what needs you, what changed since this person last
 * looked, active goals and a box to the Lead (GY-3671), and the summary.
 * An install with no merged work opens on the four-step first-run page instead (GY-3603).
 */
export default function HomePage(dashboard: Dashboard) {
  if (!hasMergedWork(dashboard.work)) return <FirstRunPage {...dashboard}/>;
  const { work, board, status, observedAt, api, setView, setSelected, setCreating } = dashboard;
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const requests = [...(status?.humanOnly ?? openHumanOnly(work.map(item => ({ work: item })), now))]
    .sort((a, b) => b.waitedMs - a.waitedMs);
  const { byGroup } = classify(work, now);
  const counts = board
    ? {
        'needs-you': board.groups['needs-you'].length,
        blocked: board.groups.blocked.length,
        moving: board.groups.moving.length,
        'up-next': board.groups['up-next'].length,
        backlog: board.groups.backlog.length,
      }
    : {
        'needs-you': byGroup['needs-you'].length,
        blocked: byGroup.blocked.length,
        moving: byGroup.moving.length,
        'up-next': byGroup['up-next'].length,
        backlog: byGroup.backlog.length,
      };
  const owes = masterOwes(work, now);
  const stall = typeof status?.setup?.stallAlarm === 'string' ? status.setup.stallAlarm : null;
  const admin = status?.actor?.role === 'admin';
  // GY-3827: each test machine whose helper is older than this release waits on its owner's one-time prepare.
  const outdated = hostsNeedingUpdate(status);
  const local = Array.isArray(status?.hosts) ? status.hosts.find((host: { local?: unknown; host?: unknown }) => host?.local === true && typeof host.host === 'string')?.host : undefined;
  const coordinator = local ? machineName(local) : 'the main machine';
  const needs = requests.length + outdated.length;
  const fact = work.length === 0 ? 'The yard is quiet.' : summarySentence(counts);

  return <>
    <HomeStatus work={work} status={status} now={now} setView={setView} setSelected={setSelected}/>
    <PageHeader title="Home" fact={fact} actions={admin && <button type="button" onClick={() => setCreating(true)}>New task</button>}/>
    {needs > 0 && <PageSection title="Needs you" count={needs} className="work-group group-needs-you" actions={<button type="button" className="text-button" onClick={() => setView('needs-you')}>Open all requests →</button>}>
      <ul className="shipped-list">{outdated.map(host => <li key={host} data-host-action={host}>
        <strong>{machineName(host)}</strong>
        <span>Takes no test work until a one-time update; updating it moves test work off {coordinator}.</span>
        <span>In a terminal here, run <span className="mono">{hostUpdateCommand(host)}</span>.</span>
      </li>)}{requests.slice(0, 5).map(row => <li key={row.request.id}>
        <strong>{row.work}</strong>
        <span>{humanAsk(row.request)}</span>
        <span className="muted">waiting {formatDuration(row.waitedMs / 60000)}</span>
        <button type="button" className="decide push" onClick={() => setSelected(row.id)}>Review request</button>
      </li>)}</ul>
    </PageSection>}
    {stall && <PageSection title="Stall alarm" className="work-group group-blocked" actions={<button type="button" className="text-button" onClick={() => setView('lead')}>Open Lead →</button>}>
      <p className="stall-alarm" role="alert">{stall}</p>
    </PageSection>}
    <HomeBrief work={work} status={status} now={now} api={api}/>
    <PageSection title="Summary">
      <div className="home-summary-grid">
        <div className="home-summary-card">
          <strong>Work</strong>
          <p>{counts.moving} moving · {counts.blocked} blocked · {counts['up-next']} up next</p>
          <button type="button" className="text-button" onClick={() => setView('work')}>Open Work →</button>
        </div>
        <div className="home-summary-card">
          <strong>Lead</strong>
          <p>{owes.length ? `${owes.length} ${owes.length === 1 ? 'blocker' : 'blockers'} waiting on Lead` : 'No blockers waiting on Lead'}</p>
          <button type="button" className="text-button" onClick={() => setView('lead')}>Open Lead →</button>
        </div>
        <div className="home-summary-card">
          <strong>Settings</strong>
          <p>Accounts, workers, costs, delivery and help</p>
          <button type="button" className="text-button" onClick={() => setView('agents')}>Open Settings →</button>
        </div>
      </div>
    </PageSection>
  </>;
}
