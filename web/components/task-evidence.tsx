import { useEffect, useState } from 'react';
import type { Work } from '../../src/model';
import type { TrialTimings } from '../../src/model/task-evidence';
import { plainDuration } from '../../src/pipeline-speed';
import { formatAge } from '../../src/model/duration';
import { activityLabel } from '../item-page';

/**
 * GY-3599: the evidence the Task page shows beside the item itself — where its time went, stage by
 * stage, its merge trial's checks and failing output, and its changed files with each file's diff.
 */
export interface TaskTimings { releasedAt: string | null; trial: TrialTimings | null }
export interface ChangedFile { path: string; additions: number; deletions: number }
type Api = (path: string) => Promise<any>;

/** One read of an item's evidence path, again whenever the item changes; null until it answers or when it cannot. */
export function useEvidence<T>(api: Api, path: string | null, key: unknown): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => { let live = true; if (path) api(path).then(next => { if (live) setValue(next); }, () => { if (live) setValue(null); }); return () => { live = false; }; }, [path, key]);
  return value;
}

/** "20 s", "14 min", "1 h 5 min". */
export const shortDuration = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)} s` : plainDuration(ms / 60_000);

export interface Stage { id: 'built' | 'reviewed' | 'queued' | 'trial' | 'ship'; label: string; state: 'done' | 'current' | 'failed' | 'pending'; ms: number | null }
const stageLabels: [Stage['id'], string][] = [['built', 'Built'], ['reviewed', 'Reviewed'], ['queued', 'Queued'], ['trial', 'Merge trial'], ['ship', 'Ship']];
/**
 * The five stages a task passes, each with the time this task spent in it, from instants the item
 * and its ledger already record: released, handed in, approved, trial started, trial ended, merged.
 * A stage is done once any later instant exists, and its time is known when both of its own do.
 */
export function taskStages(item: Work, timings: TaskTimings | null, now: number): { stages: Stage[]; totalMs: number | null; merged: boolean } {
  const time = (value: string | null | undefined) => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : null; };
  const head = item.candidate?.sha, ledger = item.mergeLedger?.head === head ? item.mergeLedger : null, trial = timings?.trial?.head === head ? timings!.trial : null;
  const submitted = item.submission ? time(item.pipeline?.resubmittedAt ?? item.pipeline?.submittedAt) : null;
  const approved = !item.policy.review ? submitted : time(item.observation?.reviews.findLast(review => review.sha === head && review.state === 'APPROVED')?.submittedAt);
  const failed = ledger?.state === 'refused' || !!trial?.steps.some(step => step.result === 'failed');
  const marks = [time(timings?.releasedAt) ?? time(item.pipeline?.attempts[0]?.claimedAt), submitted, approved, time(trial?.startedAt ?? ledger?.intentAt),
    failed ? null : time(trial?.finishedAt ?? ledger?.pushedAt), time(item.delivery?.mergedAt ?? item.observation?.mergedAt)];
  const current = marks.findLastIndex(mark => mark !== null);
  const stages = stageLabels.map(([id, label], index): Stage => {
    const from = marks[index], to = marks[index + 1], open = index === current;
    const ms = id === 'trial' && trial && (failed || to !== null) ? trial.durationMs : from === null ? null : to !== null ? to - from : open ? now - from : null;
    return { id, label, state: index < current ? 'done' : !open ? 'pending' : id === 'trial' && failed ? 'failed' : 'current', ms: ms === null ? null : Math.max(0, ms) };
  });
  const merged = marks[5] !== null;
  return { stages, totalMs: marks[0] === null ? null : Math.max(0, (marks[5] ?? now) - marks[0]), merged };
}

/** The pipeline row: each stage with this task's time in it, the total beside the median, and the trial's counts and slowest file. */
export function PipelineRow({ item, timings, median, now }: { item: Work; timings: TaskTimings | null; median: number | null; now: number }) {
  const { stages, totalMs, merged } = taskStages(item, timings, now), trial = timings?.trial;
  return <section className="task-pipeline" aria-label="Pipeline">
    {totalMs !== null && <p className="muted" data-pipeline-total>This task {plainDuration(totalMs / 60_000)}{merged ? '' : ' so far'}{median === null ? '' : ` · median ${plainDuration(median)}`}</p>}
    <ol>{stages.map(stage => <li key={stage.id} className={`stage-${stage.state}`} data-stage={stage.id} data-state={stage.state}>
      <strong>{stage.label}</strong>{stage.ms !== null && <span className="stage-time">{plainDuration(stage.ms / 60_000)}</span>}
      {stage.id === 'trial' && trial && (trial.groups.length > 0 || trial.slowest) && <span className="stage-note">{[...trial.groups.map(group => `${group.name} ${group.passed}/${group.total}`),
        ...(trial.slowest ? [`slowest: ${trial.slowest.file} ${shortDuration(trial.slowest.durationMs)}`] : [])].join(' · ')}</span>}
    </li>)}</ol>
  </section>;
}

const marks = { passed: '✓', failed: '×', running: '●' } as const;
/** The merge trial's checks, each with its result and time, and the output of the one that failed. */
export function Checks({ trial, output }: { trial: TrialTimings | null; output: string | null }) {
  return <section className="task-checks" aria-label="Checks">
    {trial?.steps.length ? <ul>{trial.steps.map((step, index) => <li key={index} className={`check-${step.result}`} data-check={step.step}>
      <span aria-hidden="true">{marks[step.result]}</span><span className="check-name">{step.step}</span><span className="check-result">{step.result}</span><span className="check-time">{shortDuration(step.durationMs)}</span></li>)}</ul>
      : <p className="muted">No merge trial has run on this change yet.</p>}
    {output && <pre className="run-log" aria-label="Test output">{output}</pre>}
  </section>;
}

/** The changed files with their line counts; a file's diff is read and shown when it is opened. */
export function ChangedFiles({ item, files, api }: { item: Pick<Work, 'id'>; files: ChangedFile[] | null; api: Api }) {
  const [open, setOpen] = useState<Record<string, string | null>>({});
  const toggle = (path: string) => {
    if (path in open) return setOpen(({ [path]: _closed, ...rest }) => rest);
    setOpen(shown => ({ ...shown, [path]: null }));
    void api(`work/${encodeURIComponent(item.id)}/diff?path=${encodeURIComponent(path)}`).then(body => String(body.diff ?? ''), (error: Error) => error.message)
      .then(diff => setOpen(shown => path in shown ? { ...shown, [path]: diff || 'No text diff: a binary file, or only its mode changed.' } : shown));
  };
  return <section className="task-diff" aria-label="Changed files">
    {!files?.length ? <p className="muted">{files ? 'No change submitted yet.' : 'The changed files are not readable right now.'}</p>
      : files.map(file => <div key={file.path} data-file={file.path}>
        <button type="button" className="diff-file" aria-expanded={file.path in open} onClick={() => toggle(file.path)}><span className="diff-path">{file.path}</span><span className="diff-add">+{file.additions}</span><span className="diff-del">−{file.deletions}</span></button>
        {file.path in open && <pre className="run-log diff-text">{open[file.path] === null ? 'Reading the diff…' : open[file.path]!.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : line.startsWith('@@') ? 'muted' : undefined}>{line}{'\n'}</span>)}</pre>}
      </div>)}
  </section>;
}

/** The commands the Lead decides a task with (src/engine/commands), as the ledger records them. */
const decisions = new Set(['create', 'ready', 'hold', 'unblock', 'rework', 'requirements', 'priority', 'message', 'resolve', 'window', 'rereview', 'work.closed']);
type Event = { seq: number | string; kind: string; actor: string; created_at: string; payload?: { details?: { reason?: string; text?: string } } };
/** The Lead's decisions on this task, newest first: what it decided, why in its own words, and when. */
export function LeadDecisions({ events, now }: { events: Event[]; now: number }) {
  const made = events.filter(event => /master/.test(event.actor) && decisions.has(event.kind));
  if (!made.length) return <p className="muted">The Lead has made no decision on this task yet.</p>;
  return <ul className="lead-decisions">{made.map(event => { const said = event.payload?.details?.reason ?? event.payload?.details?.text;
    return <li key={event.seq} data-decision={event.kind}><strong>{activityLabel(event.kind)}</strong>{said ? <span>{said}</span> : null}<small className="muted">{formatAge(event.created_at, now)} ago</small></li>; })}</ul>;
}
