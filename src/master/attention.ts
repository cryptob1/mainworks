// Concern: who owns each attention item, control-plane attention, fleet and production summaries.
import type { Work } from '../model.js';
import { type ProductionReport, type ApplicationRelease, attentionLines } from '../production-watch.js';
import type { FleetView } from '../model/registry.js';
import { humanOnlyDecisions } from '../model/human-request.js';

/** The control-plane facts `GET /api/status` reports that are not about any one work item. */
export interface ControlPlaneStatus {
  /** Observation jobs that saved no observation three or more times in a row (GY-506); a server before it reports none. */
  starvedJobs?: { key: string; unobserved: number; error?: string | null; deferred_reason?: string | null }[];
  /** Capacity variables against the configured roster; a server before GY-59 reports none. */
  delegationLimits?: { limits?: Record<string, number>; deployed?: Record<string, string | null>; drift?: { variable: string; deployed: string | null; required: string; reason: string }[]; attention?: string[] } | null;
  /** The build the server runs and the merge protocol it speaks. */
  build?: { commit?: string | null; protocol?: number | null } | null;
  /** Production deployment observation for the base branch. */
  production?: Partial<ProductionReport> | null;
  /** The agent registry as the control plane holds it; a server before GY-91 reports none. */
  fleet?: FleetView | null;
}
/**
 * Who resolves an attention item and the next command they run. `role` is an agent role
 * (master, reviewer, control plane); `human` is true only for the human-only list,
 * and `humanOnly` then names which of those decisions it is.
 */
export interface AttentionOwner { role: 'master' | 'reviewer' | 'control plane' | 'human'; human: boolean; humanOnly: typeof humanOnlyDecisions[number] | null; next: string }
/** One attention line. `resource` names the registered resource a symptom was attributed to (GY-1272). */
export interface AttentionItem extends AttentionOwner { subject: string; text: string; resource?: string;
  /** Until when the loop is itself carrying what the line names (GY-1315): shown in master status. */
  inMotionUntil?: string }
export const agentOwner = (role: 'master' | 'reviewer' | 'control plane', next: string): AttentionOwner => ({ role, human: false, humanOnly: null, next });
/** The sources of installation attention. */
export const installationSources = ['delegation-limits', 'production'] as const;
/** The owner of one installation attention line, by the source that raised it. */
export function installationOwner(source: typeof installationSources[number], text: string): AttentionOwner {
  if (source === 'delegation-limits') { const assignment = /Set (\S+=\S+)/.exec(text)?.[1]; return agentOwner('master', assignment ? `Set ${assignment} on the deployment (Railway: railway variables --set ${assignment} --service mainworks), then redeploy` : 'Set the named capacity variable on the deployment, then redeploy'); }
  // The failing deployment is on the base branch production deploys; the fix is its redeploy.
  return agentOwner('master', 'Fix the failing deployment of the base branch, which production tracks, with the configured provider');
}
/**
 * Attention that belongs to the installation rather than to a work item: a
 * capacity variable that no longer covers the roster, and a base branch that production has
 * not deployed.
 */
export function controlPlaneAttention(status: ControlPlaneStatus | undefined) {
  const items: AttentionItem[] = [];
  const raise = (source: Parameters<typeof installationOwner>[0], text: string) => items.push({ subject: 'installation', text, ...installationOwner(source, text) });
  for (const text of status?.delegationLimits?.attention ?? []) raise('delegation-limits', text);
  // A job that keeps finishing without an observation holds the merge queue behind its item (GY-506).
  for (const job of status?.starvedJobs ?? []) { const text = starvedJobText(job); items.push({ subject: job.key, text, ...agentOwner('master', `mainworks diagnose ${job.key}: the recorded reason names what keeps the observation from being saved; the next saved observation clears this`) }); }
  const production = status?.production ? productionSummary(status.production) : null;
  for (const text of production?.attention ?? []) raise('production', text);
  const attention = items.map(item => item.text);
  return { attention, attentionItems: items,
    delegationLimits: status?.delegationLimits ? { limits: status.delegationLimits.limits ?? null, deployed: status.delegationLimits.deployed ?? null, drift: (status.delegationLimits.drift ?? []).map(entry => ({ variable: entry.variable, deployed: entry.deployed, required: entry.required, reason: entry.reason })) } : null,
    build: status?.build ? { commit: status.build.commit ?? null, protocol: status.build.protocol ?? null } : null, production };
}
/** The attention line for an observation job starved of observations: the item and the path its last run took. */
function starvedJobText(job: NonNullable<ControlPlaneStatus['starvedJobs']>[number]) {
  const path = job.error ? `last refusal: ${job.error}` : job.deferred_reason ? `last reschedule: ${job.deferred_reason}` : 'no reason recorded, so the job loop fails before the observation';
  return `${job.key}'s observation job has finished ${job.unobserved} times in a row without saving an observation; ${path}`;
}
/**
 * The production lag an operator reads first: what production serves, and the failing deployment
 * reason when the provider reported one. There is no branch-ahead computation: comparisons are
 * gone, so the summary says what the watch cannot tell when it says nothing.
 */
function productionSummary(report: Partial<ProductionReport>) {
  const incidents = (report.incidents ?? []).map(incident => ({ key: incident.key, mergeSha: incident.mergeSha, status: incident.status, reason: incident.reason, deploymentId: incident.deploymentId ?? null, since: incident.since }));
  return { provider: report.provider ?? null, observedAt: report.observedAt ?? null, serving: report.serving ?? null, running: report.running ?? null, summary: report.aheadError ?? 'production lag is unknown',
    latestDeployment: report.latest ? { id: report.latest.id, status: report.latest.providerStatus, commit: report.latest.commit, createdAt: report.latest.createdAt, url: report.latest.url ?? null } : null,
    deployed: report.deployed ?? [], pending: report.pending ?? [], incidents, error: report.error ?? null,
    attention: attentionLines({ serving: report.serving ?? null, incidents: (report.incidents ?? []), error: report.error ?? null }) };
}

/** One line per application its versionUrl shows lagging behind main or failing to answer (GY-3204); its host deploys it from git, so the fix is that deploy. */
export function applicationAttention(applications: ApplicationRelease[]) {
  return applications.filter(app => app.state === 'lagging' || app.state === 'failed').map(app => ({ subject: `application ${app.id}`,
    text: app.state === 'lagging' ? `Application ${app.id} lags main: ${app.reason}` : `Application ${app.id}'s versionUrl failed: ${app.reason}`,
    next: `Check the ${app.id} deploy on its host (Railway deploys it from git); Mainworks only reads its versionUrl` }));
}

/** A rework carries the reviewer's reason onto an attention line until a new head answers it. */
export const reworkAttention = (items: readonly Pick<Work, 'key' | 'reworkRequested' | 'lastRework'>[]) => items.filter(item => item.reworkRequested && item.lastRework?.reason)
  .map(item => ({ subject: item.key, text: `Sent back for rework: ${item.lastRework!.reason}`, next: `mainworks status ${item.key}; the next worker's request carries this reason` }));
