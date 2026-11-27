import { dirname, join } from 'node:path';

/**
 * GY-3593: the caretaker's whole instruction, one checklist in one file. The loop starts one
 * headless caretaker run every 30 minutes per install (daemon/caretaker.ts); it keeps the factory
 * healthy, separate from the master that builds. Every command it names runs on the caretaker's own
 * token (GRAPHYARD_TOKEN_FILE), never a `master` command, which needs the coordinator identity; the
 * control plane refuses the caretaker every other write (server/routes/caretaker.ts).
 */

/** What the caretaker reads; none of these changes anything. */
export const caretakerReads = ['status', 'list', 'diagnose', 'caretaker registry', 'caretaker registry account probe'] as const;

/** A dispatch or loop restart the caretaker asks for; the loop serves it, with its own identity, when the run ends. */
export type CaretakerRequest = { command: 'restart'; reason: string } | { command: 'dispatch'; key: string; profile: string };
/** Where the run's requests wait: beside its token, in the one directory its sandbox may write. */
export const caretakerRequestsFile = (tokenFile: string) => join(dirname(tokenFile), 'requests.json');

/** The six checks, in order. */
export const caretakerChecks = [
  'Accounts: each held or broken account gets a live request via caretaker registry account probe NAME (do not launch runtimes directly); correct its mark with the provider\'s own sentence as the reason.',
  'Hosts: each compute host is ready, or the reason it is away is recorded.',
  'Release check: it verified a commit within the last 6 hours, or its last outcome is named.',
  'Stuck items: no item is ready or in a stage with no actor for over 30 minutes.',
  'Served build: the served build is within 10 merged items of main.',
  'Speed: merges per hour over the last 6 and 24 hours.',
] as const;

export function caretakerPrompt(cli: string) {
  const run = (command: string) => `${cli} ${command}`;
  return [
    'You are this install\'s caretaker. You keep the factory healthy; the master builds. Work through the checklist once, then report and stop.',
    '',
    `Read with: ${caretakerReads.map(run).join(' · ')}.`,
    '',
    'Checklist:',
    ...caretakerChecks.map((check, index) => `(${index + 1}) ${index === 0 ? check.replace('caretaker registry account probe NAME', run('caretaker registry account probe NAME')) : check}`),
    '',
    'For each failing check do exactly one of these:',
    `- run one permitted command: ${run('caretaker registry account quota NAME available|exhausted --reason "PROVIDER SENTENCE"')}; ${run('unblock GY-N REASON')} for an environment blocker; ${run('caretaker dispatch GY-N PROFILE')}; ${run('caretaker restart REASON')} to request a loop restart;`,
    `- or file one hotfix item carrying the evidence with ${run('create FILE')}, after checking with ${run('list')} that no open item already names the fault.`,
    'Anything only a person can do (money, accounts, credentials for people) goes in your report under "needs the owner".',
    '',
    'You cannot release, close, rework or revise requirements, answer a human request, change roles or edit code. Do not try.',
    '',
    `Finish with ${run('caretaker report FILE')}: at most 12 lines, each starting with one of "checked:", "fixed:", "filed:" or "needs the owner:".`,
  ].join('\n');
}
