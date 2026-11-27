import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import type { Dashboard } from './dashboard';
import { isClosed, type Work } from '../../src/model';
import { blockerSince } from '../../src/model/work';
import { parkedOnHuman, humanOnlyRefusal, openHumanOnly, recommendedFirst, type HumanRequestRow } from '../../src/model/human-request';
import { formatAge } from '../../src/model/duration';
import { humanAsk } from '../../src/model/human-ask';
import LiveTerminal, { type TerminalHandle } from '../components/live-terminal';
import { MoreDetails, PageHeader } from '../components/page-layout';
import { goalOrder, leadFeed, ledgerKinds, notMovingLine, steerers, type FeedDecision, type LedgerRow, type NotMovingRow, type RegistryRow, type TypedLine } from '../lead-feed';

type Message = { id: number; from: string; to?: string; thread: string; text: string; at: string; replies: { id: number; by: string; text: string; at: string }[] };
type Entry = { id: number; who: string; text: string; at: string };
type MasterTab = 'conversation' | 'live' | 'history' | 'messages';

// The page answers to #lead and to its old address #master (GY-3598), each with its tab after a slash.
function masterTabFromHash(hash: string): MasterTab {
  return (/^#(?:master|lead)\/(live|history|messages)$/.exec(hash)?.[1] as MasterTab | undefined) ?? 'conversation';
}

/** GY-3345: messages between this Lead and other installs' Leads, one thread per conversation, oldest entry first. */
export function messageThreads(messages: Message[]) {
  const threads = new Map<string, { peer: string; entries: Entry[] }>();
  for (const message of messages) {
    const thread = threads.get(message.thread) ?? { peer: message.to ?? message.from, entries: [] };
    thread.entries.push({ id: message.id, who: message.to ? 'Lead' : message.from, text: message.text, at: message.at },
      ...message.replies.map(reply => ({ id: reply.id, who: 'Lead', text: reply.text, at: reply.at })));
    threads.set(message.thread, thread);
  }
  return [...threads.values()].map(thread => ({ ...thread, entries: thread.entries.sort((a, b) => a.id - b.id) }))
    .sort((a, b) => b.entries.at(-1)!.id - a.entries.at(-1)!.id);
}

/**
 * GY-3394: the blockers the Lead owes — every standing worker blocker that is not the owner's,
 * longest wait first, with how long each has stood. The same reading `master status` carries as
 * attention: a blocker is the Lead's however long it waits, never the owner's.
 */
export function masterOwes(work: Work[], now: number) {
  return work.filter(item => item.stage !== 'done' && !isClosed(item) && item.blocker && !parkedOnHuman(item))
    .map(item => ({ id: item.id, key: item.key, title: item.title, blocker: item.blocker!, since: blockerSince(item) }))
    .sort((a, b) => (b.since ?? 0) - (a.since ?? 0));
}

/** The status line's one reading of the Lead's session: what it is doing, and for how long. */
export function leadStatus(pane: { session: { state: string; since?: string | null } | null; mode: string; reason: string }, now: number): { words: string; age: string | null; state: string } {
  const { session } = pane;
  if (pane.mode === 'refused') return { words: pane.reason || 'Not available: sign in, and check the session still has a pane.', age: null, state: 'refused' };
  const state = session?.state ?? null;
  const read = leadWords(session, now);
  return { ...read, state: state === null || state === 'reconnecting' ? 'connecting' : state };
}
function leadWords(session: { state: string; since?: string | null } | null, now: number): { words: string; age: string | null } {
  const state = session?.state ?? null;
  if (state === null || state === 'connecting' || state === 'reconnecting') return { words: 'Lead is connecting…', age: null };
  if (state === 'working') return { words: 'Lead is working', age: ageSince(session!.since, now) };
  if (state === 'idle') return { words: 'Lead is waiting for work', age: ageSince(session!.since, now) };
  if (state === 'absent') return { words: 'Lead is restarting…', age: null };
  return { words: `Lead's session: ${state}`, age: ageSince(session?.since ?? null, now) };
}
const ageSince = (since: string | null | undefined, now: number) => since && Number.isFinite(Date.parse(since)) ? formatAge(since, now) : null;

/** The Waiting on you line: each open request named by what it is, in the owner's words. */
export function waitingLine(requests: readonly HumanRequestRow[]): string {
  if (requests.length === 0) return 'Nothing waits on you; a decision only you can make shows here.';
  const noun = new Map([['goals-and-priorities', 'priority call'], ['money-or-accounts', 'spend approval'], ['credentials-for-people', 'credential']]);
  const names = requests.map(row => noun.get(row.request.kind) ?? row.request.kind);
  return `${requests.length} ${requests.length === 1 ? 'thing' : 'things'}: ${names.join(', ')}`;
}

/**
 * The Lead page (GY-3211, GY-3602): a conversation with the Lead. Its replies are cards acted on
 * where they stand — approvals answered, decisions undone or questioned, incidents and filings
 * linked to their Task — and the live terminal is one click away on the Live session tab. The
 * terminal stays mounted behind the tabs, so the session state line and the message box, which
 * types into the pane as people always have, follow the same stream the terminal shows. Blockers
 * the Lead owes stay above it (GY-3394); Needs you carries only the owner's three decisions.
 */
export default function MasterPage({ work, observedAt, token, api, setSelected, status, action, busy }: Pick<Dashboard, 'work' | 'observedAt' | 'token' | 'api' | 'setSelected' | 'action' | 'busy'> & { status?: Dashboard['status'] }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [typed, setTyped] = useState<TypedLine[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [registry, setRegistry] = useState<RegistryRow[]>([]);
  const [team, setTeam] = useState<{ login: string; role: string }[] | null>(null);
  const [notMoving, setNotMoving] = useState<NotMovingRow[]>([]);
  const [tab, setTab] = useState<MasterTab>(() => masterTabFromHash(typeof location === 'undefined' ? '' : location.hash));
  const [draft, setDraft] = useState('');
  const [boxNote, setBoxNote] = useState('');
  const [pane, setPane] = useState<{ session: { state: string; since?: string | null } | null; mode: string; reason: string }>({ session: null, mode: 'connecting', reason: '' });
  const tabRefs = useRef<Partial<Record<MasterTab, HTMLButtonElement | null>>>({});
  const terminal = useRef<TerminalHandle | null>(null);
  const feed = useRef<HTMLOListElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onHash = () => setTab(masterTabFromHash(location.hash));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  const load = () => {
    void api('typed-input').then(body => setTyped(body.typed ?? []), () => {});
    // `view=rows` answers with the bare event array (src/events-history.ts), not an envelope.
    void api(`events?kind=${ledgerKinds.join(',')}&payload=details&order=desc&limit=60&view=rows`).then(body => setLedger(Array.isArray(body) ? body : []), () => {});
    void api('agent-registry/history?limit=60').then(body => setRegistry(Array.isArray(body) ? body : []), () => setRegistry([]));
    void api('team-access').then(body => setTeam(body.teammates ?? []), () => setTeam(null));
    void api('not-moving').then(body => setNotMoving(Array.isArray(body?.notMoving) ? body.notMoving : []), () => {});
    return api('master/messages').then(body => { setMessages(body.messages ?? []); setMessagesLoaded(true); }, () => { setMessagesLoaded(true); });
  };
  useEffect(() => {
    const poll = () => { void load(); };
    poll(); const timer = setInterval(poll, 15_000);
    return () => { clearInterval(timer); };
  }, [token]);
  const threads = messageThreads(messages);
  const showMessagesTab = threads.length > 0 || (tab === 'messages' && !messagesLoaded);
  const tabs: { id: MasterTab; label: string }[] = [
    { id: 'conversation', label: 'Conversation' },
    { id: 'live', label: 'Live session' },
    { id: 'history', label: 'History' },
    ...(showMessagesTab ? [{ id: 'messages' as const, label: 'Messages' }] : []),
  ];
  const activeTab: MasterTab = tab === 'messages' && !showMessagesTab ? 'conversation' : tab;
  const selectTab = (next: MasterTab) => {
    setTab(next);
    const hash = next === 'conversation' ? '#master' : `#master/${next}`;
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
  // GY-4000 AC-5: Not moving replaces Blocked; merge standing blockers once, carrying each blocker reason.
  const workByKey = new Map(work.map(item => [item.key, item]));
  const stalledByKey = new Map<string, NotMovingRow & { id?: string }>();
  for (const row of notMoving) {
    const item = workByKey.get(row.key);
    stalledByKey.set(row.key, { ...row, id: item?.id, blocker: item ? (item.blocker ?? undefined) : row.blocker });
  }
  for (const entry of owes) {
    if (stalledByKey.has(entry.key)) continue;
    const item = workByKey.get(entry.key);
    stalledByKey.set(entry.key, { id: entry.id, key: entry.key, title: entry.title, stage: item?.stage ?? 'ready', ageMs: entry.since !== null ? Math.max(0, now - entry.since) : 0, owner: 'nobody', blocker: entry.blocker });
  }
  const stalled = [...stalledByKey.values()].sort((a, b) => b.ageMs - a.ageMs || a.key.localeCompare(b.key));
  const stalledKeys = new Set(stalled.map(entry => entry.key));
  const goals = goalOrder(work.filter(item => !stalledKeys.has(item.key)));
  // Who this session is, as the conversation judges it: the operator may act on anything, an
  // invited maintainer may steer (message and priority), and everyone else watches.
  const actor = status?.actor ?? null;
  const operator = !!actor && actor.role === 'admin' && actor.sessionKind === 'human';
  const maySteer = operator || actor?.team === 'maintainer';
  const watchNote = 'You are watching: people who can steer the Lead may message and act.';
  const refusalFor = (row: HumanRequestRow) => humanOnlyRefusal(row.rule, actor ?? {});
  /** A priority change any steerer may undo; a hold, a release or a role pause is the operator's alone. */
  const mayUndo = (entry: FeedDecision) => !entry.undo ? false : entry.undo.target === 'registry' || entry.undo.command !== 'priority' ? operator : maySteer;
  const undoNote = 'Only the operator can undo a hold or a pause.';
  /** A pasted screenshot goes to the Lead as an attachment, as pasting into the terminal does. */
  const attach = (files: File[]) => {
    if (!terminal.current) { setBoxNote('Not sent: the Lead pane is still loading; try again in a moment.'); return; }
    setBoxNote('Sending the image to the Lead…');
    void terminal.current.attach(files).then(sent => setBoxNote(sent ? 'Image sent to the Lead.' : 'Not sent: ' + (pane.reason || 'this session cannot type into the Lead.')));
  };
  const pasteImage = (event: ClipboardEvent) => {
    const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    attach(files);
  };
  const requests = [...(status?.humanOnly ?? openHumanOnly(work.map(item => ({ work: item })), now))].sort((a, b) => b.waitedMs - a.waitedMs);
  const incidents = Array.isArray(status?.production?.incidents) ? status.production.incidents : [];
  const entries = leadFeed({ typed, requests, ledger, registry, incidents: incidents as never, work });
  useEffect(() => { if (feed.current) feed.current.scrollTop = feed.current.scrollHeight; }, [entries.length, activeTab]);
  useEffect(() => { if (activeTab === 'live') terminal.current?.focus(); }, [activeTab]);
  const prefill = (text: string) => { setDraft(text); box.current?.focus(); };
  const send = () => {
    const line = draft.trim();
    if (!line) return;
    if (terminal.current?.typeLine(line)) { setDraft(''); setBoxNote(''); setTimeout(() => { void api('typed-input').then(body => setTyped(body.typed ?? []), () => {}); }, 900); }
    else setBoxNote(pane.mode === 'control' ? 'Not sent: the Lead pane is reconnecting; try again in a moment.' : 'Not sent: ' + (pane.reason || 'this session cannot type into the Lead.'));
  };
  const undo = async (entry: FeedDecision) => {
    if (!entry.undo || busy) return;
    if (entry.undo.target === 'work') await action(entry.undo.workId, entry.undo.command, entry.undo.data);
    else await api('agent-registry/roles', entry.undo.body).then(() => setBoxNote(''), (error: unknown) => setBoxNote(`Not undone: ${error instanceof Error ? error.message : error}`));
    void load();
  };
  const line = leadStatus(pane, now);
  return <>
    <PageHeader title="Lead" fact="Steer the Lead and act on its cards."/>
    {stall && <p className="stall-alarm" role="alert">{stall}</p>}
    {stalled.length > 0 && <section className="panel" data-not-moving aria-label="Not moving"><h2>Not moving ({stalled.length})</h2>
      <ul className="master-owes">
        {stalled.slice(0, 5).map(entry => <li key={entry.key}>
          {entry.id ? <button className="text-button" onClick={() => setSelected(entry.id!)}>{notMovingLine(entry)}</button> : <span className="muted">{notMovingLine(entry)}</span>}
          {entry.blocker && <span className="muted master-owes-blocker" title={entry.blocker}>{entry.blocker}</span>}
        </li>)}
        {stalled.length > 5 && <li key="more"><span className="muted">+{stalled.length - 5} more not moving</span></li>}
      </ul>
    </section>}
    <div className="tabs master-tabs" role="tablist" aria-label="Lead views">
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
      <div className="terminal-mount" hidden={activeTab !== 'live'}>
        <LiveTerminal token={token} label="Live session"
          handle={api => { terminal.current = api; }}
          onSession={(session, mode, reason) => setPane({ session, mode, reason })}/>
      </div>
      {activeTab === 'conversation' && <section className="lead-conversation" aria-label="Conversation with the Lead">
        <p className="lead-status" role="status" data-lead-state={line.state}>
          <span className="lead-dot" aria-hidden="true"/>
          {line.words}{line.age && <> · {line.age}</>}
        </p>
        <div className="lead-body">
          <div className="lead-feed-col">
            <ol className="lead-feed" ref={feed} aria-label="Lead conversation, newest last">
              {entries.map((entry, index) => <li key={index} className="lead-entry" data-kind={entry.kind} data-who={entry.kind === 'message' ? entry.who : undefined}>
                {entry.kind === 'message' && <div className="lead-message"><span className="lead-name">{entry.who}</span><p>{entry.text}</p></div>}
                {entry.kind === 'approval' && <article className="lead-card approval">
                  <div className="lead-kind">Needs your approval · {decisionNoun(entry.row)}</div>
                  <h3>{humanAsk(entry.row.request)}</h3>
                  {entry.row.request.recommendation && <p className="lead-why">Recommended: {entry.row.request.recommendation}</p>}
                  <p className="muted">Waiting {formatAge(entry.row.request.at, now)}</p>
                  {refusalFor(entry.row) ? <>
                    <div className="lead-actions">{(choicesOf(entry.row).length ? choicesOf(entry.row) : [{ label: 'Answer', body: {} as Record<string, unknown> }]).map(choice => <button key={choice.label} type="button" disabled title={refusalFor(entry.row)!}>{choice.label}</button>)}</div>
                    <p className="muted">{refusalFor(entry.row)}</p>
                  </> : choicesOf(entry.row).length ? <div className="lead-actions">{choicesOf(entry.row).map(choice => <button key={choice.label} type="button" disabled={busy}
                      onClick={() => choice.input === 'none' ? void action(entry.row.id, entry.row.answer.post.command, choice.body) : setSelected(entry.row.id)}>{choice.label}</button>)}</div>
                    : <div className="lead-actions"><button type="button" disabled={busy} onClick={() => setSelected(entry.row.id)}>Answer in your own words</button></div>}
                </article>}
                {entry.kind === 'decision' && <article className="lead-card decision">
                  <div className="lead-kind">Decision</div>
                  <p className="lead-what">{entry.what}</p>
                  {entry.why && <MoreDetails className="lead-why" summary="Why">{entry.why}</MoreDetails>}
                  <div className="lead-actions">
                    <button type="button" disabled={!maySteer || busy} title={!maySteer ? watchNote : undefined} onClick={() => prefill(`Why: ${entry.what}`)}>Ask why</button>
                    <button type="button" disabled={!maySteer || busy} title={!maySteer ? watchNote : undefined} onClick={() => prefill(`Do it differently: ${entry.what}`)}>Do it differently</button>
                    {entry.undo && <button type="button" disabled={busy || !mayUndo(entry)} title={mayUndo(entry) || !maySteer ? undefined : undoNote} onClick={() => void undo(entry)}>Undo</button>}
                  </div>
                  {!maySteer ? <p className="muted">{watchNote}</p> : entry.undo && !mayUndo(entry) && <p className="muted">{undoNote}</p>}
                </article>}
                {entry.kind === 'incident' && <article className="lead-card incident">
                  <div className="lead-kind">Incident</div>
                  <p className="lead-what">{entry.incident.key} {entry.incident.status === 'failed' ? 'failed to deploy' : 'is not live yet'}</p>
                  <p className="lead-why">{entry.incident.reason}</p>
                  <p className="muted">The Lead keeps the release line moving; you are not needed.</p>
                  <div className="lead-actions"><button type="button" onClick={() => setSelected(entry.incident.workId)}>Open the Task</button></div>
                </article>}
                {entry.kind === 'task' && <article className="lead-card task">
                  <div className="lead-kind">Filed</div>
                  <p className="lead-what"><button type="button" className="text-button" onClick={() => setSelected(entry.item.id)}>{entry.item.title}</button></p>
                </article>}
              </li>)}
              {entries.length === 0 && <li className="lead-entry lead-empty"><p className="muted">Nothing yet: message the Lead, or wait for its replies.</p></li>}
            </ol>
            {maySteer ? <form className="lead-box" onSubmit={event => { event.preventDefault(); send(); }}>
              <button type="button" aria-label="Attach an image" title="Attach an image" onClick={() => fileInput.current?.click()}>＋</button>
              <input type="file" accept="image/png,image/jpeg" hidden ref={fileInput} onChange={event => { const file = event.target.files?.[0]; if (file) attach([file]); event.target.value = ''; }}/>
              <label htmlFor="lead-message" className="sr-only">Message the Lead</label>
              <input id="lead-message" ref={box} value={draft} onChange={event => setDraft(event.target.value)} onPaste={pasteImage} placeholder="Tell the Lead what to do, or paste a screenshot"/>
              <button type="submit" disabled={!draft.trim() || pane.mode !== 'control'}>Send</button>
            </form> : <p className="lead-box lead-box-note muted">{watchNote}</p>}
            {maySteer && boxNote && <p className="lead-box-note muted" role="alert">{boxNote}</p>}
            {maySteer && pane.mode !== 'control' && !boxNote && <p className="lead-box-note muted">{pane.reason || 'Connecting to the Lead…'}</p>}
          </div>
          <aside className="lead-rail" aria-label="Lead context">
            <div>
              <h3>Goal order</h3>
              {goals.length ? <ol>{goals.map(goal => <li key={goal.id}><button className="text-button" onClick={() => setSelected(goal.id)}><span data-title>{goal.title}</span></button></li>)}</ol> : <p className="muted">No open goals; file one on Work and it shows here.</p>}
            </div>
            <div>
              <h3>Waiting on you</h3>
              <p>{waitingLine(requests)}</p>
            </div>
            <div>
              <h3>Who can steer</h3>
              <p>{steerers(team ?? [], operator).join(', ')}</p>
            </div>
          </aside>
        </div>
      </section>}
      {/* GY-3514: what people typed into the Lead, newest first. */}
      {activeTab === 'history' && <section className="panel typed-input" aria-label="Typed into the Lead"><h2>Typed into the Lead</h2>
        {typed.length > 0
          ? <ol>{typed.map((entry, index) => <li key={index}><b>{entry.who}</b> <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time> <code>{entry.text}</code></li>)}</ol>
          : <p className="muted">Nothing typed into the Lead yet; what you send shows here.</p>}
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

/**
 * The choices an approval offers, recommended first — the request's own verb-and-object buttons.
 * A choice that needs no words answers in place; one that needs words or a secret opens the Task.
 */
function choicesOf(row: HumanRequestRow) {
  return recommendedFirst(row.choices ?? []);
}
function decisionNoun(row: HumanRequestRow): string {
  return ({ 'goals-and-priorities': 'priorities', 'money-or-accounts': 'spend', 'credentials-for-people': 'credentials' } as Record<string, string>)[row.request.kind] ?? row.request.kind;
}
