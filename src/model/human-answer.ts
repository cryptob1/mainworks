import type { z } from 'zod';
import type { humanAnswerSchema } from '../model-boundary/human-answer.js';
import { type HumanRequest, requestChoices } from './human-request.js';
import { demand } from './refusal.js';
export type HumanAnswerInput = z.infer<typeof humanAnswerSchema>;
/**
 * What an answer records: the outcome, the words the next worker reads, and the choice pressed.
 * A choice that asks for words needs them; a secret goes only to a secret choice.
 */
export function resolveHumanAnswer(request: Pick<HumanRequest, 'kind' | 'choices' | 'sealTo' | 'variable'>, data: HumanAnswerInput) {
  // A variable's value is sealed in the owner's browser and pasted there only: a relay would carry it through an agent.
  demand(!request.variable || !data.ownerSaid, `Paste ${request.variable} on the dashboard yourself; relaying it would put it in an agent's context`, 403);
  if (!data.choice) {
    demand(!data.secret && !data.sealedValue, 'A secret is sent only with the choice that asks for it', 422);
    return { outcome: data.outcome, text: data.answer!, choice: null, note: null, secret: false, sealedValue: false };
  }
  const choice = requestChoices(request).find(entry => entry.id === data.choice);
  demand(choice, `No choice ${data.choice} on this request; reload before answering`, 422);
  const note = data.note || data.answer || null;
  demand(choice!.input !== 'text' || note, `${choice!.label} needs your words in the note`, 422);
  const asks = choice!.input === 'secret', sealedInBrowser = asks && !!request.variable;
  demand(sealedInBrowser ? !!data.sealedValue && !data.secret : asks ? !!data.secret && !data.sealedValue : !data.secret && !data.sealedValue,
    sealedInBrowser ? `${choice!.label} needs the value sealed in the browser` : asks ? `${choice!.label} needs the value to seal` : 'A secret is sent only with the choice that asks for it', 422);
  return { outcome: choice!.outcome, text: note ? `${choice!.label}: ${note}` : choice!.label, choice: { id: choice!.id, label: choice!.label }, note, secret: asks && !sealedInBrowser, sealedValue: sealedInBrowser };
}

/**
 * `withdrawn`: nobody answered; the item was closed and the question no longer stands (model/closure.ts).
 * `superseded-by-observation` (GY-1815, retired): an answer recorded before GY-2874 that the asked state was observed to hold.
 */
export interface HumanAnswer {
  ownerSaid?: string;
  by: string; at: string; outcome: 'provided' | 'declined' | 'withdrawn' | 'superseded-by-observation'; text: string; waitedMs: number;
  /** The button pressed and the note beside it (GY-738); absent on a free-text answer. */
  choice?: { id: string; label: string } | null; note?: string | null;
  /** A secret choice's value, sealed to the requesting host's key (server/waits.ts `sealToHost`). */
  sealed?: string | null;
  /** A variable's value as the browser sealed it to the loop host's connect key; dropped once the loop has tried it. */
  sealedValue?: { ephemeral: string; iv: string; ciphertext: string } | null;
  /** Where the loop set the variable, or why it could not (server/waits.ts `recordVariableApplied`). */
  applied?: { at: string; environments: string[]; error?: string } | null;
}
