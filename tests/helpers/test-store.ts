import { after, before } from 'node:test';
import { listen } from './http-server.js';
import { withDatabase } from './postgres.js';
import { Store } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { server } from '../../src/server.js';
import type { Principal } from '../../src/model.js';

interface TestStoreContext {
  store: Store;
  engine: Engine;
  http: ReturnType<typeof server>;
  url: string;
}

interface TestStoreOptions {
  leaseSeconds?: number;
  repository?: string;
  principals?: Principal[];
  credentials?: Parameters<typeof server>[1];
  serverOptions?: Parameters<typeof server>[2];
  storeOptions?: ConstructorParameters<typeof Store>[1];
}

/**
 * Provision an initialized Store, Engine and (when `credentials` is given) local HTTP server
 * in `before`, then close them in `after`.
 */
export function useTestStore(
  label: string,
  options: TestStoreOptions,
  ready: (ctx: TestStoreContext) => Promise<void> | void,
) {
  let store: Store | undefined;
  let close: (() => Promise<void>) | undefined;
  before(async () => {
    store = await withDatabase(label, options.storeOptions);
    await store.init();
    const engine = new Engine(store, options.leaseSeconds ?? 120, options.repository ?? 'owner/project');
    if (options.principals) engine.principals = options.principals;
    let url = '', http: ReturnType<typeof server> | undefined;
    if (options.credentials) {
      const bound = await listen(server(engine, options.credentials, options.serverOptions));
      http = bound.server; url = bound.url; close = bound.close;
    }
    await ready({ store, engine, http: http!, url });
  });
  after(async () => { await close?.(); await store?.close(); });
}
