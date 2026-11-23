// Concern: the wording of a loop action's detail — bounded, compared and listing paths.
export const actionDetailMax = 2000;

/**
 * An action detail within its bound. A detail that lists paths — or quotes an error that does — is cut, never left to fail record()
 * after the action it records has already happened. record() applies it to every detail it stores.
 */
export function boundDetail(detail: string, max = actionDetailMax): string {
  return detail.length <= max ? detail : `${detail.slice(0, max - 1)}…`;
}
