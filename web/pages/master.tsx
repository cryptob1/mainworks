import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Dashboard } from './dashboard';
import { isClosed, type Work } from '../../src/model';
import { blockerSince } from '../../src/model/work';
import { parkedOnHuman } from '../../src/model/human-request';
import { formatAge } from '../../src/model/duration';
import LiveTerminal from '../components/live-terminal';
import { PageHeader } from '../components/page-layout';

type Message = { id: number; from: string; to?: string; thread: string; text: string; at: string; replies: { id: number; by: string; text: string; at: string }[] };
type Entry = { id: number; who: string; text: string; at: string };
type Typed = { who: string; text: string; at: string };
type MasterTab = 'terminal' | 'history' | 'messages';

function masterTabFromHash(hash: string): MasterTab {
  if (hash === '#master/history') return 'history';
  if (hash === '#master/messages') return 'messages';
  return 'terminal';
}

/** GY-3345: messages between this Master and other installs' Masters, one thread per conversation, oldest entry first. */
export function messageThreads(messages: Message[]) {
  const threads = new Map<string, { peer: string; entries: Entry[] }>();
  for (const message of messages) {
    const thread = threads.get(message.thread) ?? { peer: message.to ?? message.from, entries: [] };
    thread.entries.push({ id: message.id, who: message.to ? 'Master' : message.from, text: message.text, at: message.at },
      ...message.replies.map(reply => ({ id: reply.id, who: 'Master', text: reply.text, at: reply.at })));
    threads.set(message.thread, thread);
  }
  return [...threads.values()].map(thread => ({ ...thread, entries: thread.entries.sort((a, b) => a.id - b.id) }))
    .sort((a, b) => b.entries.at(-1)!.id - a.entries.at(-1)!.id);
}

/**
 * GY-3394: the blockers the Master owes — every standing worker blocker that is not the owner's,
 * longest wait first, with how long each has stood. The same reading `master status` carries as
 * attention: a blocker is the Master's however long it waits, never the owner's.
 */
export function masterOwes(work: Work[], now: number) {
  return work.filter(item => item.stage !== 'done' && !isClosed(item) && item.blocker && !parkedOnHuman(item))
    .map(item => ({ id: item.id, key: item.key, title: item.title, blocker: item.blocker!, since: blockerSince(item) }))
    .sort((a, b) => (b.since ?? 0) - (a.since ?? 0));
}

/**
 * The Master page (GY-3211): the master agent's live Herdr pane, typed into by the operator and
 * watched by everyone else. Its title reads Master (GY-3307). Above the terminal, what the Master
 * owes: the standing blockers that are the Master's, not the owner's (GY-3394) — Needs you carries
 * only the owner's three decisions. Messages with other installs fold away below it (GY-3481).
 */
export default function MasterPage({ work, observedAt, token, api, setSelected, status }: Pick<Dashboard, 'work' | 'observedAt' | 'token' | 'api' | 'setSelected'> & { status?: Dashboard['status'] }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [typed, setTyped] = useState<Typed[]>([]);
  const [tab, setTab] = useState<MasterTab>(() => masterTabFromHash(typeof location === 'undefined' ? '' : location.hash));
  const tabRefs = useRef<Partial<Record<MasterTab, HTMLButtonElement | null>>>({});
  useEffect(() => {
    const onHash = () => setTab(masterTabFromHash(location.hash));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    let live = true;
    const load = () => {
      void api('typed-input').then(body => { if (live) setTyped(body.typed ?? []); }, () => {});
      return api('master/messages').then(body => { if (live) { setMessages(body.messages ?? []); setMessagesLoaded(true); } }, () => { if (live) setMessagesLoaded(true); });
    };
    void load(); const timer = setInterval(load, 15_000);
    return () => { live = false; clearInterval(timer); };
  }, [token]);
  const threads = messageThreads(messages);
  const showMessagesTab = threads.length > 0 || (tab === 'messages' && !messagesLoaded);
  const tabs: { id: MasterTab; label: string }[] = [
    { id: 'terminal', label: 'Terminal' },
    { id: 'history', label: 'History' },
    ...(showMessagesTab ? [{ id: 'messages' as const, label: 'Messages' }] : []),
  ];
  const activeTab: MasterTab = tab === 'messages' && !showMessagesTab ? 'terminal' : tab;
  const selectTab = (next: MasterTab) => {
    setTab(next);
    const hash = next === 'terminal' ? '#master' : `#master/${next}`;
    if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  };
  const onTabKeyDown = (event: KeyboardEvent, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabs[nextIndex]!.id;
    selectTab(next);
    tabRefs.current[next]?.focus();
  };
  // GY-3432: the loop's stall alarm, first, until work moves again.
  const stall = typeof status?.setup?.stallAlarm === 'string' ? status.setup.stallAlarm : null;
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const owes = masterOwes(work, now);
  return <>
    <PageHeader title="Master" fact="Files, routes and unsticks the work."/>
    {stall && <p className="stall-alarm" role="alert">{stall}</p>}
    {owes.length > 0 && <section className="panel" aria-label="Blockers the Master owes"><h2>Blocked ({owes.length})</h2>
      <ul className="master-owes">{owes.map(entry => <li key={entry.id}>
        <button className="text-button" onClick={() => setSelected(entry.id)}>{entry.key} <span data-title>{entry.title}</span></button>
        <span className="muted">{entry.since !== null ? `blocked ${formatAge(entry.since, now)}` : 'blocked'}</span>
        <span className="muted master-owes-blocker" title={entry.blocker}>{entry.blocker}</span>
      </li>)}</ul>
    </section>}
    <div className="tabs master-tabs" role="tablist" aria-label="Master views">
      {tabs.map((entry, index) => <button
        key={entry.id}
        ref={el => { tabRefs.current[entry.id] = el; }}
        id={`master-tab-${entry.id}`}
        type="button"
        role="tab"
        className={activeTab === entry.id ? 'tab active' : 'tab'}
        aria-selected={activeTab === entry.id}
        aria-controls={`master-panel-${entry.id}`}
        tabIndex={activeTab === entry.id ? 0 : -1}
        onClick={() => selectTab(entry.id)}
        onKeyDown={event => onTabKeyDown(event, index)}
      >{entry.label}</button>)}
    </div>
    <div className="master-tabpanel" role="tabpanel" id={`master-panel-${activeTab}`} aria-labelledby={`master-tab-${activeTab}`}>
      {activeTab === 'terminal' && <LiveTerminal token={token} label="Master terminal"/>}
      {/* GY-3514: what people typed into the master, newest first. */}
      {activeTab === 'history' && <section className="panel typed-input" aria-label="Typed into the master"><h2>Typed into the master</h2>
        {typed.length > 0
          ? <ol>{typed.map((entry, index) => <li key={index}><b>{entry.who}</b> <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time> <code>{entry.text}</code></li>)}</ol>
          : <p className="muted">Nothing typed into the master yet.</p>}
      </section>}
      {activeTab === 'messages' && threads.length > 0 && <section className="panel master-messages" aria-label="Messages with other installs">
        {threads.map(thread => <article key={thread.entries[0]!.id} className="master-thread" aria-label={`Thread with ${thread.peer}`}>
          <h2>With {thread.peer}</h2>
          <ol>{thread.entries.map(entry => <li key={entry.id}><b>{entry.who}</b> <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time><p>{entry.text}</p></li>)}</ol>
        </article>)}
      </section>}
    </div>
  </>;
}
