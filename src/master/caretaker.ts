import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CaretakerOutcome } from '../daemon/caretaker.js';
import { checkAccountLive, fleetRequest, type FleetLaunchAccount } from '../fleet.js';
import { defaultHeadlessExec, headlessRunMs, startHeadlessWorker, type HeadlessExec } from '../headless-session.js';
import { loopRestartRequestPath } from '../daemon/state.js';
import type { AgentRegistry } from '../model/registry.js';
import { atomicPrivateWrite } from '../private-file.js';
import type { SmokeResult } from '../runner/pi.js';
import { caretakerPrompt, caretakerRequestsFile, type CaretakerRequest } from './caretaker-prompt.js';
import { dispatchWork } from './dispatch.js';
import { credentialMaskFor } from './confinement.js';
import { accountLaunch, onSelectedSession, selectAccount } from './environments.js';
import { runtimeLoginHomes, type MasterConfig } from './profiles.js';

const failureText = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 400);

const bearerMatches = (header: string | undefined, expected: string) => {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7)), want = Buffer.from(expected);
  return actual.length === want.length && timingSafeEqual(actual, want);
};

/**
 * GY-3783: loopback probe server for one caretaker run. The confined caretaker calls
 * `caretaker registry account probe NAME`; the loop runs the registry's live probe outside the
 * sandbox with the account's own login and returns only the outcome and provider sentence.
 */
