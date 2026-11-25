/**
 * GY-3850: every commit Mainworks makes is authored 'NAME (Mainworks) <owner email>' — the person
 * accountable and the tool that did the work. The committer stays the agent identity, so every gate
 * that reads an identity reads the committer as before. An install with no owner recorded authors
 * as 'Mainworks <mainworks@localhost>'.
 */
export interface CheckInOwner { name: string; email: string }

export const unownedAuthor = { name: 'Mainworks', email: 'mainworks@localhost' } as const;
export const checkInAuthor = (owner: CheckInOwner | null | undefined) => owner ? { name: `${owner.name} (Mainworks)`, email: owner.email } : unownedAuthor;
export const authorLine = (owner: CheckInOwner | null | undefined) => (author => `${author.name} <${author.email}>`)(checkInAuthor(owner));
export const authorEnvironment = (owner: CheckInOwner | null | undefined) => (author => ({ GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email }))(checkInAuthor(owner));

/** The one attention line an install with no owner shows. */
export const ownerAttentionLine = 'Commits are authored "Mainworks": name the owner with mainworks config owner "NAME" EMAIL';

/** The owner the loop read on its latest snapshot; its merges, reverts, kept work and launched workers author with it. */
let loopOwner: CheckInOwner | null = null;
export const recordLoopOwner = (owner: CheckInOwner | null) => { loopOwner = owner; };
export const loopAuthorEnvironment = () => authorEnvironment(loopOwner);

/**
 * The first commit in `log` (lines `SHA<TAB>AUTHOR NAME`) whose author is not the owner's, as the
 * one line `complete` refuses with; null when every commit carries it.
 */
export function foreignAuthor(log: string, owner: CheckInOwner | null | undefined, base: string): string | null {
  const author = checkInAuthor(owner), expected = author.name;
  for (const line of log.split('\n').filter(Boolean)) {
    const [sha, ...name] = line.split('\t');
    if (name.join('\t') !== expected) return `complete refused: commit ${sha!.slice(0, 12)} is authored '${name.join('\t')}'; every commit must be authored '${authorLine(owner)}': run GIT_AUTHOR_NAME='${expected}' GIT_AUTHOR_EMAIL='${author.email}' git rebase ${base} --exec 'git commit --amend --no-edit --reset-author', then complete again`;
  }
  return null;
}
