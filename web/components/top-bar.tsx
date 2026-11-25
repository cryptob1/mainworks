import { COMMAND_NAME, PRODUCT_NAME } from '../../src/model/product';
import { useState } from 'react';
import { glossary, type GlossaryTerm } from '../glossary';
import Invite from './invite';
import Term from './term';
import { firstViewOfSection, sections, viewFor, visibleViews, type Section, type View } from '../pages';
import type { Dashboard } from '../pages/dashboard';
import { mergedAt, shippedCounts } from '../groups';
import { workersView } from '../workers-view';
import type { Work } from '../../src/model';
import { OpenApp } from './where-it-runs';
import { masterOwes } from '../pages/master';
import { setTheme, useTheme } from '../theme';

/** The commit as the release line shows it: the first 8 characters, the whole SHA in the title. */
const shortSha = (sha: string) => <span className="mono" title={sha}>{sha.slice(0, 8)}</span>;

/**
 * GY-3483: the header's strip says what is happening now — live agent sessions (the Workers page's
 * open ones plus the master's pane), the checks running (merge trials and a batch gate on main, as
 * /api/status counts them) and today's merges. Each number rides a data attribute for readers and tests.
 */
function ActivityStrip({ work, observedAt, status }: { work: Work[]; observedAt: number; status?: Dashboard['status'] }) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const agents = workersView(work, new Date(now)).running.filter(row => !row.stale && row.roleKind !== 'master').length + (status?.setup?.panes?.master ? 1 : 0);
  const checks = typeof status?.checksRunning === 'number' ? status.checksRunning : 0;
  const today = new Date(now).setHours(0, 0, 0, 0);
  const merged = work.filter(item => item.stage === 'done' && !!(item.delivery?.mergedAt ?? item.observation?.mergedAt) && mergedAt(item) >= today).length;
  const plural = (n: number, word: string) => <><span className="mono">{n}</span> {word}{n === 1 ? '' : 's'}</>;
  return <p className="activity-strip" aria-label="Activity" data-on-shift={agents} data-in-trial={checks} data-shipped-tonight={merged}>
    <span className="beacon" aria-hidden="true"/>{plural(agents, 'agent')} working
    <span aria-hidden="true"> · </span>{plural(checks, 'check')} running
    <span aria-hidden="true"> · </span><span className="mono">{merged}</span> merged today
  </p>;
}

/**
 * Shipped and going live (GY-3452): the week's merges the live commit contains, and those it does
 * not carry yet — the Work page card's one count, so the two never disagree. With no live commit
 * known the release line already says so, and the strip stays out of the way.
 */
function ShippedStrip({ work, observedAt, live }: { work: Work[]; observedAt: number; live?: { commit?: unknown; waiting?: unknown } | null }) {
  if (typeof live?.commit !== 'string') return null;
  const { shipped, waiting } = shippedCounts(work, live, Number.isNaN(observedAt) ? Date.now() : observedAt);
  return <p className="shipped-strip" aria-label="Shipped" data-shipped={shipped.length} data-waiting={waiting.length}>
    <span className="mono">{shipped.length}</span> shipped · <span className="mono">{waiting.length}</span> going live
  </p>;
}

/** "· <n> changes not live yet", or nothing when the live commit carries every merge. */
const notLive = (pending: number | null) => pending ? <> · {pending} {pending === 1 ? 'change' : 'changes'} not live yet</> : null;

/**
 * The board's one release line (GY-1979), shown only when it says something (GY-3483): "Live:
 * <sha8>" with the merged changes the live commit does not carry yet. A declared node application
 * (GY-2976) reads what the serve pass last served, with its required cases' verdict (GY-2983) once
 * one is recorded, the last build failure and a link to the declared URL; a managed install
 * (GY-2964) reads the deploy record naming its repository; elsewhere the production watch's report
 * (src/model/release.ts), with its open deployment incidents. With no deploy configured, or
 * nothing observing production, there is no line — Settings → Delivery says so.
 */
