import { AsyncResource } from 'node:async_hooks';
import type pg from 'pg';
import { recordQuery } from './slow-queries.js';

/** A failed statement's SQL, as `namedStatements` attaches it to the error the driver raised. */
export const failedStatement = (error: unknown): string | null =>
  error && typeof error === 'object' && typeof (error as { statement?: unknown }).statement === 'string' ? (error as { statement: string }).statement : null;
/**
 * Every statement a pool's connections run carries its SQL on the error it fails with (GY-422), so
 * a request that fails on "canceling statement due to statement timeout" is logged with the
 * statement that ran out of time, not only the driver's sentence. Each connection's `query` is
 * wrapped once, when the pool opens it; `pool.query` runs through the same connections. Each
 * statement is timed for the slowest-query report (slow-queries.ts, GY-3757).
 */
export function namedStatements(pool: pg.Pool) {
  pool.on('connect', client => {
    const query = client.query.bind(client) as (...args: any[]) => any;
    const name = (error: unknown, config: unknown) => {
      const text = typeof config === 'string' ? config : (config as { text?: unknown } | null)?.text;
      if (error && typeof error === 'object' && typeof text === 'string' && !failedStatement(error)) Object.defineProperty(error, 'statement', { value: text, enumerable: false, configurable: true });
      return error;
    };
    (client as unknown as { query: (...args: any[]) => any }).query = (...args: any[]) => {
      const config = args[0];
      if (config && typeof config === 'object' && typeof config.submit === 'function') return query(...args);
      const last = args.length - 1, started = performance.now();
      const timed = () => { const text = typeof config === 'string' ? config : config?.text; if (typeof text === 'string') recordQuery(text, performance.now() - started); };
      if (typeof args[last] === 'function') { const done = args[last]; args[last] = AsyncResource.bind((error: unknown, result: unknown) => { timed(); done(error ? name(error, config) : error, result); }); return query(...args); }
      const result = query(...args);
      return result && typeof result.then === 'function' ? result.then((value: unknown) => { timed(); return value; }, (error: unknown) => { timed(); throw name(error, config); }) : result;
    };
  });
  // GY-3762: `pool.query` waits for a connection, and the driver answers, by callbacks called from other contexts; bound, a statement keeps its caller.
  const connect = pool.connect.bind(pool) as (...args: any[]) => any;
  (pool as unknown as { connect: (...args: any[]) => any }).connect = (...args: any[]) => typeof args[0] === 'function' ? connect(AsyncResource.bind(args[0])) : connect(...args);
  return pool;
}
