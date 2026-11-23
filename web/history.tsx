import { useState } from 'react';
import { Agent } from './fun';

type Answer = { ownerSaid?: string; by: string; text?: string; note?: string };
type Event = { seq: number; kind: string; actor: string; created_at: string; payload?: { details?: { oldPriority?: number; newPriority?: number; reason?: string; request?: { answer?: Answer }; answer?: Answer; question?: string; summary?: string; evidence?: string[]; failure?: string } } };
const titles: Record<string, string> = { priority: 'Priority changed', 'investigator.answered': 'Investigator answered', 'investigator.failed': 'Investigator gave no answer' };
export default function History({ events }: { events: Event[] }) {
  const [limit, setLimit] = useState(20);
  const [groupObservations, setGroupObservations] = useState(true);
  const groups: { newest: Event; oldest: Event; count: number }[] = [];
  for (const event of events) {
    const previous = groups.at(-1);
    if (groupObservations && event.kind === 'github.observed' && previous?.newest.kind === event.kind && previous.newest.actor === event.actor) {
      previous.oldest = event; previous.count++;
    } else groups.push({ newest: event, oldest: event, count: 1 });
  }
  return <section aria-label="Work history">
    <h3>History</h3>
    <p className="muted">Latest {events.length} events (up to 300). The full audit history is retained in storage.</p>
    <label className="history-option"><input type="checkbox" checked={groupObservations} onChange={e => { setGroupObservations(e.target.checked); setLimit(20); }}/>Group consecutive GitHub observations</label>
    <div className="history-scroll" role="region" aria-label="History entries" tabIndex={0}>
      <div className="timeline">{groups.slice(0, limit).map(({ newest, oldest, count }) => <div key={newest.seq}>
        <span>{new Date(newest.created_at).toLocaleString()}{count > 1 && <> back to {new Date(oldest.created_at).toLocaleString()}</>}</span>
        <strong>{titles[newest.kind] ?? newest.kind}{count > 1 && ` × ${count}`}</strong><small><Agent id={newest.actor}/></small>{newest.kind === 'priority' && <p>P{newest.payload?.details?.oldPriority} → P{newest.payload?.details?.newPriority} · {newest.payload?.details?.reason}</p>}
        {newest.kind.startsWith('investigator.') && <InvestigatorNote details={newest.payload?.details}/>}
        {(newest.kind === 'human.answered' || newest.kind === 'human-proof.answered') && <AnswerHistory answer={newest.payload?.details?.request?.answer ?? newest.payload?.details?.answer}/>}
      </div>)}</div>
      {events.length === 0 && <p>No history loaded.</p>}
    </div>
    <p className="muted">Showing {Math.min(limit, groups.length)} of {groups.length} {groupObservations ? 'entries' : 'events'}.</p>
    {groups.length > limit && <button className="text-button" onClick={() => setLimit(n => n + 20)}>Show more history</button>}
    {limit > 20 && <button className="text-button" onClick={() => setLimit(20)}>Show less history</button>}
  </section>;
}

function AnswerHistory({ answer }: { answer?: Answer }) {
  if (!answer) return null;
  return <p>{answer.text ?? answer.note}{answer.ownerSaid && <span> · relayed by {answer.by} from the owner: "{answer.ownerSaid}"</span>}</p>;
}

/** GY-3530: an `ask GY-N QUESTION` answer: the question, the summary or failure line, and the file:line evidence. */
function InvestigatorNote({ details }: { details?: { question?: string; summary?: string; evidence?: string[]; failure?: string } }) {
  if (!details) return null;
  return <p>{details.question} → {details.summary ?? details.failure}{details.evidence?.length ? <small> · {details.evidence.join(', ')}</small> : null}</p>;
}
