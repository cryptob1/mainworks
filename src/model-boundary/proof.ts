import { z } from 'zod';
export const proofSchema = z.string().regex(/^(unit|integration|e2e|manual|human|check):[a-zA-Z0-9._/-]+$/);
