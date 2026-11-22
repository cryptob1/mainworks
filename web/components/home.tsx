import type { Work } from '../../src/model';
import { incidentsFromStatus, statusLine, type Incident } from '../../src/model/incidents';

/**
 * Home (GY-3601) answers "is it OK": one status line and a card per open incident.
 */
interface HomeStatusProps { work: Work[]; status: any; now: number; setView(view: string): void; setSelected(id: string): void }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The first line and the incident cards under it. */
export function HomeStatus({ work, status, now, setView, setSelected }: HomeStatusProps) {
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

