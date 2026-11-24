import { rename, writeFile } from 'node:fs/promises';

/** Writes the Lead's daemon state file whole, as the loop does (temporary file, then rename): the
 *  spec's terminal stream re-reads it every second, and an in-place write showed it an empty file
 *  that ended the stream and reconnected the page (GY-3752). */
export async function saveMasterState(file: string, state: unknown) {
  await writeFile(`${file}.tmp`, JSON.stringify(state));
  await rename(`${file}.tmp`, file);
}
