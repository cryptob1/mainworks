import { useEffect, useState } from 'react';
import type { Work } from '../../src/model';
import { incidentsFromStatus, span, statusLine, type Incident } from '../../src/model/incidents';
import { mergedAt } from '../groups';

/**
 * Home (GY-3601) answers "is it OK and what changed": one status line, a card per open incident,
 * what changed since this person last looked, the active goals, and a box to tell the Lead.
 */
interface HomeProps { work: Work[]; status: any; now: number; api(path: string, data?: unknown): Promise<any>; setView(view: string): void; setSelected(id: string): void }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The first line and the incident cards under it. */
export function HomeStatus({ work, status, now, setView, setSelected }: Omit<HomeProps, 'api'>) {
  const incidents = incidentsFromStatus(status ?? {}, work, now);
  const line = statusLine(status ?? {}, work, incidents, now);
  const open = (action: NonNullable<Incident['action']>) => action.open === 'item' ? setSelected(action.item!) : setView(action.open);
  return <>
    <p className="home-status-line" data-status-line={line.state}>
      <strong className={`status-state state-${line.state.toLowerCase()}`}>{line.state}</strong>
      <span>{line.builders.allowed === null ? plural(line.builders.working, 'Builder') : `${line.builders.working} of ${line.builders.allowed} Builders`} working</span>
      <span>{line.machines.configured ? `${line.machines.ready} of ${line.machines.configured} test machines ready` : 'No test machines'}</span>
      <span>{line.lastLive === null ? 'Nothing live yet' : `Last live ${line.lastLive} ago`}</span>
      <span>{line.mergesPerHour.toFixed(1)} merges an hour today</span>
    </p>
    {incidents.length > 0 && <section className="incidents" aria-label="Incidents">
      {incidents.map((incident, n) => <article key={`${incident.kind}-${n}`} className="panel incident" data-incident={incident.kind}>
        <p className="incident-broke">{incident.broke}</p>
        <p><span className="muted">Impact</span> {incident.impact}</p>
        <p><span className="muted">Team</span> {incident.doing}</p>
        {incident.action && <button type="button" onClick={() => open(incident.action!)}>{incident.action.label}</button>}
      </article>)}
    </section>}
  </>;
}

/** A Lead decision since the last look: a closure or a rework, with its reason. */
const decisions = (work: Work[], since: number) => [
  ...work.flatMap(w => w.closure && w.closure.kind !== 'delivered-observation' && Date.parse(w.closure.at) > since ? [{ at: w.closure.at, text: `the Lead closed “${w.title}”: ${w.closure.reason}`, ask: `Why did you close “${w.title}”?`, other: `Instead of closing “${w.title}”, ` }] : []),
  ...work.flatMap(w => w.lastRework && Date.parse(w.lastRework.at) > since ? [{ at: w.lastRework.at, text: `the Lead sent “${w.title}” back: ${w.lastRework.reason}`, ask: `Why did you send “${w.title}” back?`, other: `Instead of sending “${w.title}” back, ` }] : []),
].sort((a, b) => b.at.localeCompare(a.at));

/** "Since you last looked", from this person's own last visit, then active goals and the box that tells the Lead. */
export function HomeBrief({ work, status, now, api }: HomeProps) {
  const [since, setSince] = useState<number | null | undefined>(undefined);
  const [draft, setDraft] = useState(''), [sent, setSent] = useState('');
  // One visit: the answer is when this person last looked, and now becomes their last look.
  useEffect(() => { void api('home-visit').then(body => setSince(typeof body?.since === 'string' ? Date.parse(body.since) : null), () => setSince(null)); }, []);
  const waiting = typeof status?.live?.commit === 'string' && Array.isArray(status.live.waiting) ? new Set<string>(status.live.waiting) : null;
  const fresh = since ? work.filter(w => w.stage === 'done' && !w.closure && !!(w.delivery?.mergedAt ?? w.observation?.mergedAt) && mergedAt(w) > since) : [];
  const live = fresh.filter(w => waiting && !waiting.has(w.key)), releasing = fresh.filter(w => !waiting || waiting.has(w.key));
  const led = since ? decisions(work, since) : [];
  const spend = since ? work.flatMap(w => (w.humanRequests ?? []).filter(r => r.kind === 'money-or-accounts' && r.answer && Date.parse(r.answer.at) > since)).length : 0;
  const bullets = [...(live.length ? [{ text: `Live: ${live.map(w => w.title).join(', ')}.` }] : []), ...led.map(d => ({ text: `Decision: ${d.text}`, decision: d }))].slice(0, 3);
  const goals = work.filter(w => w.stage !== 'done' && w.dependencies?.length);
  const building = work.filter(w => w.stage !== 'done' && w.lease && Date.parse(w.lease.expiresAt) > now);
  async function send() {
    try { await api('master/messages', { text: draft }); setSent('Sent to the Lead.'); setDraft(''); } catch (e) { setSent((e as Error).message); }
  }
  return <>
    {since !== undefined && <section className="panel since-looked" aria-label="Since you last looked" data-since={since ?? 'first'}>
      <h2>Since you last looked{since ? <small> · {span(now - since)} ago</small> : null}</h2>
      {since === null ? <p className="muted">This is your first look. Next time this shows what changed.</p> : <>
        <p data-since-counts><span data-went-live={live.length}>{live.length} went live</span> · <span data-in-release={releasing.length}>{releasing.length} in release</span> · <span data-decisions={led.length}>{plural(led.length, 'Lead decision')}</span> · <span data-spend={spend}>{plural(spend, 'spend approval')}</span></p>
        {bullets.length > 0 && <ul>{bullets.map(b => <li key={b.text}>{b.text}{'decision' in b && <> <button type="button" className="text-button" onClick={() => setDraft(b.decision.ask)}>Ask why</button> · <button type="button" className="text-button" onClick={() => setDraft(b.decision.other)}>Do it differently</button></>}</li>)}</ul>}
      </>}
    </section>}
    {goals.length > 0 && <section className="panel goals" aria-label="Active goals"><h2>Active goals</h2>
      <ol>{goals.map(goal => {
        const tasks = goal.dependencies.map(id => work.find(w => w.id === id)).filter((t): t is Work => !!t);
        return <li key={goal.id} data-goal={goal.key}><strong>{goal.title}</strong> <span className="muted">{tasks.filter(t => t.stage === 'done').length} of {plural(tasks.length, 'task')} done</span></li>;
      })}</ol>
    </section>}
    {building.length > 0 && <p className="building-now" data-building-now>Now: {building.slice(0, 3).map(t => t.title).join(', ')}{building.length > 3 && ` and ${building.length - 3} more`}</p>}
    <form className="panel tell-lead" aria-label="Tell the Lead" onSubmit={event => { event.preventDefault(); if (draft.trim()) void send(); }}>
      <label htmlFor="tell-lead">Tell the Lead</label>
      <div className="tell-lead-row"><textarea id="tell-lead" rows={2} value={draft} onChange={event => { setDraft(event.target.value); setSent(''); }} placeholder="What should the team do next?"/>
        <button type="submit" disabled={!draft.trim()}>Send</button></div>
      {sent && <p className="muted" role="status">{sent}</p>}
    </form>
  </>;
}

