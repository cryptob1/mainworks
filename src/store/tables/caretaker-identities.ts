import { defineTable } from '../tables.js';

/** GY-3593: the install's caretaker identity the loop minted; only the token's digest is kept. */
export const caretakerIdentities = defineTable({
  name: 'caretaker_identities', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS caretaker_identities (
  id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, minted_by text NOT NULL, minted_at timestamptz NOT NULL
);`,
});
