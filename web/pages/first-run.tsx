import { useEffect, useState } from 'react';
import { draftFirstRunTask, firstRunState, type SmallIssue } from '../../src/model/first-run';
import { friendlyName } from '../fun';
import type { Dashboard } from './dashboard';
import WorkDetails from './work-details';

/**
 * First-run page (GY-3603): shown instead of an empty Home when an install has no merged work.
 * Walks a new person through four steps — connect repository, confirm Builder via live request,
 * pick one small open issue or type a one-line fix, and watch the task merge — each stating its
 * terminal equivalent (`npx mainworks up`). Matches the approved Start prototype.
 */
export default function FirstRunPage(dashboard: Dashboard) {
  const { status, work, api, refresh, sessionEpoch, setView } = dashboard;
  const [startedId, setStartedId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [issues, setIssues] = useState<SmallIssue[] | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [ownText, setOwnText] = useState('');
  const [starting, setStarting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const state = firstRunState(status, work, startedId);
  const builderName = state.builder ? friendlyName(state.builder.name) ?? state.builder.name : 'Builder';

  useEffect(() => {
    if (state.currentStep !== 3 || !state.repository) return;
    let active = true;
    void api('first-run/issues').then(
      (body: { issues?: SmallIssue[] }) => {
        if (!active) return;
        const list = Array.isArray(body?.issues) ? body.issues.slice(0, 3) : [];
        setIssues(list);
        setSelectedNumber(prev => (prev !== null && list.some(i => i.number === prev) ? prev : list[0]?.number ?? null));
      },
      () => { if (active) setIssues([]); },
    );
    return () => { active = false; };
  }, [state.currentStep, state.repository]);

  const recheck = async () => {
    setChecking(true);
    try { await refresh(sessionEpoch.current); } finally { setChecking(false); }
  };

  const selectedIssue = ownText.trim() ? null : (issues ?? []).find(i => i.number === selectedNumber) ?? null;
  const canStart = !!ownText.trim() || !!selectedIssue;

  const startTask = async () => {
    if (!canStart || starting) return;
    setStarting(true);
    setSubmitError('');
    const epoch = sessionEpoch.current;
    try {
      const body = ownText.trim() ? draftFirstRunTask({ text: ownText.trim() }) : draftFirstRunTask({ issue: selectedIssue! });
      const created = await api('work', body);
      if (epoch !== sessionEpoch.current) return;
      await api(`work/${encodeURIComponent(created.id)}/ready`, { expectedRevision: created.revision, reason: 'Started from first-run setup' });
      if (epoch !== sessionEpoch.current) return;
      setStartedId(created.id);
      await refresh(epoch);
    } catch (err) {
      if (epoch === sessionEpoch.current) setSubmitError((err as Error).message);
    } finally {
      if (epoch === sessionEpoch.current) setStarting(false);
    }
  };

  const steps: { number: 1 | 2 | 3 | 4; label: string; done: boolean; detail: string | null }[] = [
    { number: 1, label: 'Connect a repository', done: state.step1Done, detail: state.step1Done ? state.repository : null },
    { number: 2, label: 'Confirm your Builder', done: state.step2Done, detail: state.step2Done && state.builder ? `${builderName} · ${state.builder.modelId}` : null },
    { number: 3, label: 'Ship one small change', done: state.step3Done, detail: state.step3Done && state.activeTask ? `${state.activeTask.key} · ${state.activeTask.title}` : null },
    { number: 4, label: 'Watch it merge', done: false, detail: null },
  ];

  const stepState = (step: typeof steps[number]): 'done' | 'current' | 'pending' =>
    step.done ? 'done' : state.currentStep === step.number ? 'current' : 'pending';

  return <div className="first-run" data-first-run-step={state.currentStep}>
    <ol className="first-run-steps" aria-label="Steps">
      {steps.map(step => {
        const current = state.currentStep === step.number;
        const kind = stepState(step);
        return <li key={step.number} data-step={step.number} data-step-state={kind} className={`first-run-step step-${kind}`} aria-current={current ? 'step' : undefined}>
          <span className="first-run-step-label">
            {step.done && <span className="first-run-tick" aria-hidden="true">✓ </span>}
            {step.number}. {step.label}
          </span>
          {step.detail && <div className="first-run-step-detail">{step.detail}</div>}
        </li>;
      })}
    </ol>

    <section className="first-run-body" aria-labelledby="first-run-title">
      {state.currentStep === 1 && <>
        <h1 id="first-run-title">Connect a repository</h1>
        <p className="first-run-lead">Give Mainworks one deploy key or repository-scoped token so it can branch, push, and merge pull requests.</p>
        {state.fetchRefusal && <p role="alert" className="notice danger">{state.fetchRefusal}</p>}
        <div className="first-run-actions">
          <button type="button" className="first-run-cta" disabled={checking} onClick={() => void recheck()}>
            {checking ? 'Checking connection…' : 'Check connection'}
          </button>
          <span className="muted">First merged PR in about 10 minutes.</span>
        </div>
        <div className="first-run-terminal" data-terminal-equivalent>
          Prefer a terminal? <code>npx mainworks up</code> connects your repository and configures its deploy key or scoped token.
        </div>
      </>}

      {state.currentStep === 2 && <>
        <h1 id="first-run-title">Confirm your Builder</h1>
        <p className="first-run-lead">A live request checks that your Builder account answers on its registered model before it starts work.</p>
        {state.builder ? <div className="panel first-run-builder-card">
          <dl className="facts">
            <div><dt>Builder</dt><dd>{builderName} <span className="muted mono">({state.builder.name})</span></dd></div>
            <div><dt>Registered model</dt><dd><code data-model-id>{state.builder.modelId ?? 'No model id registered'}</code></dd></div>
            {state.builder.host && <div><dt>Machine</dt><dd>{state.builder.host}</dd></div>}
          </dl>
          {state.builder.error
            ? <p role="alert" className="notice danger">{state.builder.error}</p>
            : !state.builder.modelId
              ? <p role="alert" className="notice">Register a concrete model id on this Builder account so Mainworks knows which model answers.</p>
              : <p className="muted">Waiting for a live request to answer on <span className="mono">{state.builder.modelId}</span>…</p>}
        </div> : <p className="muted">No Builder account is connected yet.</p>}
        <div className="first-run-actions">
          <button type="button" className="first-run-cta" disabled={checking} onClick={() => void recheck()}>
            {checking ? 'Checking Builder…' : 'Check Builder'}
          </button>
          <button type="button" onClick={() => { location.hash = 'connect'; setView('agents'); }}>Connect Builder account</button>
        </div>
        <div className="first-run-terminal" data-terminal-equivalent>
          Prefer a terminal? <code>npx mainworks up</code> connects your Builder and runs the live model check.
        </div>
      </>}

      {state.currentStep === 3 && <>
        <h1 id="first-run-title">Ship one small change</h1>
        <p className="first-run-lead">Pick an open issue or type a one-line fix. {builderName} will branch, write a test, and open a pull request you can read before it merges.</p>
        <fieldset className="first-run-issues">
          <legend>Small open issues in this repository</legend>
          {issues === null && <p className="muted">Reading open issues…</p>}
          {issues !== null && issues.length === 0 && <p className="muted">No open issues found in this repository. Describe a small change below.</p>}
          {(issues ?? []).map(issue => {
            const checked = !ownText.trim() && selectedNumber === issue.number;
            return <label key={issue.number} className={checked ? 'first-run-issue selected' : 'first-run-issue'}>
              <input type="radio" name="first-run-pick" checked={checked} onChange={() => { setSelectedNumber(issue.number); setOwnText(''); }}/>
              <span><strong>#{issue.number}</strong> {issue.title}</span>
            </label>;
          })}
        </fieldset>
        <div className="first-run-own">
          <label htmlFor="first-run-own">Or describe your own</label>
          <input id="first-run-own" placeholder="For example: the footer year is hard-coded" value={ownText} onChange={e => setOwnText(e.currentTarget.value)}/>
        </div>
        {submitError && <p role="alert" className="notice danger">{submitError}</p>}
        <div className="first-run-actions">
          <button type="button" className="first-run-cta" disabled={!canStart || starting} onClick={() => void startTask()}>
            {starting ? `Starting ${builderName}…` : ownText.trim() ? `Start ${builderName} on this change` : selectedIssue ? `Start ${builderName} on #${selectedIssue.number}` : `Start ${builderName} on this change`}
          </button>
          <span className="muted">Nothing merges until its tests and a second agent's review pass.</span>
        </div>
        <div className="first-run-terminal" data-terminal-equivalent>
          Prefer a terminal? <code>npx mainworks up</code> does steps 1 to 3 and prints the PR link.
        </div>
      </>}

      {state.currentStep === 4 && state.activeTask && <>
        <WorkDetails key={state.activeTask.id} {...dashboard} item={state.activeTask} embedded defaultTab="Live session"/>
        <div className="first-run-terminal" data-terminal-equivalent>
          Prefer a terminal? <code>npx mainworks up</code> watches the task until its pull request merges.
        </div>
      </>}
    </section>
  </div>;
}
