import { PRODUCT_NAME } from '../src/model/product';
import { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { type Work } from '../src/model';
import { isBoard, type Board } from './groups';
import './style.css';
import type { IntegrationJob } from '../src/coordination';
import type { Dashboard } from './pages/dashboard';
import { allRouteIds, oldRouteRedirects, redirects, resolveViewId, route, viewFor } from './pages';
import type { WorkFilter } from './pages/work';
import TopBar, { MainTopBar } from './components/top-bar';
import { useFeatures } from './features';
import LoginPage, { HUMAN_SESSION_KEY, RECONNECTING, SESSION_ENDED, SIGN_IN_NEEDED, endedSession, storedToken, wantsSignIn } from './pages/login';
import WorkDetails, { useOpenedWork } from './pages/work-details';
import CreateWork from './pages/create-work';
import { initialView } from './pages/setup';
import { requestedView } from '../src/model/setup-checklist';
const itemLink = (hash: string) => /^#([A-Z][A-Z0-9]*-[A-Z0-9]+)$/.exec(hash)?.[1] ?? null;
import { idempotencyKey } from './idempotency-key';
import { poll } from './poll';
import { ShippedToast, finishedGoal } from './fun';
import { applyTheme } from './theme';
import { boot } from './boot';
import KeyboardNav from './keyboard';

applyTheme();
boot();

/**
 * The dashboard shell: session state, polling, the four-place top bar generated from the view
 * registry, and the page it selects — or the open work item's page. Pages live under web/pages/.
 */
function App() {
  const [token, setToken] = useState(storedToken);
  const sessionEpoch = useRef(0);
  // Viewing on this machine needs no sign-in; the form shows once an action asks for it or the local read is refused.
  const [signingIn, setSigningIn] = useState(wantsSignIn);
  const [draftToken, setDraftToken] = useState('');
  const [work, setWork] = useState<Work[]>([]);
  // The last snapshot's cursor (GY-3231): a poll asks for what changed since it, and a delta answer
  // keeps the settled summaries it already holds, so a poll carries the open items, not the ledger.
  const snapshotCursor = useRef('');
  // A mutation refresh supersedes background reads already in flight, including their errors.
  const refreshVersion = useRef(0);
  const keepSnapshot = (items: { work: Work[]; cursor?: string; delta?: boolean }) => {
    snapshotCursor.current = items.cursor ?? '';
    setWork(previous => {
      if (!items.delta) return items.work;
      const fresh = new Set(items.work.map(w => w.id)), number = (w: Work) => Number(w.key.split('-').pop());
      return [...items.work, ...previous.filter(w => (w.summary as unknown) === true && !fresh.has(w.id))].sort((a, b) => number(a) - number(b));
    });
  };
  const [status, setStatus] = useState<any>(null);
  const [board, setBoard] = useState<Board | null>(null), keepBoard = (value: unknown) => { if (isBoard(value)) setBoard(value); }; // GET /api/board (GY-200): the Work page's groups; the last one read stands through a failed read
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  // GY-3600: the address names the page and the Work filter; the old Now and Shipped routes open Work filtered.
  const [view, setView] = useState(() => resolveViewId(initialView([...allRouteIds, ...Object.keys(redirects)])));
  const [filter, keepFilter] = useState<WorkFilter | null>(() => route(location.hash || '#work', location.search).filter);
  const setFilter = (next: WorkFilter | null) => {
    const search = new URLSearchParams(location.search); if (next) search.set('filter', next); else search.delete('filter');
    history.replaceState(null, '', `${location.pathname}${search.size ? `?${search}` : ''}#work`); keepFilter(next);
  };
  useEffect(() => { if (/^#(now|shipped)$/.test(location.hash)) setFilter(filter); }, []);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [observedAt, setObservedAt] = useState(Number.NaN);
  const [jobs, setJobs] = useState<IntegrationJob[]>([]);
  const [editingRequirements, setEditingRequirements] = useState(false);
  const [query, setQuery] = useState('');
  const [palette, setPalette] = useState(false);
  async function api(path: string, data?: unknown) {
    const response = await fetch(`/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey() }, body: data === undefined ? undefined : JSON.stringify(data) });
    const body = await response.json(); if (!response.ok) throw new Error(!token && response.status === 401 ? SIGN_IN_NEEDED : body.error + (body.issues ? `: ${body.issues.map((i: any) => i.message).join(', ')}` : '')); return body;
  }
  async function signOut() {
    if (token.startsWith('gyh_')) {
      try {
        const response = await fetch('/api/sign-out', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok && response.status !== 401) throw new Error('Unable to sign out. Please retry.');
      } catch { setError('Unable to sign out. Check your connection and retry.'); return; }
    }
    forget();
  }
  /** Drop this browser's stored session and return to the sign-in page, without asking the server. */
  function forget() {
    sessionEpoch.current++; snapshotCursor.current = ''; setSigningIn(true); setBusy(false); sessionStorage.removeItem(HUMAN_SESSION_KEY); localStorage.removeItem(HUMAN_SESSION_KEY); setToken(''); setDraftToken(''); setStatus(null); setBoard(null); setWork([]); setJobs([]); setView('work'); setEditingRequirements(false); setObservedAt(Number.NaN); setSelected(null); setEvents([]); setCreating(false); setConnected(false); setLastUpdated(null); setError('');
  }
  /** The sign-in page's first read: once the status reply accepts the token, the work snapshot, then the dashboard. */
  async function firstLoad(system: any, signal: AbortSignal) {
    const epoch = sessionEpoch.current, headers = { Authorization: `Bearer ${token}` }, response = await fetch('/api/work-snapshot', { headers, signal });
    if (await endedSession(response)) throw Object.assign(new Error(SESSION_ENDED), { unauthorized: true });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `Unable to load dashboard (${response.status}).`);
    const items = await response.json(), served = await fetch('/api/board', { headers, signal }).then(r => r.ok ? r.json() : null, () => null); if (signal.aborted || epoch !== sessionEpoch.current) throw new Error('Superseded');
    keepSnapshot(items); keepBoard(served); setJobs(items.jobs ?? []); setObservedAt(Date.parse(items.now)); setStatus(system); setConnected(true); setLastUpdated(new Date().toLocaleTimeString()); setError('');
  }
  async function refresh(epoch: number) { const version = ++refreshVersion.current; const [items, system, served] = await Promise.all([api('work-snapshot'), api('status'), api('board').catch(() => null)]); if (epoch !== sessionEpoch.current || version !== refreshVersion.current) return; keepSnapshot(items); keepBoard(served); setJobs(items.jobs ?? []); setObservedAt(Date.parse(items.now)); setStatus(system); setConnected(true); setLastUpdated(new Date().toLocaleTimeString()); setError(''); }
  // The sign-in page verifies the token first (web/pages/login.tsx); polling starts once it is accepted.
  const live = !!status;
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController(); const epoch = sessionEpoch.current; let active = true;
    const load = async () => {
      const version = refreshVersion.current;
      try {
        const read = async (path: string) => {
          const response = await fetch(`/api/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
          // GY-4072: only the server saying the session ended drops it; a refusal shows its reason, anything else reconnects.
          if (await endedSession(response)) throw Object.assign(new Error(SESSION_ENDED), { unauthorized: true });
          if (response.status === 403) throw Object.assign(new Error('refused'), { refusal: (await response.json().catch(() => null))?.error });
          if (!response.ok) throw new Error(RECONNECTING);
          return response.json();
        };
        const [items, system, served] = await Promise.all([read(snapshotCursor.current ? `work-snapshot?since=${encodeURIComponent(snapshotCursor.current)}` : 'work-snapshot'), read('status'), read('board').catch(() => null)]);
        if (active && epoch === sessionEpoch.current && version === refreshVersion.current) { keepSnapshot(items); keepBoard(served); setJobs(items.jobs ?? []); setObservedAt(Date.parse(items.now)); setStatus(system); setConnected(true); setLastUpdated(new Date().toLocaleTimeString()); setError(''); }
      } catch (e: any) {
        if (!active || epoch !== sessionEpoch.current || version !== refreshVersion.current) return;
        if (e.unauthorized) { forget(); setError(e.message); }
        else { setConnected(false); setError(e.refusal ?? RECONNECTING); }
      }
    };
    // A hidden tab's timers are throttled to once a minute, so returning to the tab reads at once.
    const polling = poll(load, 5000), visible = () => { if (document.visibilityState === 'visible') polling.now(); };
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; controller.abort(); polling.stop(); document.removeEventListener('visibilitychange', visible); };
  }, [token, live]);
  // The browser tab names the project it serves (GY-3306): gh · OWNER/REPO from the same status
  // reply the header's project name renders, so an operator's tabs tell installs apart. Mainworks
  // stands until that identity arrives — and returns on sign-out — so a tab is never untitled,
  // undefined, or a stale other project's name.
  const project = typeof status?.repository === 'string' && status.repository ? status.repository : null;
  useEffect(() => { document.title = project ? `${PRODUCT_NAME} · ${project}` : PRODUCT_NAME; }, [project]);
  useEffect(() => { setEvents([]); setEditingRequirements(false); window.scrollTo?.(0, 0); }, [selected, token]);
  // A read answered while the same item is still open is kept even when a work poll re-ran the effect meanwhile, so a later failed read never leaves history empty.
  const selectedRef = useRef(selected); selectedRef.current = selected;
  useEffect(() => { const epoch = sessionEpoch.current, current = () => selectedRef.current === selected && epoch === sessionEpoch.current; if (selected) void api(`events?work=${selected}&payload=details`).then((rows: any[]) => { if (current()) setEvents(rows.map(row => 'details' in row ? (({ details, ...rest }) => ({ ...rest, payload: { details } }))(row) : row)); }).catch(e => { if (current()) setError(e.message); }); }, [selected, work]);
  // GY-3268: an item that goes live while the page is open gets a toast naming its builder, and confetti;
  // GY-3601: live means merged and carried by the live commit, when one is known.
  const merged = useRef<Map<string, boolean> | null>(null);
  const celebratedGoals = useRef<Set<string>>(new Set());
  const [shipped, setShipped] = useState<{ item: Work; goal: string | null } | null>(null);
  useEffect(() => {
    if (!work.length) return;
    const waiting = typeof status?.live?.commit === 'string' && Array.isArray(status.live.waiting) ? new Set<string>(status.live.waiting) : new Set<string>();
    const isLive = (w: Work) => w.stage === 'done' && !!(w.delivery?.mergedAt ?? w.observation?.mergedAt) && !waiting.has(w.key);
    const fresh = merged.current ? work.filter(w => isLive(w) && merged.current!.get(w.id) === false) : [];
    merged.current = new Map(work.map(w => [w.id, isLive(w)]));
    if (!fresh.length) return;
    const last = fresh.at(-1)!;
    const goal = finishedGoal(last, work, isLive);
    const celebrate = goal && !celebratedGoals.current.has(goal) ? goal : null;
    if (celebrate) celebratedGoals.current.add(celebrate);
    setShipped({ item: last, goal: celebrate });
  }, [work, status]);
  useEffect(() => { if (!shipped) return; const timer = setTimeout(() => setShipped(null), 8000); return () => clearTimeout(timer); }, [shipped]);
  // Every page has an address (GY-3322, GY-3598): following a link to #costs opens Costs under Settings,
  // and old routes like #master redirect to their new place (#lead).
  useEffect(() => {
    const follow = () => {
      const page = requestedView(location.hash, [...allRouteIds, ...Object.keys(redirects)]).view;
      if (page) {
        const target = resolveViewId(page);
        if (oldRouteRedirects[page] && page !== 'settings') {
          history.replaceState(null, '', `${location.pathname}${location.search}#${target}${location.hash.startsWith(`#${page}/`) ? location.hash.slice(1 + page.length) : ''}`);
        }
        setSelected(null);
        setView(target);
        if (target === 'work') setFilter(route(location.hash, location.search).filter ?? (redirects[page] ?? null));
      }
    };
    addEventListener('hashchange', follow); return () => removeEventListener('hashchange', follow);
  }, []);
  // GY-3415: #GY-N is an item's address, so the link the master hands an owner opens that item with its Answer.
  const [linked, setLinked] = useState(() => itemLink(location.hash));
  useEffect(() => { const follow = () => setLinked(itemLink(location.hash)); addEventListener('hashchange', follow); return () => removeEventListener('hashchange', follow); }, []);
  useEffect(() => { const found = linked && work.find(w => w.key === linked); if (found) { setSelected(found.id); setLinked(null); } }, [work, linked]);
  const item = useOpenedWork(work, selected, token, api, sessionEpoch, setError);
  async function action(id: string, command: string, data: unknown = {}) { const epoch = sessionEpoch.current; setBusy(true); try { await api(`work/${id}/${command}`, data); if (epoch !== sessionEpoch.current) return; await refresh(epoch); } catch (e) { if (epoch === sessionEpoch.current) setError((e as Error).message); } finally { if (epoch === sessionEpoch.current) setBusy(false); } }
  const { features, operatorAgents, operatorAgentsError } = useFeatures(token, !!status, api, status?.actor?.role === 'admin', work.some(w => w.scenarioRequirements?.length > 0));
  const dashboard: Dashboard = { token, work, board, status, error, connected, lastUpdated, view, setView, filter, setFilter, selected, setSelected, creating, setCreating, busy, setBusy, observedAt, jobs, query, setQuery, operatorAgents, operatorAgentsError, features, events, editingRequirements, setEditingRequirements, sessionEpoch, api, refresh, action, setError, signOut };
  if (!status) return <LoginPage signingIn={signingIn} setSigningIn={setSigningIn} token={token} error={error} signOut={signOut} forget={forget} setError={setError} sessionEpoch={sessionEpoch} setToken={setToken} draftToken={draftToken} setDraftToken={setDraftToken} host={location.host} onVerified={firstLoad}/>;
  // One page at a time: one Mainworks top bar across every page; an open item replaces the page it was opened from, and "← Back" returns to it.
  return <div className="shell"><MainTopBar {...dashboard}/>
    <main className="main">{error && <div role="alert" className="notice danger">{error}{error === SIGN_IN_NEEDED && <> <button type="button" onClick={signOut}>Sign in</button></>}</div>}
      <TopBar {...dashboard} onPalette={() => setPalette(true)}/>{/* Keyed by item: a task opened from another open task starts on its own first tab, never on the last task's open diffs. */item ? <WorkDetails key={item.id} {...dashboard} item={item}/> : viewFor(view).render(dashboard)}</main>
    {creating && <CreateWork {...dashboard}/>}
    {shipped && <ShippedToast key={shipped.item.id} item={shipped.item} goal={shipped.goal} onClose={() => setShipped(null)}/>}
    <KeyboardNav dashboard={dashboard} palette={palette} setPalette={setPalette}/>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
