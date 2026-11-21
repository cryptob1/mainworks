import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CaretakerOutcome } from '../daemon/caretaker.js';
import { fleetRequest } from '../fleet.js';
import { defaultHeadlessExec, headlessRunMs, startHeadlessWorker, type HeadlessExec } from '../headless-session.js';
import { caretakerPrompt } from './caretaker-prompt.js';
import { credentialMaskFor } from './confinement.js';
import { accountLaunch, onSelectedSession, selectAccount } from './environments.js';
import { runtimeLoginHomes, type MasterConfig } from './profiles.js';

const failureText = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 400);

/**
 * GY-3593: one caretaker pass, on the master's launch path with its own role and identity: the
 * caretaker role's first available account, the install's caretaker principal (minted for the run,
 * its token the only credential the run can read), the checklist prompt, one headless run in the
 * repository root. Skipped, naming why, when the role has no available account.
 */
export async function runCaretaker(root: string, config: MasterConfig, deps: { headless?: HeadlessExec; coordinatorRoot?: string } = {}): Promise<CaretakerOutcome> {
  let selected: Awaited<ReturnType<typeof selectAccount>>;
  try { selected = await selectAccount(config, 'caretaker', { name: 'caretaker', principal: 'caretaker' }); }
  catch (error) { return { skipped: failureText(error) }; }
  const ended = await onSelectedSession(selected, 'caretaker launch failed', async () => {
    const { token } = await fleetRequest(config, 'caretaker-identity', { body: {} });
    const directory = join(dirname(config.credentialFile), 'caretaker'), tokenFile = join(directory, 'caretaker.token');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    const launch = accountLaunch({ kind: selected.account?.kind, approvals: 'auto', agentArgs: [], environment: {} }, selected.account, { headless: true, repositoryRoot: root });
    const credentialMask = credentialMaskFor(config, { credentialFile: tokenFile, runtimeHomes: runtimeLoginHomes(launch.environment, launch.contract?.homeVariable, launch.kind) });
    let settle!: (ended: { output: string; ok: boolean }) => void;
    const done = new Promise<{ output: string; ok: boolean }>(resolve => { settle = resolve; });
    const started = await startHeadlessWorker({ name: 'caretaker', work: 'caretaker', subject: 'Caretaker checklist', epoch: 1, principal: 'caretaker', account: launch.account,
      kind: launch.kind!, args: launch.args, contract: launch.contract, credentialMask, directory: root, supervisor: [], coordinatorRoot: deps.coordinatorRoot,
      environment: { ...launch.environment, GRAPHYARD_URL: config.url, GRAPHYARD_TOKEN_FILE: tokenFile, GRAPHYARD_CARETAKER: '1' },
      prompt: caretakerPrompt(`node ${config.cliPath}`), root, exec: deps.headless ?? defaultHeadlessExec(), timeoutMs: headlessRunMs, settle: async ended => settle(ended) });
    return started.ended ?? await done;
  });
  await selected.release?.('the caretaker run ended').catch(() => false);
  const report = await fleetRequest(config, 'caretaker/reports').then(body => body.report as { at: string; lines: string[] } | null, () => null);
  return { result: ended.ok && report ? `Reported ${report.lines.length} line${report.lines.length === 1 ? '' : 's'}: ${report.lines[0]}` : `Ended without a report${ended.ok ? '' : `: ${ended.output.trim().split('\n').at(-1) ?? 'the run failed'}`}` };
}
