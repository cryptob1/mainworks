import { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
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
  let http: ReturnType<typeof server> | undefined;
  before(async () => {
    store = await withDatabase(label, options.storeOptions);
    await store.init();
    const engine = new Engine(store, options.leaseSeconds ?? 120, options.repository ?? 'owner/project');
    if (options.principals) engine.principals = options.principals;
    let url = '';
    if (options.credentials) {
      http = server(engine, options.credentials, options.serverOptions);
      await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    }
    await ready({ store, engine, http: http!, url });
  });
  after(async () => {
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    if (store) await store.close();
  });
}
