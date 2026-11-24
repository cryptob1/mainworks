import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// GY-3792: four tests seeding two million events took four minutes each and tripped the release
// check. A test proves plans, rows and bounds on a small table; the large-table timings live in `bench reads`.
const LIMIT = 200_000;
const namedRowCounts = /\b[A-Z_]*(?:EVENTS|ROWS)\s*=\s*([\d_]+)/g;

function evalArithmetic(input: string): number | null {
  const tokens = input.match(/\d+(?:\.\d+)?|[+\-*/()]|\S+/g);
  if (!tokens) return null;
  let pos = 0;
  const parseExpr = (): number | null => {
    let left = parseTerm();
    if (left === null) return null;
    while (tokens[pos] === '+' || tokens[pos] === '-') {
      const op = tokens[pos++];
      const right = parseTerm();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };
  const parseTerm = (): number | null => {
    let left = parseFactor();
    if (left === null) return null;
    while (tokens[pos] === '*' || tokens[pos] === '/') {
      const op = tokens[pos++];
      const right = parseFactor();
      if (right === null) return null;
      left = op === '*' ? left * right : left / right;
    }
    return left;
  };
  const parseFactor = (): number | null => {
    if (tokens[pos] === '(') {
      pos++;
      const value = parseExpr();
      if (value === null || tokens[pos] !== ')') return null;
      pos++;
      return value;
    }
    const token = tokens[pos++];
    if (!token || !/^\d+(?:\.\d+)?$/.test(token)) return null;
    return Number(token);
  };
  const value = parseExpr();
  return value !== null && pos === tokens.length && Number.isFinite(value) ? value : null;
}

function evalNumeric(expr: string, env: Map<string, number>, params: string[] = []): number | null {
  let text = expr.trim().replace(/\$\{([^}]+)\}/g, '($1)').replace(/::[a-zA-Z_]\w*/g, '');
  text = text.replace(/\$(\d+)/g, (_, idx) => {
    const param = params[Number(idx) - 1];
    return param ? `(${param})` : '$';
  });
  text = text.replace(/\b(\d[\d_]*)\b/g, m => m.replaceAll('_', ''));
  text = text.replace(/\b([A-Za-z_]\w*)\b/g, name => env.has(name) ? String(env.get(name)) : name);
  return evalArithmetic(text);
}

function collectBindings(source: string): Map<string, number> {
  const env = new Map<string, number>();
  // Match `const`/`let` declaration statements (including comma-separated lists like `const ITEMS = 100, DELTAS = 5_000;`).
  for (const match of source.matchAll(/\b(?:const|let)\s+([^;\n]+)/g)) {
    for (const part of match[1].split(',')) {
      const assign = part.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.+)$/);
      if (!assign) continue;
      const value = evalNumeric(assign[2], env);
      if (value !== null) env.set(assign[1], value);
    }
  }
  return env;
}