export function ReleaseLine({ status }: { status?: Dashboard['status'] }) {
  // The declared serve's serving, read from master status's serving block over the API.
  const serving = status?.serving as { commit?: unknown; main?: unknown; pending?: unknown; serve?: { url?: unknown; failure?: { commit?: unknown; reason?: unknown } | null; check?: { verified?: unknown; case?: unknown; step?: unknown } | null } | null | undefined } | null | undefined;
  const declared = serving?.serve && typeof serving.serve === 'object' ? serving.serve : null;
  if (declared) {
    const commit = typeof serving!.commit === 'string' && serving!.commit ? serving!.commit : null;
    const main = typeof serving!.main === 'string' && serving!.main ? serving!.main : null;
    const pending = typeof serving!.pending === 'number' ? serving!.pending : null;
    const failureCommit = declared.failure && typeof declared.failure.commit === 'string' ? declared.failure.commit : null;
    const failure = failureCommit ? { commit: failureCommit, reason: typeof declared.failure?.reason === 'string' ? declared.failure.reason : '' } : null;
    const check = declared.check && typeof declared.check === 'object' ? declared.check : null;
    const url = typeof declared.url === 'string' && declared.url ? declared.url : null;
    let host = url ?? '';
    try { host = url ? new URL(url).host : ''; } catch { /* the declared text stands */ }
    return <p className="release-line" data-release-line={commit ? 'serving' : 'unserved'}>
      {commit
        ? <>Live: {shortSha(commit)}{notLive(pending)}
          {check && check.verified === true && <> · verified</>}
          {check && check.verified === false && typeof check.case === 'string' && <> · failing {check.case}{typeof check.step === 'string' && check.step ? <>: {check.step}</> : null}</>}</>
        : <>No serve yet{main && <> · main {shortSha(main)}</>}</>}
      {failure && <> · build of {shortSha(failure.commit)} failed: {failure.reason.slice(0, 140)}</>}
      {url && <> · <a href={url}>Served · {host}</a></>}
    </p>;
  }
  const deploy = status?.deploy as { configured?: unknown; tip?: unknown; pending?: unknown } | null | undefined;
  if (deploy && typeof deploy === 'object') {
    if (deploy.configured !== true || typeof deploy.tip !== 'string' || !deploy.tip) return null;
    return <p className="release-line" data-release-line="serving">Live: {shortSha(deploy.tip)}{notLive(typeof deploy.pending === 'number' ? deploy.pending : null)}</p>;
  }
  const watch = status?.production as { observedAt?: unknown; serving?: unknown; error?: unknown; pending?: unknown; incidents?: unknown } | null | undefined;
  if (!watch?.observedAt || typeof watch.serving !== 'string' || !watch.serving || watch.error) return null;
  const incidents = Array.isArray(watch.incidents) ? watch.incidents.length : 0;
  const pending = Array.isArray(watch.pending) ? watch.pending.filter(entry => typeof entry === 'string').length : 0;
  return <p className="release-line" data-release-line="serving" data-healthy={incidents === 0} data-pending={pending}>
    Live: {shortSha(watch.serving)}{notLive(pending)}
    {incidents > 0 && <> · <strong>unhealthy: {incidents} open deployment {incidents === 1 ? 'incident' : 'incidents'}</strong></>}
  </p>;
}

/**
 * GY-3399: the week's batch-gate reverts and gates removed — lessons the master turned into code,
 * whose item's delivery removed them — as /api/status's `thisWeek` reports them, each count
 * followed by links that open its items. One line, shown only while either count is above zero (GY-3483).
 */
function WeekLine({ status, work, open }: { status?: Dashboard['status']; work: Work[]; open?: (id: string) => void }) {
  const week = status?.thisWeek as { reverts?: unknown; revertedItems?: unknown; gatesRemoved?: unknown; gatesRemovedItems?: unknown } | null | undefined;
  if (!week || typeof week.reverts !== 'number' || typeof week.gatesRemoved !== 'number' || (!week.reverts && !week.gatesRemoved)) return null;
  const keys = (value: unknown) => Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [];
  const links = (value: unknown) => keys(value).map(key => {
    const id = work.find(item => item.key === key)?.id;
    return <span key={key}> <a className="mono" href={`#${key}`} onClick={event => { if (id && open) { event.preventDefault(); open(id); } }}>{key}</a></span>;
  });
  return <p className="week-line" data-reverts={week.reverts} data-gates-removed={week.gatesRemoved}>
    This week: <span className="mono">{week.reverts}</span> {week.reverts === 1 ? 'revert' : 'reverts'}{links(week.revertedItems)}
    <span aria-hidden="true"> · </span><span className="mono">{week.gatesRemoved}</span> {week.gatesRemoved === 1 ? 'gate' : 'gates'} removed{links(week.gatesRemovedItems)}
  </p>;
}

/** GY-3517: the compute machines the loop's latest probe reads away only because their host helper is too old for this release. */
export const hostsNeedingUpdate = (status?: Dashboard['status']): string[] =>
  Array.isArray(status?.hosts) ? status.hosts.filter((host: { away?: unknown; update?: unknown; host?: unknown }) => host?.away === true && host.update === true && typeof host.host === 'string').map((host: { host: string }) => host.host) : [];
