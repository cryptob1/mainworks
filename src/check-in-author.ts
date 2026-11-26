/**
 * GY-3850: every commit Mainworks makes is authored 'NAME (Mainworks) <owner email>' — the person
 * accountable and the tool that did the work. The committer stays the agent identity, so every gate
 * that reads an identity reads the committer as before. An install with no owner recorded authors
 * as 'Mainworks <mainworks@localhost>'.
 */
import { execFileSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CheckInOwner { name: string; email: string }

const unownedAuthor = { name: 'Mainworks', email: 'mainworks@localhost' } as const;
const checkInAuthor = (owner: CheckInOwner | null | undefined) => owner ? { name: `${owner.name} (Mainworks)`, email: owner.email } : unownedAuthor;
export const authorLine = (owner: CheckInOwner | null | undefined) => (author => `${author.name} <${author.email}>`)(checkInAuthor(owner));
export const authorEnvironment = (owner: CheckInOwner | null | undefined) => (author => ({ GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email }))(checkInAuthor(owner));

/**
 * GY-3872: a worker's commits are committed by 'mainworks-<identity>' (an old 'graphyard-' prefix dropped).
 * Commits made before keep their 'graphyard-' committer: no gate reads a committer name, so both pass alike.
 */
export const workerCommitterEnvironment = (principal: string) => {
  const name = `mainworks-${principal.replace(/^(graphyard|mainworks)-/, '')}`;
  return { GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@users.noreply.invalid` };
};

/** The one attention line an install with no owner shows. */
export const ownerAttentionLine = 'Commits are authored "Mainworks": name the owner with mainworks config owner "NAME" EMAIL';

/** The owner the loop read on its latest snapshot; its merges, reverts, kept work and launched workers author with it. */
let loopOwner: CheckInOwner | null = null;
let liveAuthorFile: string | null = null;
/**
 * GY-3912: the loop also writes the owner to `mainworks-author.gitconfig` in the checkout's shared git directory, which
 * every local session it launches (each in a worktree of that checkout) includes through environment config, so a running session's next commit carries the current owner.
 */
export const recordLoopOwner = (owner: CheckInOwner | null, root?: string) => {
  loopOwner = owner;
  liveAuthorFile = null;
  if (!root) return;
  const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const file = join(common, 'mainworks-author.gitconfig'), author = checkInAuthor(owner);
  const quoted = (value: string) => `"${value.replace(/[\\"]/g, '\\$&')}"`;
  writeFileSync(`${file}.next`, `[user]\n\tname = ${quoted(author.name)}\n\temail = ${quoted(author.email)}\n`);
  renameSync(`${file}.next`, file);
  liveAuthorFile = file;
};
export const loopAuthorEnvironment = () => authorEnvironment(loopOwner);
/** A local session's author: read from the live file at each commit once the loop has written it, else fixed at launch. */
export const sessionAuthorEnvironment = (): Record<string, string> => liveAuthorFile
  ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'include.path', GIT_CONFIG_VALUE_0: liveAuthorFile }
  : loopAuthorEnvironment();

/**
 * The first commit in `log` (lines `SHA<TAB>AUTHOR NAME<TAB>AUTHOR EMAIL`) authored by none of the
 * accepted forms — the current owner's, the one in force when the attempt was claimed (GY-3912) and
 * the install default — as the one line `complete` refuses with; null when every commit carries one.
 */
export function foreignAuthor(log: string, owner: CheckInOwner | null | undefined, base: string, claimOwner?: CheckInOwner | null): string | null {
  const author = checkInAuthor(owner), expected = author.name;
  const accepted = new Set([owner, claimOwner, null].map(form => (a => `${a.name}\t${a.email}`)(checkInAuthor(form))));
  for (const line of log.split('\n').filter(Boolean)) {
    const [sha, name = '', email = ''] = line.split('\t');
    if (!accepted.has(`${name}\t${email}`)) return `complete refused: commit ${sha!.slice(0, 12)} is authored '${name}'; every commit must be authored '${authorLine(owner)}': run GIT_AUTHOR_NAME='${expected}' GIT_AUTHOR_EMAIL='${author.email}' git rebase ${base} --exec 'git commit --amend --no-edit --reset-author', then complete again`;
  }
  return null;
}
