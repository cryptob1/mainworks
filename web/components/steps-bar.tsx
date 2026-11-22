import { stateIds, stateLabel, type PrSteps } from '../../src/model/pr-steps';

/**
 * The four item states as one bar (GY-1979): Todo, Doing, Checking, Done — done, current (live)
 * and pending segments, with the current state's plain-words label under it. The Work page row,
 * the phone card and the item page all draw this component from `prSteps`, so the three can never
 * disagree. Done means merged; the deployment is the board's one release line, not a state here.
 */
export default function StepsBar({ steps, labelled = true }: { steps: PrSteps; labelled?: boolean }) {
  const at = steps.current ? steps.steps.findIndex(step => step.id === steps.current) + 1 : steps.steps.length;
  return <span className="steps-bar" data-current={steps.current ?? 'none'}>
    <span className="steps-track" role="img" aria-label={`State ${at} of ${steps.steps.length}: ${steps.label}`}>
      {steps.steps.map(step => <span key={step.id} className={`step-seg ${step.state}`} data-step={step.id} data-state={step.state} title={step.label}/>)}
    </span>
    {labelled && <span className="steps-label">{steps.label}</span>}
  </span>;
}

/**
 * The four state names above the Moving rows, laid out as the same track as each row's bar (same
 * element, same gap, one equal share per state) so every name sits over its own segment.
 */
export function StepNames() {
  return <span className="steps-track step-names" aria-hidden="true">{stateIds.map(id => <span key={id} className="step-name" data-step={id}>{stateLabel[id]}</span>)}</span>;
}