/** The one command that updates a machine's helper: its printed script is then run there with sudo. */
export const hostUpdateCommand = 'mainworks host prepare';

/** GY-3517: one line while any compute machine needs its helper updated, naming them and the one command; gone once the next probe reads them ready. */
function HostUpdateLine({ status }: { status?: Dashboard['status'] }) {
  const names = hostsNeedingUpdate(status);
  if (!names.length) return null;
  return <p className="host-update-line" role="status" data-host-update={names.join(' ')}>
    <strong>Compute machines need an update: {names.join(', ')}</strong> · run <span className="mono">{hostUpdateCommand}</span>, then the script it prints on each with sudo
  </p>;
}

/** The glossary entry a tab's label names, by the label itself or by its singular. */
const meaning = (label: string): GlossaryTerm | null => {
  const key = label.toLowerCase(), singular = key.replace(/s$/, '');
  return key in glossary ? key as GlossaryTerm : singular in glossary ? singular as GlossaryTerm : null;
};

/** GY-3598: one Caretaker fault, linking to the place where it is shown. */
export interface CaretakerFault { summary: string; view: string }

/**
 * GY-3598: what the Caretaker pill reports. Once GY-3593 reports `status.caretaker`, it reads that;
 * until then, it reads from master status attention and the stall alarm.
 */
function caretakerSummary(status: Dashboard['status'], work: Work[], now: number): { faults: CaretakerFault[]; minutesAgo: number } {
  const reported = status?.caretaker as { faults?: { summary?: string; view?: string }[]; checkedAt?: string } | null | undefined;
  const checkedAtMs = typeof reported?.checkedAt === 'string' ? Date.parse(reported.checkedAt)
    : typeof status?.now === 'string' ? Date.parse(status.now) : now;
  const minutesAgo = Number.isFinite(checkedAtMs) ? Math.max(0, Math.floor((now - checkedAtMs) / 60_000)) : 0;
  if (reported && Array.isArray(reported.faults)) {
    return {
      faults: reported.faults.map(f => ({ summary: String(f.summary ?? 'Fault'), view: typeof f.view === 'string' ? f.view : 'lead' })),
      minutesAgo,
    };
  }
  const faults: CaretakerFault[] = [];
  if (typeof status?.setup?.stallAlarm === 'string' && status.setup.stallAlarm.trim()) {
    faults.push({ summary: status.setup.stallAlarm, view: 'lead' });
  }
  if (typeof status?.setup?.checkoutTrust === 'string' && status.setup.checkoutTrust.trim()) {
    faults.push({ summary: status.setup.checkoutTrust, view: 'setup' });
  }
  if (typeof status?.setup?.stepFailure === 'string' && status.setup.stepFailure.trim()) {
    faults.push({ summary: status.setup.stepFailure, view: 'setup' });
  }
  if (typeof status?.setup?.fetchRefusal === 'string' && status.setup.fetchRefusal.trim()) {
    faults.push({ summary: status.setup.fetchRefusal, view: 'setup' });
  }
  if (typeof status?.setup?.workerGrowth === 'string' && status.setup.workerGrowth.trim()) {
    faults.push({ summary: status.setup.workerGrowth, view: 'needs-you' });
  }
  if (Array.isArray(status?.fleet?.attention)) {
    for (const line of status.fleet.attention) {
      if (typeof line === 'string' && line.trim()) faults.push({ summary: line, view: 'agents' });
    }
  }
  if (Array.isArray(status?.production?.incidents)) {
    for (const inc of status.production.incidents) {
      faults.push({ summary: typeof inc === 'string' ? inc : 'Production incident', view: 'delivery' });
    }
  }
  if (Array.isArray(status?.starvedJobs)) {
    for (const job of status.starvedJobs) {
      faults.push({ summary: typeof job?.error === 'string' ? job.error : 'Starved job', view: 'lead' });
    }
  }
  if (hostsNeedingUpdate(status).length > 0) {
    faults.push({ summary: `Hosts need update: ${hostsNeedingUpdate(status).join(', ')}`, view: 'workers' });
  }
  for (const owed of masterOwes(work, now)) {
    faults.push({ summary: `${owed.key}: ${owed.blocker}`, view: 'lead' });
  }
  return { faults, minutesAgo };
}

/** Where Pause team keeps each role's concurrency so Resume team brings it back. */
const pausedConcurrencyKey = 'graphyard.pausedConcurrency';

