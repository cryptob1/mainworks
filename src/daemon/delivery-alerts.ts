// Concern: the deployed and UAT-failed alerts (GY-3529) — beside the stalled-yard alert, the loop tells
// run.alertUrl which items the delivery watch newly serves and which release candidate failed UAT, each once.
import { gateRecordPath, readGateRecord } from '../batch-gate.js';
import type { Work } from '../model.js';
import type { Cycle } from './cycle.js';
import { message, record } from './state.js';

/** Whether the loop alerts at all: a webhook (run.alertUrl) or the factory's Slack channel (GY-4073). */
export const alertsOn = ({ config, effects }: Pick<Cycle, 'config' | 'effects'>) => !config.forPerson && !!effects.alertWebhook && (!!config.run.alertUrl || !!effects.slackConnected?.());

const short = (sha: string) => sha.slice(0, 12);

/** A Slack incoming webhook takes `{"text": ...}`; any other receiver keeps the plain-text body. */
function alertRequest(url: string, text: string): { headers: Record<string, string>; body: string } {
  return new URL(url).hostname === 'hooks.slack.com'
    ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }
    : { headers: { 'Content-Type': 'text/plain' }, body: text };
}

/** POSTs one alert to `url` in the body its receiver takes; a non-2xx answer throws. */
export async function postAlert(fetcher: typeof fetch, url: string, text: string) {
  const response = await fetcher(url, { method: 'POST', ...alertRequest(url, text), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`the alert webhook answered ${response.status} ${response.statusText}`.trim());
}

/** The deployed message: the served commit, then one line per newly served item — key, title and merge commit. */
const deployedText = (repository: string, served: string, items: readonly Pick<Work, 'key' | 'title' | 'delivery'>[]) =>
  [`Mainworks ${repository}: deployed ${short(served)}`, ...items.map(item => `${item.key} ${item.title} (${short(item.delivery!.mergeSha)})`)].join('\n');

/** The UAT-failed message: the candidate, the commit that stays served, and the failed cases in one short line. */
const uatFailedText = (repository: string, candidate: string, served: string | null, failed: readonly string[]) =>
  `Mainworks ${repository}: UAT failed on candidate ${short(candidate)}; ${served ? `${short(served)} stays served` : 'nothing is served'}. Failed: ${failed.join(', ')}`;

/**
 * GY-3529: with `run.alertUrl` set, one message when the declared serve or the deploy watch serves a commit it had not
 * announced — the items merged since the last announced commit — and one when the batch gate's
 * candidate fails, naming its failed cases. The last announced commit and failed candidate live on
 * the cursor, so a restart never repeats either; the first served commit a cursor sees is only
 * remembered, never announced.
 */
export async function deliveryAlertStep(cycle: Cycle) {
  const { config, state, effects, snapshot, now } = cycle;
  const reads = effects.mergeWriter;
  if (!alertsOn(cycle) || !effects.alertWebhook || !reads) return;
  const sent = state.deliveryAlerts;
  const send = async (text: string) => {
    try { await effects.alertWebhook!(text); }
    catch (error) { await record(state, 'delivery:alert', { kind: 'attention', work: null, principal: null, state: 'failed', detail: `Could not alert the operator (${text.split('\n')[0]}): ${message(error)}`, attempts: 1, cycle: state.cycle }, now(), effects.persist); }
  };
  // The declared serve's commit, else the deploy watch's (as servingReport reads them).
  const served = (await reads.serveRecord?.().catch(() => null))?.commit ?? (await Promise.resolve(effects.servingCommit?.()).catch(() => null)) ?? null;
  if (served && served !== sent.served) {
    const previous = sent.served;
    sent.served = served;
    await effects.persist(state);
    if (previous && reads.git) {
      const range = new Set((await reads.git(['rev-list', `${previous}..${served}`]).catch(() => '')).split('\n').map(line => line.trim()).filter(Boolean));
      const items = snapshot.work.filter(item => item.delivery?.mergeSha && range.has(item.delivery.mergeSha));
      if (items.length) await send(deployedText(config.repository, served, items));
    }
  }
  const gate = reads.gate ? readGateRecord(gateRecordPath(reads.gate.root)) : null;
  const outcome = gate?.lastOutcome;
  if (!gate || !outcome?.tip || (outcome.outcome !== 'reverted' && outcome.outcome !== 'held') || outcome.tip === sent.uatFailed) return;
  const failed = Object.entries(outcome.cases ?? {}).filter(([, result]) => result === 'fail').map(([id]) => id);
  sent.uatFailed = outcome.tip;
  await effects.persist(state);
  await send(uatFailedText(config.repository, outcome.tip, served ?? gate.verified, failed.length ? failed : [outcome.reason ?? 'unknown']));
}
