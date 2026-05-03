import { describe, expect, it, vi } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import {
  AuthError,
  ExpiredKeyError,
  NotFoundError,
  RevokedKeyError,
  SessionTimeoutError,
  TransportError,
  ValidationError,
} from '../../src/errors.js';
import { HttpClient } from '../../src/http.js';

interface FakeFetchSpec {
  status: number;
  body?: string | Record<string, unknown>;
  headers?: Record<string, string>;
}

function fakeFetch(spec: FakeFetchSpec): typeof fetch {
  return vi.fn(async () => {
    await Promise.resolve();
    // 204 forbids a body per spec; pass null.
    if (spec.status === 204 || spec.status === 304) {
      return new Response(null, { status: spec.status, headers: spec.headers ?? {} });
    }
    const bodyStr =
      typeof spec.body === 'string'
        ? spec.body
        : spec.body !== undefined
          ? JSON.stringify(spec.body)
          : '';
    return new Response(bodyStr, {
      status: spec.status,
      headers: spec.headers ?? {},
    });
  });
}

const NEVER_RETRY = { maxAttempts: 0 } as const;

describe('HttpClient.request', () => {
  it('200 with JSON body returns parsed value', async () => {
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: fakeFetch({ status: 200, body: { hello: 'world' } }),
      retry: NEVER_RETRY,
    });
    const got = await http.request<{ hello: string }>({ method: 'GET', path: '/v1/x' });
    expect(got.hello).toBe('world');
  });

  it('204 returns undefined', async () => {
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: fakeFetch({ status: 204 }),
      retry: NEVER_RETRY,
    });
    const got = await http.request<void>({ method: 'DELETE', path: '/v1/x' });
    expect(got).toBeUndefined();
  });

  it('injects Authorization header', async () => {
    let captured: RequestInit | undefined;
    const http = new HttpClient({
      apiKey: 'ds_live_secret',
      baseUrl: 'http://api.test',
      fetch: vi.fn(async (_url, init) => {
        captured = init;
        await Promise.resolve();
        return new Response('{}', { status: 200 });
      }),
      retry: NEVER_RETRY,
    });
    await http.request<unknown>({ method: 'GET', path: '/v1/x' });
    const headers = captured?.headers as Record<string, string> | undefined;
    expect(headers?.['authorization']).toBe('Bearer ds_live_secret');
  });

  it('appends query parameters', async () => {
    let capturedUrl: string | undefined;
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: vi.fn(async (url) => {
        capturedUrl = String(url);
        await Promise.resolve();
        return new Response('{}', { status: 200 });
      }),
      retry: NEVER_RETRY,
    });
    await http.request<unknown>({
      method: 'GET',
      path: '/v1/x',
      query: { limit: 25, cursor: 'abc' },
    });
    expect(capturedUrl).toContain('limit=25');
    expect(capturedUrl).toContain('cursor=abc');
  });

  it('400 validation problem maps to ValidationError', async () => {
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: fakeFetch({
        status: 400,
        body: { type: PROBLEM_TYPES.ValidationFailed, title: 'V', status: 400 },
      }),
      retry: NEVER_RETRY,
    });
    await expect(http.request<unknown>({ method: 'GET', path: '/v1/x' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('401 unauthorized maps to AuthError', async () => {
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: fakeFetch({
        status: 401,
        body: { type: PROBLEM_TYPES.Unauthorized, title: 'U', status: 401 },
      }),
      retry: NEVER_RETRY,
    });
    await expect(http.request<unknown>({ method: 'GET', path: '/v1/x' })).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it('401 revoked-key maps to RevokedKeyError', async () => {
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: fakeFetch({
        status: 401,
        body: { type: PROBLEM_TYPES.RevokedKey, title: 'Revoked', status: 401 },
      }),
      retry: NEVER_RETRY,
    });
    await expect(http.request<unknown>({ method: 'GET', path: '/v1/x' })).rejects.toBeInstanceOf(
      RevokedKeyError,
    );
  });

  it('401 expired-key maps to ExpiredKeyError', async () => {
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: fakeFetch({
        status: 401,
        body: { type: PROBLEM_TYPES.ExpiredKey, title: 'Expired', status: 401 },
      }),
      retry: NEVER_RETRY,
    });
    await expect(http.request<unknown>({ method: 'GET', path: '/v1/x' })).rejects.toBeInstanceOf(
      ExpiredKeyError,
    );
  });

  it('504 session-timeout maps to SessionTimeoutError carrying timeout_ms', async () => {
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: fakeFetch({
        status: 504,
        body: {
          type: PROBLEM_TYPES.SessionTimeout,
          title: 'Session timeout',
          status: 504,
          timeout_ms: 30_000,
        },
      }),
      retry: NEVER_RETRY,
    });
    const err = await http
      .request<unknown>({ method: 'GET', path: '/v1/x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionTimeoutError);
    expect((err as SessionTimeoutError).timeoutMs).toBe(30_000);
  });

  it('404 maps to NotFoundError', async () => {
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: fakeFetch({
        status: 404,
        body: { type: PROBLEM_TYPES.NotFound, title: 'NF', status: 404 },
      }),
      retry: NEVER_RETRY,
    });
    await expect(http.request<unknown>({ method: 'GET', path: '/v1/x' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('429 with Retry-After header maps to RateLimitError carrying the seconds', async () => {
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: fakeFetch({
        status: 429,
        body: { type: PROBLEM_TYPES.RateLimited, title: 'R', status: 429 },
        headers: { 'retry-after': '5' },
      }),
      retry: NEVER_RETRY,
    });
    await expect(http.request<unknown>({ method: 'GET', path: '/v1/x' })).rejects.toMatchObject({
      retryAfterSeconds: 5,
    });
  });

  it('non-2xx with non-Problem body throws TransportError', async () => {
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: fakeFetch({ status: 500, body: '<html>oops</html>' }),
      retry: NEVER_RETRY,
    });
    await expect(http.request<unknown>({ method: 'GET', path: '/v1/x' })).rejects.toBeInstanceOf(
      TransportError,
    );
  });

  it('network failure throws TransportError', async () => {
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: vi.fn(async () => {
        await Promise.resolve();
        throw new Error('ECONNREFUSED');
      }),
      retry: NEVER_RETRY,
    });
    await expect(http.request<unknown>({ method: 'GET', path: '/v1/x' })).rejects.toBeInstanceOf(
      TransportError,
    );
  });

  it('JSON body adds content-type and JSON-stringifies', async () => {
    let captured: RequestInit | undefined;
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: vi.fn(async (_u, init) => {
        captured = init;
        await Promise.resolve();
        return new Response('{"ok":true}', { status: 200 });
      }),
      retry: NEVER_RETRY,
    });
    await http.request<unknown>({ method: 'POST', path: '/v1/x', body: { a: 1 } });
    const headers = captured?.headers as Record<string, string> | undefined;
    expect(headers?.['content-type']).toBe('application/json');
    expect(captured?.body).toBe('{"a":1}');
  });
});
