import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export interface ApiOptions { method?: string; body?: unknown; key?: string; headers?: Record<string, string>; signal?: AbortSignal }

/** One authenticated control-plane request: `url`/api/`path` with the Bearer token and a fresh Idempotency-Key; GET without a body, POST with one unless `method` says otherwise. */
export async function api(url: string, bearer: string, path: string, { method, body, key = randomUUID(), headers = {}, signal }: ApiOptions = {}) {
  const response = await fetch(`${url}/api/${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), signal,
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
}

/** {@link api} that asserts a 200 and returns the parsed body. */
export async function apiOk(url: string, bearer: string, path: string, options: ApiOptions = {}) {
  const result = await api(url, bearer, path, options);
  assert.equal(result.status, 200, `${options.method ?? ''} ${path}: ${JSON.stringify(result.body)}`.trim());
  return result.body;
}