/** GY-3598: the Mainworks product mark from the approved prototype, reading the active theme tokens. */
function MainworksMark() {
  return <svg className="brand-mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="30" height="30" fill="none" aria-hidden="true">
    <rect width="64" height="64" rx="14" fill="var(--surface)"/>
    <path d="M12 50V24L26 34V24L40 34V24L54 34V50Z" stroke="var(--up-next)" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round"/>
    <rect x="19" y="40" width="8" height="6" rx="1.5" fill="var(--blocked)"/>
    <rect x="31" y="40" width="8" height="6" rx="1.5" fill="var(--up-next)" opacity=".45"/>
    <rect x="43" y="40" width="5" height="6" rx="1.5" fill="var(--up-next)" opacity=".45"/>
  </svg>;
}

/**
 * GY-3598: the one Mainworks top bar rendered on every page — product mark and name, exactly four
 * navigation links (Home, Work, Lead, Settings) with the current one marked, the Caretaker pill,
 * and Pause team. At 390 px, CSS turns `<nav aria-label="Main">` into a fixed bottom tab bar.
 */
export function MainTopBar(dashboard: Dashboard) {
  const { view, setView, setSelected, status, work, observedAt, api, refresh, sessionEpoch, setError } = dashboard;
  const currentSection: Section = viewFor(view).section ?? 'work';
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const { faults, minutesAgo } = caretakerSummary(status, work, now);
  const owesCount = masterOwes(work, now).length;
  const [pausing, setPausing] = useState(false);

  const roles: { role: string; accounts: string[]; concurrency: number }[] = Array.isArray(status?.fleet?.roles) ? status.fleet.roles : [];
  const managedRoles = roles.filter(r => r.role === 'worker' || r.role === 'reviewer');
  const allPaused = managedRoles.length > 0 && managedRoles.every(r => r.concurrency === 0);
  // Only the owner can change the fleet, and only once it has worker or reviewer roles to pause.
  const cannotPause = status?.actor?.role !== 'admin' ? 'Only the owner can pause the team'
    : managedRoles.length === 0 ? 'No workers or reviewers to pause yet' : null;

  const go = (section: Section) => {
    const target = firstViewOfSection(dashboard, section);
    setSelected(null);
    setView(target.id);
    if (typeof history !== 'undefined' && typeof location !== 'undefined') {
      history.replaceState(null, '', `${location.pathname}${location.search}#${section}`);
    }
  };

  const openFaults = () => {
    const target = faults[0]?.view ?? 'lead';
    setSelected(null);
    setView(target);
    if (typeof history !== 'undefined' && typeof location !== 'undefined') {
      history.replaceState(null, '', `${location.pathname}${location.search}#${target}`);
    }
  };

  const togglePause = async () => {
    if (pausing || cannotPause) return;
    setPausing(true);
    try {
      // Resume restores each role's concurrency from before the pause, remembered in this browser.
      const remembered: Record<string, number> = JSON.parse(localStorage.getItem(pausedConcurrencyKey) ?? '{}');
      if (!allPaused) localStorage.setItem(pausedConcurrencyKey, JSON.stringify(Object.fromEntries(managedRoles.map(r => [r.role, r.concurrency]))));
      await api('agent-registry/apply', {
        roles: managedRoles.map(r => ({ name: r.role, accounts: r.accounts, concurrency: allPaused ? remembered[r.role] || 1 : 0 })),
        reason: allPaused ? 'Resumed team from top bar' : 'Paused team from top bar',
      });
      await refresh(sessionEpoch.current);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPausing(false);
    }
  };

  const faultHref = `#${faults[0]?.view ?? 'lead'}`;
  const pillText = faults.length > 0
    ? `Caretaker: ${faults.length} ${faults.length === 1 ? 'fault' : 'faults'} · ${minutesAgo} min ago`
    : `Caretaker ✓ ${minutesAgo} min ago`;

  return <header className="main-top-bar">
    <a href="#home" className="brand-link" onClick={event => { event.preventDefault(); go('home'); }}>
      <MainworksMark/><span className="brand brand-name">{COMMAND_NAME}</span>
    </a>
    <nav className="main-nav" aria-label="Main">
      {sections.map(place => {
        const active = currentSection === place.id;
        return <a key={place.id} href={`#${place.id}`} data-nav={place.id} className={active ? 'nav-link active' : 'nav-link'} aria-current={active ? 'page' : undefined} onClick={event => { event.preventDefault(); go(place.id); }}>
          {place.label}{place.id === 'lead' && owesCount > 0 && <> <span className="nav-badge">{owesCount}</span></>}
        </a>;
      })}
    </nav>
    <a href={faultHref} className={faults.length > 0 ? 'caretaker-pill faults' : 'caretaker-pill ok'} data-caretaker-faults={faults.length} title={faults[0]?.summary ?? 'Last health pass found no faults'} onClick={event => { event.preventDefault(); openFaults(); }}>
      {faults.length > 0 && <span className="caretaker-dot" aria-hidden="true"/>}
      {pillText}
    </a>
    <button type="button" className={allPaused ? 'pause-team-btn paused' : 'pause-team-btn'} disabled={pausing || !!cannotPause} title={cannotPause ?? undefined} onClick={() => void togglePause()}>
      {allPaused ? 'Resume team' : 'Pause team'}
    </button>
  </header>;
}

