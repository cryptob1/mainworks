import { useEffect, useState } from 'react';
import type { Work } from '../../src/model';
import { formatDuration } from '../../src/model/duration';
import { mergedAt } from '../groups';

/**
 * GY-3671: what changed since this person last looked (counted from their own last visit), the
 * active goals and what is being built now, and a box that sends its text to the Lead.
 */
interface Props { work: Work[]; status: any; now: number; api(path: string, data?: unknown): Promise<any> }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A Lead decision since the last look: a closure or a rework, with its reason. */
const decisions = (work: Work[], since: number) => [
  ...work.flatMap(w => w.closure && w.closure.kind !== 'delivered-observation' && Date.parse(w.closure.at) > since ? [{ at: w.closure.at, text: `The Lead closed “${w.title}”: ${w.closure.reason}`, ask: `Why did you close “${w.title}”?`, other: `Instead of closing “${w.title}”, ` }] : []),
  ...work.flatMap(w => w.lastRework && Date.parse(w.lastRework.at) > since ? [{ at: w.lastRework.at, text: `The Lead sent “${w.title}” back: ${w.lastRework.reason}`, ask: `Why did you send “${w.title}” back?`, other: `Instead of sending “${w.title}” back, ` }] : []),
].sort((a, b) => b.at.localeCompare(a.at));

export default function HomeBrief({ work, status, now, api }: Props) {
  const [since, setSince] = useState<number | null | undefined>(undefined);
  const [draft, setDraft] = useState(''), [sent, setSent] = useState('');
  // One visit: the answer is when this person last looked, and now becomes their last look.
  useEffect(() => { void api('home-visit').then(body => setSince(typeof body?.since === 'string' ? Date.parse(body.since) : null), () => setSince(null)); }, []);
  const waiting = typeof status?.live?.commit === 'string' && Array.isArray(status.live.waiting) ? new Set<string>(status.live.waiting) : null;
  const fresh = since ? work.filter(w => w.stage === 'done' && !w.closure && !!(w.delivery?.mergedAt ?? w.observation?.mergedAt) && mergedAt(w) > since) : [];
  const live = fresh.filter(w => waiting && !waiting.has(w.key)), releasing = fresh.filter(w => !waiting || waiting.has(w.key));
  const led = since ? decisions(work, since) : [];
  const spend = since ? work.flatMap(w => (w.humanRequests ?? []).filter(r => r.kind === 'money-or-accounts' && r.answer && Date.parse(r.answer.at) > since)).length : 0;
  const bullets = [...(live.length ? [{ text: `Live: ${live.map(w => w.title).join(', ')}.` }] : []), ...led.map(d => ({ text: d.text, decision: d }))].slice(0, 3);
  const goals = work.filter(w => w.stage !== 'done' && w.dependencies?.length);
  const building = work.filter(w => w.stage !== 'done' && w.lease && Date.parse(w.lease.expiresAt) > now);
  async function send() {
    try { await api('master/messages', { text: draft }); setSent('Sent to the Lead.'); setDraft(''); } catch (e) { setSent((e as Error).message); }
  }
  return <>
    {since !== undefined && <section className="panel since-looked" aria-label="Since you last looked" data-since={since ?? 'first'}>
      <h2>Since you last looked{since ? <small className="muted"> · {formatDuration((now - since) / 60000)} ago</small> : null}</h2>
      {since === null ? <p className="muted">This is your first look. Next time this shows what changed.</p> : <>
        <p data-since-counts>{live.length} went live · {releasing.length} in release · {plural(led.length, 'Lead decision')} · {plural(spend, 'spend approval')}</p>
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