async function startCaretakerProbeServer(
  config: Pick<MasterConfig, 'url' | 'credentialFile' | 'hostId'>,
  token: string,
  deps: { smoke?: (account: FleetLaunchAccount) => Promise<SmokeResult> } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/probe') return send(404, { error: 'Not found' });
    if (!bearerMatches(req.headers.authorization, token)) return send(401, { error: 'Unauthorized' });
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        total += (chunk as Buffer).length;
        if (total > 4096) return send(413, { error: 'Request too large' });
        chunks.push(chunk as Buffer);
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const name = typeof parsed?.account === 'string' ? parsed.account.trim() : '';
      if (!name) return send(400, { error: 'account name is required' });
      const registry: AgentRegistry = await fleetRequest(config, 'agent-registry/document');
      const account = registry.accounts.find(entry => entry.name === name && entry.credential.host === config.hostId);
      const runtime = registry.runtimes.find(entry => entry.name === account?.runtime);
      if (!account || !runtime) return send(404, { error: `${name} is not a registry account on ${config.hostId}; caretaker registry lists this host's accounts` });
      const modelId = registry.models.find(model => model.name === account.model)?.id ?? null;
      const quota = await checkAccountLive(account, runtime, { smoke: deps.smoke }, modelId);
      const line = quota.state === 'available'
        ? `${name} passed its live check`
        : `${name} ${quota.loggedIn === false ? 'is not logged in' : `is ${quota.state}`}: ${quota.reason ?? 'no reason given'}`;
      return send(200, { account: name, state: quota.state, loggedIn: quota.loggedIn, reason: quota.reason, resetsAt: quota.resetsAt, line });
    } catch (error) {
      return send(500, { error: failureText(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => { srv.closeAllConnections?.(); srv.close(() => resolve()); }) };
}

/**
 * GY-3593: one caretaker pass, on the master's launch path with its own role and identity: the
 * caretaker role's first available account, the install's caretaker principal (minted for the run,
 * its token the only credential the run can read), the checklist prompt, one headless run in the
 * repository root. Skipped, naming why, when the role has no available account.
 */
export async function runCaretaker(
  root: string,
  config: MasterConfig,
  deps: { headless?: HeadlessExec; coordinatorRoot?: string; smoke?: (account: FleetLaunchAccount) => Promise<SmokeResult> } = {},
): Promise<CaretakerOutcome> {
  let selected: Awaited<ReturnType<typeof selectAccount>>;
  try { selected = await selectAccount(config, 'caretaker', { name: 'caretaker', principal: 'caretaker' }); }
  catch (error) { return { skipped: failureText(error) }; }
  const startedAt = new Date().toISOString();
  const directory = join(dirname(config.credentialFile), 'caretaker'), tokenFile = join(directory, 'caretaker.token'), requestsFile = caretakerRequestsFile(tokenFile);
  const ended = await onSelectedSession(selected, 'caretaker launch failed', async () => {
    const { token } = await fleetRequest(config, 'caretaker-identity', { body: {} });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    await rm(requestsFile, { force: true });
    const probeServer = await startCaretakerProbeServer(config, token, { smoke: deps.smoke });
    try {
      const launch = accountLaunch({ kind: selected.account?.kind, approvals: 'auto', agentArgs: [], environment: {} }, selected.account, { headless: true, repositoryRoot: root });
      // Its directory is the one path it may write: its token, and the requests the loop serves after it.
      const credentialMask = credentialMaskFor(config, { credentialFile: directory, runtimeHomes: runtimeLoginHomes(launch.environment, launch.contract?.homeVariable, launch.kind) });
      let settle!: (ended: { output: string; ok: boolean }) => void;
      const done = new Promise<{ output: string; ok: boolean }>(resolve => { settle = resolve; });
      const started = await startHeadlessWorker({ name: 'caretaker', work: 'caretaker', subject: 'Caretaker checklist', epoch: 1, principal: 'caretaker', account: launch.account,
        kind: launch.kind!, args: launch.args, contract: launch.contract, credentialMask, directory: root, supervisor: [], coordinatorRoot: deps.coordinatorRoot,
        environment: { ...launch.environment, GRAPHYARD_URL: config.url, GRAPHYARD_TOKEN_FILE: tokenFile, GRAPHYARD_HOST_ID: config.hostId, GRAPHYARD_CARETAKER_PROBE_URL: probeServer.url },
        prompt: caretakerPrompt(`node ${config.cliPath}`), root, exec: deps.headless ?? defaultHeadlessExec(), timeoutMs: headlessRunMs, settle: async ended => settle(ended) });
      return started.ended ?? await done;
    } finally {
      await probeServer.close();
    }
  });
  await selected.release?.('the caretaker run ended').catch(() => false);
  const served = await serveCaretakerRequests(root, config, requestsFile);
  const report = await fleetRequest(config, 'caretaker/reports').then(body => body.report as { at: string; lines: string[] } | null, () => null)
    .then(report => report && report.at >= startedAt ? report : null);
  return { result: served + (ended.ok && report ? `Reported ${report.lines.length} line${report.lines.length === 1 ? '' : 's'}: ${report.lines[0]}` : `Ended without a report${ended.ok ? '' : `: ${ended.output.trim().split('\n').at(-1) ?? 'the run failed'}`}`) };
}

/**
 * The restart and dispatches the run asked for, served with the loop's own identity: a restart is
 * the confined master's own request file, a dispatch is `master dispatch`'s. Each one's outcome
 * leads the result line.
 */
export async function serveCaretakerRequests(root: string, config: MasterConfig, file: string, dispatch: typeof dispatchWork = dispatchWork) {
  const requests: CaretakerRequest[] = await readFile(file, 'utf8').then(text => JSON.parse(text), () => []);
  await rm(file, { force: true });
  const outcomes: string[] = [];
  for (const request of requests) {
    try {
      if (request.command === 'restart') {
        await atomicPrivateWrite(loopRestartRequestPath(config), { requestedAt: new Date().toISOString(), requestedBy: 'caretaker', reason: request.reason });
        outcomes.push('Loop restart requested');
        continue;
      }
      const snapshot = await fleetRequest(config, 'work-snapshot');
      const work = snapshot.work.find((item: any) => item.id === request.key || item.key === request.key), profile = config.workers.find(item => item.name === request.profile);
      if (!work || !profile) throw new Error(!work ? `unknown item ${request.key}` : `unknown worker profile ${request.profile}`);
      await dispatch(root, work, profile, { allWork: snapshot.work, observedAt: snapshot.now });
      outcomes.push(`Dispatched ${request.key}`);
    } catch (error) { outcomes.push(`${request.command === 'restart' ? 'Restart' : `Dispatch ${request.key}`} failed: ${failureText(error)}`); }
  }
  return outcomes.map(line => `${line}. `).join('');
}