/** GY-3483: a role as the owner names it — Owner, Maintainer or Viewer. */
const roleName = (role: unknown) => role === 'admin' ? 'Owner' : role === 'reader' ? 'Viewer' : 'Maintainer';

/** GY-3310: the version and serving commit each status poll reports. */
function VersionLabel({ status }: { status: any }) {
  const commit: string | undefined = status.build?.commit;
  const version: string | undefined = status.release?.version && !status.release.version.startsWith('unreleased') ? status.release.version : undefined;
  const parts = [version && `v${version}`, commit && commit.slice(0, 7)].filter(Boolean);
  if (!parts.length) return null;
  return <span className="version-label" title={commit}>{PRODUCT_NAME} {parts.join(' · ')}</span>;
}

/**
 * The section sub-bar: the configured repository, live activity strip, release line, and sub-page
 * tabs for the current place (Work, Lead, Settings).
 */
export default function TopBar(dashboard: Dashboard & { onPalette?: () => void }) {
  const { view, setView, status, selected, work, observedAt, onPalette, connected, lastUpdated, signOut } = dashboard;
  const section = viewFor(view).section;
  const pages = section ? visibleViews(dashboard).filter(page => page.section === section && !page.inlineOnly) : [];
  const tabs = pages.filter(page => !page.advanced), advanced = pages.filter(page => page.advanced);
  const theme = useTheme();
  const actor = status?.actor;
  const tab = (page: View) => { const term = meaning(page.label); return <button key={page.id} type="button" className={page.id === view ? 'tab active' : 'tab'} aria-current={page.id === view ? 'page' : undefined} onClick={() => setView(page.id)}>{term ? <Term term={term} focusable={false}>{page.label}</Term> : page.label}</button>; };
  return <div className="top-bar">
    <div className="top-bar-row">
      {status?.repository && <p className="project-name" data-title><img className="project-emblem" src="/favicon.svg" alt=""/>{status.repository}</p>}
      <div className="top-bar-live">
        {(view !== 'home' || selected) && <ActivityStrip work={work} observedAt={observedAt} status={status}/>}
        <ShippedStrip work={work} observedAt={observedAt} live={status?.live}/>
        <OpenApp status={status}/>
        <Invite api={dashboard.api} status={status}/>
        {!connected && <span className="connection" title={lastUpdated ? `Last update ${lastUpdated}` : undefined}><span className="dot"/>Offline · retrying</span>}
        {actor && <span className="signed-in" title="Signed in as">{[actor.displayName, roleName(actor.role)].filter(Boolean).join(' · ')}</span>}
        <button type="button" className="text-button theme-button" aria-label={`Switch theme to ${theme === 'night' ? 'Daylight' : 'Night Yard'}`} title="Night Yard is the default look; Daylight is the light one" onClick={() => setTheme(theme === 'night' ? 'daylight' : 'night')}>{theme === 'night' ? '☀' : '☾'}</button>
        <button type="button" className="text-button" onClick={signOut}>{dashboard.token ? 'Sign out' : 'Sign in'}</button>
        {onPalette && <button type="button" className="palette-button" title="Ctrl K / ⌘ K" aria-label="Command palette (Ctrl K)" onClick={onPalette}><kbd>⌘</kbd><kbd>K</kbd></button>}
      </div>
    </div>
    {status && (view !== 'home' || selected) && <HostUpdateLine status={status}/>}
    {status && <ReleaseLine status={status}/>}
    {status && <WeekLine status={status} work={work} open={dashboard.setSelected}/>}
    {!selected && pages.length >= 2 && <nav className="tabs" aria-label="Pages in this section">{tabs.map(tab)}{advanced.length > 0 && <details className="tabs-advanced" open={advanced.some(page => page.id === view) || undefined}><summary className="tab">Advanced</summary>{advanced.map(tab)}</details>}</nav>}
    {status && <VersionLabel status={status}/>}
  </div>;
}
