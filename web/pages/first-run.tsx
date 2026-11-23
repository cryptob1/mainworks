import { useState } from 'react';
import { firstRunState } from '../../src/model/first-run';
import { COMMAND_NAME } from '../../src/model/product';
import { friendlyName } from '../fun';
import type { Dashboard } from './dashboard';
import { PageHeader } from '../components/page-layout';

/**
 * First-run page (GY-3603): shown instead of an empty Home when an install has no merged work.
 * Shows four steps — connect repository, confirm Builder via live request, start one small task,
 * watch it merge — with the current one marked, done ones ticked with their result, and each
 * step's terminal equivalent.
 */
export default function FirstRunPage(dashboard: Dashboard) {
  const { status, work, refresh, sessionEpoch, setView, setCreating, setSelected } = dashboard;
  const [checking, setChecking] = useState(false);
  const state = firstRunState(status, work);
  const builderName = state.builder ? friendlyName(state.builder.name) ?? state.builder.name : 'Builder';

  const recheck = async () => {
    setChecking(true);
    try { await refresh(sessionEpoch.current); } finally { setChecking(false); }
  };

  const steps: { number: 1 | 2 | 3 | 4; label: string; done: boolean; detail: string | null }[] = [
    { number: 1, label: 'Connect a repository', done: state.step1Done, detail: state.step1Done ? state.repository : null },
    { number: 2, label: 'Confirm your Builder', done: state.step2Done, detail: state.step2Done && state.builder ? `${builderName} · ${state.builder.modelId}` : null },
    { number: 3, label: 'Ship one small change', done: state.step3Done, detail: state.step3Done && state.activeTask ? `${state.activeTask.key} · ${state.activeTask.title}` : null },
    { number: 4, label: 'Watch it merge', done: false, detail: null },
  ];

  const stepState = (step: typeof steps[number]): 'done' | 'current' | 'pending' =>
    step.done ? 'done' : state.currentStep === step.number ? 'current' : 'pending';

  const current = steps[state.currentStep - 1];
  return <>
  <PageHeader title={current.label} fact={`Step ${state.currentStep} of 4 · ${steps.filter(step => step.done).length} done`}/>
  <div className="first-run" data-first-run-step={state.currentStep}>
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

    <div className="panel first-run-body">
      {state.currentStep === 1 && <>
        <p className="first-run-lead">Give Mainworks one deploy key or repository-scoped token so it can branch, push, and merge pull requests.</p>
        {state.fetchRefusal && <p role="alert" className="notice danger">{state.fetchRefusal}</p>}
        <div className="first-run-actions">
          <button type="button" className="first-run-cta" disabled={checking} onClick={() => void recheck()}>
            {checking ? 'Checking connection…' : 'Check connection'}
          </button>
          <span className="muted">First merged PR in about 10 minutes.</span>
        </div>
        <div className="first-run-terminal" data-terminal-equivalent>
          Prefer a terminal? <code>{COMMAND_NAME} up --repo {state.repository ?? 'OWNER/NAME'}</code> connects this repository and configures its deploy key or scoped token.
        </div>
      </>}

      {state.currentStep === 2 && <>
        <p className="first-run-lead">A live request checks that your Builder account answers on its registered model before it starts work.</p>
        {state.builder ? <div className="first-run-builder-card">
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
          {(!state.builder || state.builder.error || !state.builder.modelId) ? <>
            <button type="button" className="first-run-cta" onClick={() => { location.hash = 'connect'; setView('agents'); }}>Connect Builder account</button>
            <button type="button" className="first-run-secondary" disabled={checking} onClick={() => void recheck()}>
              {checking ? 'Refreshing status…' : 'Refresh status'}
            </button>
          </> : <>
            <button type="button" className="first-run-cta" disabled={checking} onClick={() => void recheck()}>
              {checking ? 'Refreshing status…' : 'Refresh status'}
            </button>
            <button type="button" className="first-run-secondary" onClick={() => { location.hash = 'connect'; setView('agents'); }}>Connect Builder account</button>
          </>}
        </div>
        <div className="first-run-terminal" data-terminal-equivalent>
          Prefer a terminal? <code>{COMMAND_NAME} master registry propose --apply</code> registers your host's logged-in Builder accounts in the control plane.
        </div>
      </>}

      {state.currentStep === 3 && <>
        <p className="first-run-lead">Describe one small change. {builderName} will branch, write a test, and open a pull request you can read before it merges.</p>
        <div className="first-run-actions">
          <button type="button" className="first-run-cta" onClick={() => setCreating(true)}>New task</button>
          <span className="muted">Nothing merges until its tests and a second agent's review pass.</span>
        </div>
        <div className="first-run-terminal" data-terminal-equivalent>
          Prefer a terminal? <code>{COMMAND_NAME} create task.json</code> files a task and <code>{COMMAND_NAME} ready GY-1 "First run"</code> dispatches it.
        </div>
      </>}

      {state.currentStep === 4 && state.activeTask && <>
        <p className="first-run-lead">{builderName} is working on {state.activeTask.title}. This page becomes Home when it merges.</p>
        <div className="first-run-actions">
          <button type="button" className="first-run-cta" onClick={() => setSelected(state.activeTask!.id)}>Open the task</button>
        </div>
        <div className="first-run-terminal" data-terminal-equivalent>
          Prefer a terminal? <code>{COMMAND_NAME} status {state.activeTask.key}</code> shows this task's gates and merge pipeline.
        </div>
      </>}
    </div>
  </div>
  </>;
}
