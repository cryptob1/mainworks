import { runChild } from '../child-runner.js';

/**
 * First-run step 3 (GY-3709): read the repository's open issues with the host's `gh` login and post
 * them to the control plane, which offers the three smallest as a first task. Returns whether the
 * install still wants them: once something has merged, the loop stops reading.
 */
export async function reportOpenIssues(repository: string, post: (body: unknown) => Promise<{ wanted?: boolean }>): Promise<boolean> {
  const listed = JSON.parse(await runChild('gh', ['issue', 'list', '-R', repository, '--state', 'open', '--limit', '100', '--json', 'number,title,body,labels,url'], { timeoutMs: 60_000 })) as { number: number; title: string; body: string; labels: { name: string }[]; url: string }[];
  const answer = await post({ issues: listed.map(issue => ({ number: issue.number, title: issue.title, body: issue.body ?? '', labels: issue.labels.map(label => label.name), url: issue.url })) });
  return answer.wanted !== false;
}
