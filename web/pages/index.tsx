import type { ReactNode } from 'react';
import type { Dashboard } from './dashboard';
import HomePage from './home';
import WorkPage, { workFilters, type WorkFilter } from './work';
import HumanRequestsPage from './human-requests';
import GuidePage from './guide';
import AutomationPage from './automation';
import FleetPage from './fleet';
import SetupPage from './setup';
import WorkersPage from './workers';
import MasterPage from './master';
import CostsPage from './costs';
import ScenarioLibrary from '../scenarios';
import ReleasesView from '../releases';
import TestsPage from './tests';
import ProductPage from './product';
import { DeliveryDefaults } from '../components/delivery-slices';
import { WhereItRuns } from '../components/where-it-runs';
import { PublicLink } from '../components/public-link';
import { CheckInOwner } from '../components/check-in-owner';
import { SlackPage } from './slack';
import { requestedView } from '../../src/model/setup-checklist';

/**
 * The four places (GY-3598): Home, Work, Lead, Settings. Every existing page lives under one of
 * these four, reachable in at most two clicks; old hash routes redirect to their new place.
 */
export const sections = [
  { id: 'home', icon: 'home', label: 'Home' },
  { id: 'work', icon: 'work', label: 'Work' },
  { id: 'lead', icon: 'lead', label: 'Lead' },
  { id: 'settings', icon: 'settings', label: 'Settings' },
] as const;
export type Section = typeof sections[number]['id'];

/** Old hash routes that redirect to a canonical view id. */
export const oldRouteRedirects: Record<string, string> = {
  master: 'lead',
  settings: 'agents',
  start: 'home',
};

/**
 * One page. The top bar, the section sub-tabs and the main pane are generated from this list.
 */
export interface View {
  id: string; icon: string; label: string;
  /** The place it lives under (Home, Work, Lead, or Settings). */
  section?: Section;
  adminOnly?: boolean;
  /** Rarely needed: listed under the section's Advanced fold instead of as a tab. */
  advanced?: boolean;
  /** Reached from an inline strip rather than the section's tab bar. */
  inlineOnly?: boolean;
  /** Hides the page for some sessions, or while nothing is configured for it. */
  visible?(dashboard: Dashboard): boolean;
  render(dashboard: Dashboard): ReactNode;
}

const role = (dashboard: Dashboard) => dashboard.status?.actor?.role;
// A feature is hidden only once a read has shown it has nothing configured; an unknown or
// failed read keeps it visible so an outage never hides a page.
const configured = (value: boolean | null | undefined) => value !== false;

export const views: readonly View[] = [
  { id: 'home', icon: '⌂', label: 'Home', section: 'home', render: dashboard => <HomePage {...dashboard}/> },
  { id: 'work', icon: '▥', label: 'Work', section: 'work', render: dashboard => <WorkPage {...dashboard}/> },
  { id: 'needs-you', icon: '☝', label: 'Needs you', section: 'work', inlineOnly: true, render: dashboard => <HumanRequestsPage {...dashboard}/> },
  { id: 'releases', icon: '⇈', label: 'Releases', section: 'work', advanced: true, visible: dashboard => configured(dashboard.features.releases), render: dashboard => <ReleasesView api={dashboard.api} work={dashboard.work}/> },
  { id: 'tests', icon: '⚗', label: 'Tests', section: 'work', visible: dashboard => role(dashboard) !== 'operator-agent', render: dashboard => <TestsPage api={dashboard.api} canEdit={role(dashboard) === 'admin'} setView={dashboard.setView} openItem={dashboard.setSelected}/> },
  { id: 'scenarios', icon: '✓', label: 'Test cases', section: 'work', advanced: true, visible: dashboard => role(dashboard) === 'admin' || configured(dashboard.features.scenarios), render: dashboard => <ScenarioLibrary api={dashboard.api} canEdit={role(dashboard) === 'admin'}/> },
  { id: 'lead', icon: '▶', label: 'Lead', section: 'lead', render: dashboard => <MasterPage {...dashboard}/> },
  { id: 'product', icon: '◎', label: 'Product', section: 'lead', render: dashboard => <ProductPage api={dashboard.api}/> },
  { id: 'agents', icon: '⛭', label: 'Agents', section: 'settings', visible: dashboard => ['admin', 'coordinator', 'reader', 'slice-lead'].includes(role(dashboard)), render: dashboard => <FleetPage api={dashboard.api} status={dashboard.status} observedAt={dashboard.observedAt}/> },
  { id: 'workers', icon: '⚙', label: 'Workers', section: 'settings', render: dashboard => <WorkersPage {...dashboard}/> },
  { id: 'costs', icon: '$', label: 'Costs', section: 'settings', render: dashboard => <CostsPage api={dashboard.api} observedAt={dashboard.observedAt}/> },
  // GY-4073: connect the factory's Slack app, step by step.
  { id: 'slack', icon: '#', label: 'Slack', section: 'settings', adminOnly: true, render: dashboard => <SlackPage api={dashboard.api} observedAt={dashboard.observedAt}/> },
  { id: 'setup', icon: '✔', label: 'Setup', section: 'settings', adminOnly: true, render: dashboard => <SetupPage status={dashboard.status} api={dashboard.api} setView={dashboard.setView}/> },
  // The project's effective delivery defaults and declared applications (GY-1901), with where the app runs (GY-3434).
  { id: 'delivery', icon: '⇉', label: 'Delivery', section: 'settings', visible: dashboard => ['admin', 'coordinator', 'reader', 'slice-lead'].includes(role(dashboard)), render: dashboard => <><DeliveryDefaults status={dashboard.status}/><CheckInOwner api={dashboard.api} status={dashboard.status}/><PublicLink api={dashboard.api} status={dashboard.status}/><WhereItRuns status={dashboard.status} now={Number.isNaN(dashboard.observedAt) ? Date.now() : dashboard.observedAt}/></> },
  // Help (GY-3295) can bring back the day-one checklist (GY-4066), so it opens Home itself.
  { id: 'guide', icon: '?', label: 'Help', section: 'settings', render: dashboard => <GuidePage setView={dashboard.setView}/> },
  { id: 'automation', icon: '◇', label: 'Operator automation', section: 'settings', advanced: true, adminOnly: true, visible: dashboard => configured(dashboard.features.automation), render: dashboard => <AutomationPage operatorAgents={dashboard.operatorAgents} operatorAgentsError={dashboard.operatorAgentsError}/> },
];

