// Runtime liveness and launch history; session reservations live only in the registry.
import { resolve } from 'node:path';
import { stateDirectory } from '../install/layout.js';
export class DispatchReservedError extends Error {
  readonly dispatchReserved = true;
  constructor(readonly resource: 'profile' | 'work', readonly subject: string, message: string) { super(message); }
}
export const dispatchReservationDirectory = (root: string) => resolve(stateDirectory(root), 'dispatch');
export const dispatchedFile = (root: string, key: string) => resolve(dispatchReservationDirectory(root), `dispatched-${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
