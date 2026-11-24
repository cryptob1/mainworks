import { z } from 'zod';
// ---------------------------------------------------------------------------
// The human's answer to a parked request (GY-89, GY-738): what it may carry and what it records.
// ---------------------------------------------------------------------------

export const humanAnswerSchema = z.object({
  ownerSaid: z.string().trim().min(1).max(4000).optional(),
  reverses: z.string().optional(),
  request: z.string().uuid(),
  /** `provided`: the thing asked for now exists, so the item resumes. `declined`: it will not, and the item stays parked with the answer as its blocker. A choice sets it. */
  outcome: z.enum(['provided', 'declined']).default('provided'),
  /** Free words, for a request answered without a choice. */
  answer: z.string().trim().min(1).max(4000).optional(),
  /** The id of the button pressed, and the operator's optional note beside it. */
  choice: z.string().min(1).max(40).optional(),
  note: z.string().trim().max(4000).optional(),
  /** A `secret` choice's value: sealed before anything is written, never stored as given. */
  secret: z.string().min(1).max(8000).optional(),
  /** A variable request's value, sealed in the browser to the loop host's connect key (web/seal.ts): the server never sees it. */
  sealedValue: z.object({ ephemeral: z.base64().max(400), iv: z.base64().max(40), ciphertext: z.base64().max(12000) }).strict().optional(),
}).strict().refine(data => data.answer || data.choice, 'Give a choice or an answer');
