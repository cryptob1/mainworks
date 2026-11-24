import type pg from 'pg';

export interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

export interface QueryPlan {
  root: PlanNode;
  nodes: PlanNode[];
  indexes: string[];
  seqScans: string[];
  /** Total shared buffers touched (hit + read) across the entire execution, including TOAST and functions. */
  buffers: number;
  /** Rows emitted by the root node. */
  rows: number;
  /** Rows read (emitted + filter-removed) across scan nodes for `relation` (or all scan nodes when omitted). */
  rowsScanned: (relation?: string) => number;
  /** Compact JSON string for assertion diagnostics. */
  summary: string;
}

const scanNodes = new Set(['Seq Scan', 'Index Scan', 'Index Only Scan', 'Bitmap Heap Scan', 'Tid Scan', 'Tid Range Scan']);

function flatten(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) flatten(child, out);
  return out;
}

export async function explainAnalyzeBuffers(
  client: Pick<pg.Client, 'query'>,
  sql: string,
  values: unknown[] = [],
): Promise<QueryPlan> {
  const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, values);
  const root = (rows[0]['QUERY PLAN'] as { Plan: PlanNode }[])[0].Plan;
  const nodes = flatten(root);
  const indexes = [...new Set(nodes.map(node => node['Index Name']).filter((name): name is string => !!name))];
  const seqScans = [...new Set(nodes.filter(node => node['Node Type'] === 'Seq Scan').map(node => node['Relation Name'] ?? 'unknown'))];
  const buffers = (root['Shared Hit Blocks'] ?? 0) + (root['Shared Read Blocks'] ?? 0);
  const actualRows = (root['Actual Rows'] ?? 0) * (root['Actual Loops'] ?? 1);
  const rowsScanned = (relation?: string) => nodes
    .filter(node => scanNodes.has(node['Node Type']) && (!relation || node['Relation Name'] === relation))
    .reduce((sum, node) => sum + ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * (node['Actual Loops'] ?? 1), 0);
  const summary = JSON.stringify({ indexes, seqScans, buffers, rows: actualRows, eventsScanned: rowsScanned('events') });
  return { root, nodes, indexes, seqScans, buffers, rows: actualRows, rowsScanned, summary };
}
