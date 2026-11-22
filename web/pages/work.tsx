import { isClosed, type Work } from '../../src/model';
import { mergedAt, releasedAt, timedGroups, type BoardItem, type Group } from '../groups';
import { releaseView } from '../../src/model/release';
import { plainStage, serveView } from '../../src/model/plain-stage';
import { assignment } from '../../src/model/assignment';
import { blockerSummary, plainStatus } from '../../src/model/plain-status';
import { stalledCards } from '../../src/model/actionless';
import { currentMergeStep } from '../../src/model/merge-ledger';
import { formatDuration } from '../../src/model/duration';
import { CandidatePr } from '../candidate';
import StatusAge from '../components/status-age';
import Term from '../components/term';
import { stepHeld } from '../../src/model/pr-steps';
import { Agent, BuildLine, failedTrial } from '../fun';
import { EmptyState } from '../components/page-layout';
import type { Dashboard } from './dashboard';
import { plainDuration } from '../../src/pipeline-speed';
import { flowStations, percent, reworkCauses } from '../../src/flow-numbers';
import type { Flow as FlowReport } from '../../src/server/flow';

/** GY-3600: the Work list's filters, each a query parameter (`?filter=stuck`). */
export const workFilters = ['in-flight', 'stuck', 'up-next', 'shipped-today'] as const;
export type WorkFilter = typeof workFilters[number];
const filterLabel: Record<WorkFilter, string> = { 'in-flight': 'In flight', stuck: 'Stuck', 'up-next': 'Up next', 'shipped-today': 'Shipped today' };
const inFilter: Record<WorkFilter, (group: Group, today: boolean) => boolean> = {
  'in-flight': group => group === 'needs-you' || group === 'blocked' || group === 'moving',
  stuck: group => group === 'blocked',
  'up-next': group => group === 'up-next',
  'shipped-today': (group, today) => group === 'shipped' && today,
};
/** Stuck first within a goal, then by how close to live. */
const order: Record<Group, number> = { blocked: 0, 'needs-you': 1, moving: 2, 'up-next': 3, backlog: 4, shipped: 5 };
const stageWord: Partial<Record<Work['stage'], string>> = { ready: 'Starting', build: 'Building', review: 'In review', test: 'Testing', acceptance: 'Proving', merge: 'Merging' };

interface Row { item: Work; group: Group; entry?: BoardItem; today: boolean }

const minutes = (from: number, now: number) => formatDuration((now - from) / 60000);
const plainWords = (text: string) => { const words = text.includes(' · ') ? text.slice(text.indexOf(' · ') + 3) : text; return words.charAt(0).toUpperCase() + words.slice(1); };

