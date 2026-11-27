// Concern: the master agent's role instructions, printed by `mainworks master guide`, and the
// migration that removes the graphyard-master block earlier master inits wrote into AGENTS.md.

const masterStart = '<!-- graphyard-master -->', masterEnd = '<!-- /graphyard-master -->';

/**
 * The master session's own rules. They once lived in a graphyard-master block of the managed
 * repository's AGENTS.md, which every worker, reviewer and producer session loads; only the master
 * needs them, and its first request runs `mainworks master guide`, which prints them (GY-1493).
 */
export const masterInstructions = `## Mainworks master agent

The recommended coordinator is a dedicated, visible master-agent session. Run
\`mainworks master status\` at startup and after every material event. Mainworks is
the source of assignment and progression truth; Herdr supplies live session health.

Autonomy is the default: act without asking. Apply decisions at once with your own
operator-agent identity: \`mainworks master create|release|unblock|requirements|rework|attest|close\`.
\`master status\` names who resolves each attention item and the next command. The owner
may decide through any agent: record their own words with
\`mainworks answer GY-N --owner-said "WORDS" [--decline] ANSWER\`; the owner can reverse
it on the dashboard. A parked request outside the owner's decisions is yours: unblock,
release or decide it.

Dispatch only ready work with \`mainworks master dispatch GY-N PROFILE\`; the worker claims
it under its own identity in the assigned worktree. Workers check their change with \`npm run test:affected\` and their bound proof test files,
not npm test, before submitting. Use durable handoffs when an agent, account, machine or
context window changes.

Review and proof collection start on their own: once a candidate passes the build gate,
\`mainworks master run\` launches a reviewer and proof producers bound to its exact head
within 30 seconds, and a head change requests them afresh unless the carry rules carried
them. You handle findings, rework and merges. \`master status\` shows per candidate what
is requested, running or refused; \`mainworks master review GY-N [PROFILE]\` recovers a
refused reviewer launch once its cause is fixed.

Keep cycling: status, dispatch ready work, shepherd review, record what the merge
writer's trial and push landed. Repeat until both conditions hold:
(1) every in-scope item is Done or has a genuinely external blocker recorded in
Mainworks; and (2) the release health line in \`master status\` is healthy, or a
genuinely external deployment blocker is recorded in Mainworks as a follow-up work item.
An item is delivered at merge; release health is one status line. Ordinary review findings, rework,
idle workers, and proof setup are not stopping conditions. Close finished agent
sessions as part of the cycle.

The control plane merges: the loop's merge writer trial-merges a submitted head whose
gates pass, runs its proofs and pushes it to the base branch. GitHub merges nothing and
no pull request is opened. A merge of a head whose gates had not passed is held as a
violation; file the follow-up that re-verifies what it skipped. Never use an
administrative merge bypass, edit a candidate, or read a worker credential.
`;

/**
 * AGENTS.md without its graphyard-master block: exactly the markers and what lies between them are
 * removed, every byte outside them kept. Malformed or duplicate markers are refused, naming the file.
 */
export function withoutMasterInstructions(existing: string) {
  const starts = existing.split(masterStart).length - 1, ends = existing.split(masterEnd).length - 1;
  if (starts !== ends || starts > 1 || starts === 1 && existing.indexOf(masterEnd) < existing.indexOf(masterStart)) throw new Error('Malformed or duplicate Mainworks master markers; resolve them before updating AGENTS.md');
  return starts ? existing.slice(0, existing.indexOf(masterStart)) + existing.slice(existing.indexOf(masterEnd) + masterEnd.length) : existing;
}