/** Every valid route id, including old hash aliases that redirect to their new place. */
export const allRouteIds: readonly string[] = [...views.map(page => page.id), ...Object.keys(oldRouteRedirects)];

/** Resolve an old or place route id to a concrete view id. */
export function resolveViewId(id: string, dashboard?: Dashboard): string {
  const mapped = oldRouteRedirects[id] ?? id;
  if (dashboard && mapped === 'agents') {
    const visible = visibleViews(dashboard);
    if (!visible.some(page => page.id === 'agents')) {
      return visible.find(page => page.section === 'settings')?.id ?? 'workers';
    }
  }
  return views.some(view => view.id === mapped) ? mapped : 'work';
}

/** The pages this session may open, in registry order. */
export const visibleViews = (dashboard: Dashboard) => views.filter(view => (!view.adminOnly || role(dashboard) === 'admin') && (!view.visible || view.visible(dashboard)));

/** The first visible view of a place (Home, Work, Lead, Settings). */
export function firstViewOfSection(dashboard: Dashboard, section: Section): View {
  return visibleViews(dashboard).find(page => page.section === section && !page.advanced)
    ?? views.find(page => page.section === section)
    ?? views[1];
}

/** The primary entry a page stands for: its place, when it is the first visible page of that place. */
export function primaryEntry(dashboard: Dashboard, view: View) {
  if (!view.section) return null;
  const first = visibleViews(dashboard).find(page => page.section === view.section && !page.advanced);
  return first === view ? { ...sections.find(section => section.id === view.section)!, view } : null;
}

/** The four places this session may open, in order (Home, Work, Lead, Settings). */
export const primaryEntries = (dashboard: Dashboard) => sections.map(section => ({ ...section, view: firstViewOfSection(dashboard, section.id) }));

/** The page for a view id; old aliases resolve to their new place, unknown ids fall back to work. */
export const viewFor = (id: string) => views.find(view => view.id === (oldRouteRedirects[id] ?? id)) ?? views.find(view => view.id === 'work')!;

/** GY-3600: the removed Now and Shipped pages' routes open Work with the matching filter. */
export const redirects: Readonly<Record<string, WorkFilter>> = { now: 'in-flight', shipped: 'shipped-today' };
/** The page and Work filter an address asks for: `#page`, with the filter as `?filter=` (unknown values ignored); old aliases resolve to their new place. */
export function route(hash: string, search: string): { view: string | null; filter: WorkFilter | null } {
  const asked = requestedView(hash, [...allRouteIds, ...Object.keys(redirects)]).view;
  if (asked && redirects[asked]) return { view: 'work', filter: redirects[asked] };
  const page = asked ? oldRouteRedirects[asked] ?? asked : null, filter = new URLSearchParams(search).get('filter');
  return { view: page, filter: page === 'work' && workFilters.includes(filter as WorkFilter) ? filter as WorkFilter : null };
}