/** The Builder by its friendly name (the account id on hover) and the runtime it ran on; a dash before anyone claims it. */
function Builder({ item, now }: { item: Work; now: number }) {
  const { owner } = assignment(item, now);
  if (!owner) return <>—</>;
  const named = item.lastAssignment?.owner === owner ? item.lastAssignment : undefined;
  return <>{named?.displayName ? <span className="agent" data-agent={owner} title={owner}>{named.displayName}</span> : <Agent id={owner}/>}{named?.runtime ? ` · ${named.runtime}` : ''}</>;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * GY-3624: one line under the header with attempts an hour and first-pass yield over the last 24
 * hours, whose fold opens each station's wait and the rework causes; a station whose slowest tenth
 * passes an hour is one warning line naming it and its oldest item.
 */
function FlowLine({ flow }: { flow?: FlowReport | null }) {
  const day = flow?.['24h'];
  if (!day) return null;
  const cap = (text: string) => text[0].toUpperCase() + text.slice(1);
  return <>
    <div className="flow-line">Last 24 hours: <span data-flow-attempts>{day.attemptsPerHour.toFixed(1)} attempts an hour</span> · <span data-flow-yield>{percent(day.firstPassYield)} first pass</span>{' '}
      <details className="flow-details"><summary>Flow details →</summary><div className="flow-fold">
        <table className="sessions-table compact-table flow-table" aria-label="Wait at each station, last 24 hours">
          <thead><tr><th scope="col">Station</th><th scope="col">Median</th><th scope="col">Slowest tenth</th><th scope="col">Oldest</th></tr></thead>
          <tbody>{flowStations.map(station => { const at = day.stations[station]; return <tr key={station} data-station={station}>
            <th scope="row">{cap(station)}</th><td data-label="Median">{at ? plainDuration(at.median) : '—'}</td><td data-label="Slowest tenth">{at ? plainDuration(at.p90) : '—'}</td><td data-label="Oldest">{at ? `${at.oldest.key} · ${plainDuration(at.oldest.minutes)}` : '—'}</td></tr>; })}</tbody>
        </table>
        <table className="sessions-table compact-table flow-table" aria-label="Sent back, last 24 hours">
          <thead><tr><th scope="col">Sent back by</th><th scope="col">Times</th></tr></thead>
          <tbody>{reworkCauses.map(cause => <tr key={cause} data-cause={cause}><th scope="row">{cap(cause)}</th><td data-label="Times">{day.rework[cause]}</td></tr>)}</tbody>
        </table>
        <p className="muted">Flaky trials {percent(day.flakyRate)} of {day.trials}. Merges reverted {percent(day.revertRate)}.</p>
      </div></details>
    </div>
    {flow?.attention && <p className="flow-line flow-attention" data-flow-attention>{flow.attention.text}</p>}
  </>;
}

/**
 * Work (GY-3600): one list of real tasks, grouped by goal, with Needs you pinned on top. The groups
 * are the board's (`GET /api/board`), never derived here; a task's goal is its own `goal` field. Hook-free, so unit tests render it.
 */
export default function WorkPage({ work, board, status, query, setQuery, setSelected, setCreating, setView, observedAt, filter, setFilter }: Dashboard) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const release = releaseView(status), serve = serveView(status);
  const byId = new Map(work.map(item => [item.id, item]));
  const stalls = new Map(stalledCards(work.filter(item => item.stage !== 'done' && !isClosed(item)), now).map(card => [card.item.id, card.missing]));
  const today = new Date(now).setHours(0, 0, 0, 0);
  const delivered = work.filter(item => item.stage === 'done' && !isClosed(item) && !!(item.delivery?.mergedAt ?? item.observation?.mergedAt));
  const rows: Row[] = [
    ...(board ? Object.values(board.groups).flat() : []).flatMap(entry => byId.has(entry.id) ? [{ item: byId.get(entry.id)!, group: entry.group as Group, entry, today: false }] : []),
    ...delivered.sort((a, b) => mergedAt(b) - mergedAt(a)).map(item => ({ item, group: 'shipped' as Group, today: mergedAt(item) >= today })),
  ];
  const counts = Object.fromEntries(workFilters.map(name => [name, rows.filter(row => inFilter[name](row.group, row.today)).length])) as Record<WorkFilter, number>;
  const needle = query.trim().toLowerCase().replace(/^#/, '');
  const pr = (item: Work) => item.candidate?.pr ?? item.submission?.pr;
  const shown = needle
    ? rows.filter(({ item }) => `${item.key} ${item.title}`.toLowerCase().includes(needle) || String(pr(item) ?? '') === needle)
    : rows.filter(row => filter ? inFilter[filter](row.group, row.today) : row.group !== 'shipped' || row.today);

  // The header line: how much is in flight, merges an hour over the last 6 hours, and the median review-to-live time of the last day's releases.
  const merges = delivered.filter(item => now - mergedAt(item) <= 6 * 3_600_000).length / 6;
  const reviewToLive = median(delivered.flatMap(item => {
    const live = releasedAt(item, release), started = Date.parse(item.pipeline?.submittedAt ?? item.candidate?.createdAt ?? '');
    return live !== null && now - live <= 24 * 3_600_000 && Number.isFinite(started) && live >= started ? [live - started] : [];
  }));
  const header = `${counts['in-flight']} in flight · ${merges.toFixed(1)} merges/hour (6h) · ${reviewToLive === null ? 'nothing live (24h)' : `${formatDuration(reviewToLive / 60000)} median review to live`}`;

  const needs = board?.groups['needs-you'] ?? [];
  // GY-3593: the caretaker's newest lines that need the owner, in one notice under the Needs you strip.
  const caretaker: string[] = status?.caretaker?.needsOwner ?? [];
  const goals = [...new Set(shown.flatMap(({ item }) => item.goal ? [item.goal] : []))].sort((a, b) => a.localeCompare(b));
  const progress = (goal: string) => { const all = work.filter(item => item.goal === goal && !isClosed(item)); return { shipped: all.filter(item => item.stage === 'done').length, total: all.length }; };
  // GY-3452: shipped means live: the live commit contains it (status `live`), else the release was observed serving it.
  const liveWaiting = typeof status?.live?.commit === 'string' && Array.isArray(status.live.waiting) ? new Set<string>(status.live.waiting) : null;
  /** What a row's task is doing now, in plain words; a held task says what holds it. */
  const doingNow = ({ item, group, entry }: Row): string => {
    if (group === 'shipped') return plainStage(item, now, release, serve);
    // GY-2963: a merge whose trial is advancing names its step and how long it has run.
    const merging = group === 'moving' ? currentMergeStep(item, now) : null;
    if (merging?.fresh) return `Merging: ${merging.step}, ${minutes(merging.atMs, now)}`;
    if (group === 'blocked') return (item.blocker ? blockerSummary(item.blocker, now, item).sentence : null) ?? (stalls.has(item.id) ? `Nothing is happening: ${stalls.get(item.id)}` : plainStatus(item, now).blocking) ?? plainWords(entry?.does ?? '');
    if (entry?.who === 'Nobody yet') return entry.does;
    return group === 'up-next' ? 'Waiting for a builder' : group === 'backlog' ? 'Not released yet' : plainWords(entry?.does ?? '');
  };
  const table = (list: Row[]) => <table className="sessions-table work-table">
    <thead><tr><th scope="col">State</th><th scope="col">Task</th><th scope="col">Now</th><th scope="col">Builder</th><th scope="col"><Term term="pull request" focusable={false}>PR</Term></th><th scope="col">Time</th></tr></thead>
    <tbody>{[...list].sort((a, b) => order[a.group] - order[b.group]).map(row => {
      const { item, group, entry } = row;
      const live = group === 'shipped' && (liveWaiting ? !liveWaiting.has(item.key) : releasedAt(item, release) !== null);
      const state = group === 'blocked' ? 'Stuck' : group === 'needs-you' ? 'Needs you' : group === 'moving' ? stageWord[item.stage] ?? 'Moving' : group === 'up-next' ? 'Up next' : group === 'backlog' ? 'Backlog' : live ? 'Shipped' : 'Merged';
      const doing = doingNow(row);
      const since = group === 'shipped' ? mergedAt(item) : Date.parse(entry?.since ?? item.stageEnteredAt);
      return <tr key={item.id} onClick={() => setSelected(item.id)} data-row={item.key} data-stuck={group === 'blocked'} className={`task-row group-${group}${failedTrial(item) ? ' glitch' : ''}${item.mergeLedger?.state === 'pushed' && item.candidate ? ' trial' : ''}`}>
        <td data-col="state">{state}</td>
        <td data-col="task"><a className="card-open" href={`#${item.key}`} title={item.title} aria-label={`${item.title} — open ${item.key}`} onClick={event => { event.preventDefault(); event.stopPropagation(); setSelected(item.id); }}>{item.title}</a></td>
        <td data-col="now">{doing}</td>
        <td data-col="builder"><Builder item={item} now={now}/></td>
        <td data-col="pr">{item.candidate ? <CandidatePr repository={status?.repository} candidate={item.candidate} workKey={item.key} observation={item.observation as never}/> : '—'}</td>
        {/* Moving and stuck rows carry the step's clock, marked overdue past the one threshold (GY-108); a head queued for its merge is never overdue for that wait. */}
        <td data-col="time">{timedGroups.has(group) ? <StatusAge held={{ ...stepHeld(item, now, null, release), ...(entry?.queue ? { overdue: false } : {}) }}/> : minutes(since, now)}</td>
      </tr>;
    })}</tbody>
  </table>;
  const noGoal = shown.filter(({ item }) => !item.goal);

  return <>
    <div className="page-heading"><div><h1>Work</h1><p className="page-fact" data-work-header>{board ? header : 'Reading the board…'}</p><FlowLine flow={status?.flow}/><BuildLine/></div>
      <div className="page-actions"><div className="search"><input type="search" aria-label="Search work" placeholder="Search by title, key or PR" value={query} onChange={event => setQuery(event.target.value)}/></div>
        {status?.actor?.role === 'admin' && <button type="button" onClick={() => setCreating(true)}>＋ New work item</button>}</div></div>
    {needs.length > 0 && <section className="panel needs-you-strip" aria-label="Needs you">
      <h2>Needs you <span className="count">{needs.length}</span><button type="button" className="text-button push" onClick={() => setView('needs-you')}>Every request and answer →</button></h2>
      {needs.slice(0, 3).map(entry => <div key={entry.id} className="need" data-need={entry.key}>
        <span className="need-question" title={entry.does}>{entry.does}</span>
        <span className="muted">waiting {minutes(Date.parse(entry.since), now)}</span>
        <button type="button" onClick={() => setSelected(entry.id)}>Review request</button>
      </div>)}
    </section>}
    {caretaker.length > 0 && <ul className="notice caretaker-lines" aria-label="The caretaker needs you" data-caretaker>{caretaker.map(line => <li key={line}>{line}</li>)}</ul>}
    <div role="group" aria-label="Filter work" className="work-filters">{workFilters.map(name => <button type="button" key={name} className={filter === name ? 'chip active' : 'chip'} aria-pressed={filter === name} data-filter={name} onClick={() => setFilter(filter === name ? null : name)}>
      {filterLabel[name]} <span className="count">{counts[name]}</span>
    </button>)}</div>
    {goals.map(goal => { const { shipped, total } = progress(goal); return <section key={goal} className="panel goal-group" data-goal={goal}>
      <h2>{goal}</h2>
      <p className="goal-progress"><progress value={shipped} max={Math.max(total, 1)}/><span data-goal-progress>{shipped}/{total} shipped</span></p>
      {table(shown.filter(({ item }) => item.goal === goal))}
    </section>; })}
    {noGoal.length > 0 && <details className="panel goal-group" data-goal="none" open={goals.length === 0}>
      <summary><h2>No goal <span className="count">{noGoal.length}</span></h2></summary>
      {table(noGoal)}
    </details>}
    {work.length === 0 ? <EmptyState title="The yard is quiet. File a goal and wake the crew." action={status?.actor?.role === 'admin' && <button type="button" onClick={() => setCreating(true)}>Create the first task</button>}>Create a task, say what must be true when it is done, and an agent will pick it up.</EmptyState>
      : shown.length === 0 && <p className="muted">{needle ? 'No task matches.' : 'Nothing here right now.'}</p>}
  </>;
}
