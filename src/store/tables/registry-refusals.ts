import { defineTable } from '../tables.js';

/**
 * Repeats of one registry refusal (GY-3095): the `agent-registry.refused` ledger row stands for
 * the first refusal, and each identical refusal of the same request after it raises this row's
 * count and last-seen time instead of appending another row, so registry history keeps real
 * changes among its newest entries. Keyed by the refusal's event sequence.
 */
const registryRefusalRepeats = defineTable({
  name: 'registry_refusal_repeats', orderBy: 'seq',
  ddl: `CREATE TABLE IF NOT EXISTS registry_refusal_repeats (
  seq bigint PRIMARY KEY, count integer NOT NULL, last_at timestamptz NOT NULL
);`,
});

/**
 * GY-4005: the agent registry's current document, one row. Its history stays on the ledger as
 * `agent-registry.*` events that carry only the change and the fields it touched; before this every
 * event carried the whole document (about 94 KB), and those rows were most of the events table.
 */
const agentRegistry = defineTable({
  name: 'agent_registry', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS agent_registry (id boolean PRIMARY KEY DEFAULT true CHECK (id), document jsonb NOT NULL);`,
});

export const registryRefusalTables = [registryRefusalRepeats, agentRegistry];