function extractParams(afterSql: string): string[] {
  const start = afterSql.match(/^\s*,\s*\[/);
  if (!start) return [];
  let depth = 0, i = start[0].length, current = '';
  const params: string[] = [];
  for (; i < afterSql.length; i++) {
    const ch = afterSql[i];
    if (ch === '[' || ch === '(' || ch === '{') { depth++; current += ch; }
    else if (ch === ']' || ch === ')' || ch === '}') {
      if (depth === 0 && ch === ']') { params.push(current.trim()); break; }
      depth--; current += ch;
    } else if (ch === ',' && depth === 0) {
      params.push(current.trim()); current = '';
    } else {
      current += ch;
    }
  }
  return params;
}

/** Find the product of JS `for (let i = 0; i < N; i++)` loops enclosing `offset`. */
function enclosingJsLoopMultiplier(source: string, offset: number, env: Map<string, number>): number {
  const loops: { depth: number; count: number }[] = [];
  let depth = 0;
  let pendingLoop: number | null = null;
  for (let i = 0; i < offset; i++) {
    const ch = source[i];
    if (ch === '{') {
      depth++;
      if (pendingLoop !== null) { loops.push({ depth, count: pendingLoop }); pendingLoop = null; }
    } else if (ch === '}') {
      while (loops.length && loops[loops.length - 1].depth >= depth) loops.pop();
      depth--;
    } else if (ch === 'f' && source.startsWith('for', i) && (i === 0 || !/\w/.test(source[i - 1])) && !/\w/.test(source[i + 3] ?? '')) {
      const head = source.slice(i).match(/^for\s*\(\s*let\s+(\w+)\s*=\s*([^;]+);\s*\1\s*(<=?)\s*([^;]+);/);
      if (head) {
        const start = evalNumeric(head[2], env);
        const end = evalNumeric(head[4], env);
        if (start !== null && end !== null) {
          const count = head[3] === '<=' ? end - start + 1 : end - start;
          if (count > 1) pendingLoop = count;
        }
      }
    }
  }
  return loops.reduce((acc, l) => acc * l.count, 1);
}

/** Extract seeded row counts from SQL `generate_series` calls, PL/pgSQL `FOR` loops, JS `for` loops, and `*EVENTS`/`*ROWS` constants. */
function seededCounts(source: string): number[] {
  const env = collectBindings(source);
  const counts: number[] = [];

  for (const match of source.matchAll(namedRowCounts)) {
    counts.push(Number(match[1].replaceAll('_', '')));
  }

  // Scan SQL strings passed to `.query(...)` (template literals or single/double-quoted strings).
  const queryCall = /\.query\(\s*(`(?:\\.|[^`])*`|'(?:\\.|[^'])*'|"(?:\\.|[^"])*")/g;
  for (const match of source.matchAll(queryCall)) {
    const rawSql = match[1].slice(1, -1);
    const after = source.slice((match.index ?? 0) + match[0].length);
    const params = extractParams(after);
    const jsMultiplier = enclosingJsLoopMultiplier(source, match.index ?? 0, env);

    // Strip scalar `SELECT jsonb_agg(...) FROM generate_series(...)` subqueries, which build a JSON array on one row.
    const sql = rawSql.replace(/SELECT\s+jsonb_agg\b[\s\S]*?FROM\s+generate_series\([^)]*\)/gi, '');

    const pgLoopStack: number[] = [];
    const tokens = sql.matchAll(/\bFOR\s+\w+\s+IN\s+1\.\.([^\s;]+)\s+LOOP\b|\bEND\s+LOOP\b|\bgenerate_series\(\s*1\s*,\s*([^)]+)\)/gi);
    for (const token of tokens) {
      if (token[1] !== undefined) {
        const n = evalNumeric(token[1], env, params);
        pgLoopStack.push(n ?? 1);
      } else if (/^END\s+LOOP$/i.test(token[0])) {
        pgLoopStack.pop();
      } else if (token[2] !== undefined) {
        const n = evalNumeric(token[2], env, params);
        if (n !== null) {
          const pgMultiplier = pgLoopStack.reduce((a, b) => a * b, 1);
          counts.push(Math.round(jsMultiplier * pgMultiplier * n));
        }
      }
    }
  }

  // Also catch bare `generate_series(1, ...)` outside `.query(...)` (e.g. helper SQL builders).
  const stripped = source.replace(/SELECT\s+jsonb_agg\b[\s\S]*?FROM\s+generate_series\([^)]*\)/gi, '');
  for (const match of stripped.matchAll(/generate_series\(\s*1\s*,\s*([^)]+)\)/g)) {
    const n = evalNumeric(match[1], env);
    if (n !== null) counts.push(n);
  }

  return counts;
}

test('unit:no-test-seeds-a-huge-table — no test file seeds more than 200,000 rows', () => {
  // Split patterns so this file does not match itself.
  const q = '.qu' + 'ery(';
  assert.ok(seededCounts('const ITEMS = 2000, EVENTS' + ' = 2_000_000;').includes(2_000_000));
  assert.ok(seededCounts('generate_series(1, ' + '300000)').includes(300_000));
  assert.ok(seededCounts('const ROUTINE = 250_000;\nconst sql = `FROM generate_series(1, ${' + 'ROUTINE})`;').includes(250_000));
  assert.ok(seededCounts(`const ITEMS = 100, DELTAS_PER_ITEM = 5_000;\npool${q}\`DO $$ BEGIN FOR i IN 1..\${ITEMS} LOOP INSERT INTO events SELECT g FROM generate_series(1, \${DELTAS_PER_ITEM}) g; END LOOP; END $$\`);`).includes(500_000));
  assert.ok(seededCounts(`const N = 250_000;\npool${q}\`INSERT INTO events SELECT g FROM generate_series(1, $1::int) g\`, [N]);`).includes(250_000));
  assert.ok(seededCounts(`const items = 400, per = 600;\nfor (let i = 0; i < items; i++) { pool${q}\`INSERT INTO events SELECT g FROM generate_series(1, $1::int) g\`, [per]); }`).includes(240_000));

  const files = readdirSync('tests', { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.test.ts'));
  assert.ok(files.length > 100);
  const huge = files.flatMap(file =>
    [...new Set(seededCounts(readFileSync(join('tests', file), 'utf8')).filter(count => count > LIMIT))].map(count => `${file}: ${count}`),
  );
  assert.deepEqual(huge, [], 'seed at most 200,000 rows; time large tables with `mainworks bench reads`');
});
