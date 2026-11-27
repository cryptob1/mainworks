import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { verifyBackup, writeBackupFile } from '../../src/backup.js';
import { temporaryDirectory } from './temp-dirs.js';

/** A whole-ledger backup as `db backup` writes it, read back as one verified document. */
export async function createBackup(pool: pg.Pool) {
  const file = join(await temporaryDirectory('backup-document'), 'ledger.json');
  await writeBackupFile(pool, file);
  return verifyBackup(JSON.parse(await readFile(file, 'utf8')));
}
