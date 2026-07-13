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

  it('preserves a base-URL path prefix (self-hosted behind a path-prefixing gateway)', async () => {
    let capturedUrl: string | undefined;
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'https://gw.internal/driftstack',
      fetch: vi.fn(async (url) => {
        capturedUrl = String(url);
        await Promise.resolve();
        return new Response('{}', { status: 200 });
      }),
      retry: NEVER_RETRY,
    });
    await http.request<unknown>({ method: 'GET', path: '/v1/x' });
    // Must keep `/driftstack` — `new URL('/v1/x', base)` would have dropped it.
    expect(capturedUrl).toBe('https://gw.internal/driftstack/v1/x');
  });

  it('host-only base URL joins cleanly (no double slash)', async () => {
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
    await http.request<unknown>({ method: 'GET', path: '/v1/x' });
    expect(capturedUrl).toBe('http://api.test/v1/x');
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

  it.each([200, 500])(
    'rejects an oversized declared response body before reading it (status %i)',
    async (status) => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      const http = new HttpClient({
        apiKey: 'ds_live_test',
        baseUrl: 'http://api.test',
        fetch: vi.fn(() =>
          Promise.resolve(
            new Response(body, {
              status,
              headers: { 'content-length': String(8 * 1024 * 1024 + 1) },
            }),
          ),
        ),
        retry: NEVER_RETRY,
      });

      const err = await http
        .request<unknown>({ method: 'GET', path: '/v1/x' })
        .catch((caught: unknown) => caught);

      expect(err).toBeInstanceOf(TransportError);
      expect(err).toMatchObject({
        message: 'response body exceeds 8388608-byte limit',
        status,
      });
      expect(cancelled).toBe(true);
    },
  );

  it('cancels an oversized chunked response at the raw-byte ceiling', async () => {
    let chunksPulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: vi.fn(() => Promise.resolve(new Response(body, { status: 200 }))),
      retry: NEVER_RETRY,
    });

    await expect(http.request<unknown>({ method: 'GET', path: '/v1/x' })).rejects.toMatchObject({
      message: 'response body exceeds 8388608-byte limit',
      status: 200,
    });
    expect(chunksPulled).toBeLessThanOrEqual(10);
    expect(cancelled).toBe(true);
  });

  it('keeps the request timeout armed while the response body is stalled', async () => {
    let aborted = false;
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      timeoutMs: 25,
      fetch: vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const fail = (): void => {
              aborted = true;
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            };
            if (signal?.aborted) fail();
            else signal?.addEventListener('abort', fail, { once: true });
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }),
      retry: NEVER_RETRY,
    });

    await expect(http.request<unknown>({ method: 'GET', path: '/v1/x' })).rejects.toMatchObject({
      name: 'TransportError',
      message: 'request timed out',
      status: 200,
    });
    expect(aborted).toBe(true);
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

describe('HttpClient.requestEventStream', () => {
  it('negotiates SSE, ignores heartbeat comments, and returns the one terminal JSON body', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const stream = [
      ': stream open',
      '',
      ': heartbeat 2026-07-13T21:00:00.000Z',
      '',
      'event: response',
      'data: {"status":200,"body":{"kind":"clarify","clarifying_question":"Which page?"}}',
      '',
    ].join('\n');
    const http = new HttpClient({
      apiKey: 'ds_live_stream',
      baseUrl: 'https://gw.internal/driftstack',
      fetch: vi.fn((url, init) => {
        captured = { url: String(url), init };
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          }),
        );
      }),
      retry: { maxAttempts: 5 },
    });

    const result = await http.requestEventStream<{ kind: string; clarifying_question: string }>({
      method: 'POST',
      path: '/v1/agent-sessions/agt_1/message',
      body: { user_message: 'help' },
      timeoutMs: 90_000,
      headers: { accept: 'application/json' },
    });

    expect(result).toEqual({ kind: 'clarify', clarifying_question: 'Which page?' });
    expect(captured.url).toBe('https://gw.internal/driftstack/v1/agent-sessions/agt_1/message');
    expect(captured.init?.body).toBe('{"user_message":"help"}');
    expect(captured.init?.headers).toMatchObject({
      authorization: 'Bearer ds_live_stream',
      accept: 'text/event-stream',
      'content-type': 'application/json',
    });
    expect(captured.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps a terminal streamed Problem through the existing typed error taxonomy', async () => {
    const problem = {
      type: PROBLEM_TYPES.RateLimited,
      title: 'Too Many Requests',
      status: 429,
      retry_after_seconds: 7,
    };
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: fakeFetch({
        status: 200,
        body: `event: response\ndata: ${JSON.stringify({ status: 429, body: problem })}\n\n`,
        headers: { 'content-type': 'text/event-stream' },
      }),
      retry: NEVER_RETRY,
    });

    await expect(
      http.requestEventStream({ method: 'POST', path: '/v1/x', timeoutMs: 1000 }),
    ).rejects.toMatchObject({ name: 'RateLimitError', retryAfterSeconds: 7 });
  });

  it('falls back to ordinary JSON success and Problem responses from older servers', async () => {
    const legacySuccess = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: fakeFetch({
        status: 200,
        body: '{"kind":"clarify","clarifying_question":"Legacy server"}',
        headers: { 'content-type': 'application/json' },
      }),
      retry: NEVER_RETRY,
    });
    await expect(
      legacySuccess.requestEventStream({ method: 'POST', path: '/v1/x', timeoutMs: 1000 }),
    ).resolves.toEqual({ kind: 'clarify', clarifying_question: 'Legacy server' });

    const legacyProblem = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: fakeFetch({
        status: 429,
        body: JSON.stringify({
          type: PROBLEM_TYPES.RateLimited,
          title: 'Too Many Requests',
          status: 429,
          retry_after_seconds: 11,
        }),
        headers: { 'content-type': 'application/problem+json', 'retry-after': '11' },
      }),
      retry: NEVER_RETRY,
    });
    await expect(
      legacyProblem.requestEventStream({ method: 'POST', path: '/v1/x', timeoutMs: 1000 }),
    ).rejects.toMatchObject({ name: 'RateLimitError', retryAfterSeconds: 11 });
  });

  it.each([
    [': only heartbeats\n\n', 'without a terminal response'],
    [
      'event: response\ndata: {"status":200,"body":{}}\n\nevent: response\ndata: {"status":200,"body":{}}\n\n',
      'multiple terminal responses',
    ],
    ['event: response\ndata: {"status":"200","body":{}}\n\n', 'invalid response envelope'],
  ])('fails closed on malformed terminal stream %#', async (body, message) => {
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: fakeFetch({
        status: 200,
        body,
        headers: { 'content-type': 'text/event-stream' },
      }),
      retry: NEVER_RETRY,
    });
    await expect(
      http.requestEventStream({ method: 'POST', path: '/v1/x', timeoutMs: 1000 }),
    ).rejects.toMatchObject({ name: 'TransportError', message: expect.stringContaining(message) });
  });

  it('keeps the absolute timeout armed through a stalled event-stream body', async () => {
    const http = new HttpClient({
      apiKey: 'ds_live_test',
      baseUrl: 'http://api.test',
      fetch: vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const fail = (): void =>
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (init?.signal?.aborted) fail();
            else init?.signal?.addEventListener('abort', fail, { once: true });
          },
        });
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
      }),
      retry: NEVER_RETRY,
    });

    await expect(
      http.requestEventStream({ method: 'POST', path: '/v1/x', timeoutMs: 25 }),
    ).rejects.toMatchObject({ name: 'TransportError', message: 'request timed out' });
  });
});

// Security invariant: a thrown error must NEVER carry the API key. Errors are
// built from the response (problem body / status) or the transport failure
// message — never from the request init (which holds `authorization: Bearer
// <apiKey>`). If a refactor ever stashed the request/headers on an error, the
// customer's key would leak into THEIR logs / Sentry. These guard both error
// paths (problem response + network failure) by asserting the key string is
// absent from the message, String(err), and the JSON-serialized error.
describe('HttpClient — API key never leaks into thrown errors', () => {
  const SECRET = 'ds_live_DO_NOT_LEAK_abc123';

  function assertNoKey(err: unknown): void {
    expect(err).toBeInstanceOf(Error);
    const e = err as Error;
    expect(e.message).not.toContain(SECRET);
    expect(String(e)).not.toContain(SECRET);
    expect(JSON.stringify(e)).not.toContain(SECRET);
    // Walk the cause chain too — TransportError keeps the underlying fetch
    // error as `cause`; it must not surface the key either.
    let cause: unknown = (e as { cause?: unknown }).cause;
    let depth = 0;
    while (cause !== undefined && cause !== null && depth < 5) {
      if (cause instanceof Error) expect(cause.message).not.toContain(SECRET);
      expect(JSON.stringify(cause)).not.toContain(SECRET);
      cause = (cause as { cause?: unknown }).cause;
      depth += 1;
    }
  }

  it('does not leak the key on a problem (4xx) response', async () => {
    const http = new HttpClient({
      apiKey: SECRET,
      baseUrl: 'http://api.test',
      fetch: fakeFetch({
        status: 404,
        body: { type: PROBLEM_TYPES.NotFound, title: 'Not Found', status: 404 },
      }),
      retry: NEVER_RETRY,
    });
    await expect(http.request({ method: 'GET', path: '/v1/x' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const err = await http.request({ method: 'GET', path: '/v1/x' }).catch((e: unknown) => e);
    assertNoKey(err);
  });

  it('does not leak the key on a network failure', async () => {
    const http = new HttpClient({
      apiKey: SECRET,
      baseUrl: 'http://api.test',
      fetch: vi.fn(async () => {
        await Promise.resolve();
        throw new Error('network down');
      }),
      retry: NEVER_RETRY,
    });
    const err = await http.request({ method: 'GET', path: '/v1/x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    assertNoKey(err);
  });

  it('does not leak the key on a non-problem 5xx body', async () => {
    const http = new HttpClient({
      apiKey: SECRET,
      baseUrl: 'http://api.test',
      fetch: fakeFetch({ status: 500, body: '<html>internal error</html>' }),
      retry: NEVER_RETRY,
    });
    const err = await http.request({ method: 'GET', path: '/v1/x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    assertNoKey(err);
  });
});

// Retry SAFETY gate: only idempotent methods (or a POST/PATCH carrying an
// Idempotency-Key) are auto-retried. A keyless create must be sent exactly
// once — a transient 5xx / network blip might already have been applied
// server-side, so retrying would double-submit it.
describe('HttpClient — retry-safety gate', () => {
  // Fast retry config: 2 retries, no real sleep.
  const FAST_RETRY = { maxAttempts: 2, sleep: async () => {} } as const;

  /** A fetch that always returns `status` (non-JSON body → TransportError, retryable) and counts attempts. */
  function countingFetch(status: number): { fetch: typeof fetch; calls: () => number } {
    let n = 0;
    const f: typeof fetch = async () => {
      n += 1;
      await Promise.resolve();
      return new Response('boom', { status });
    };
    return { fetch: f, calls: () => n };
  }

  it('retries an idempotent GET on a transient 5xx (1 + maxAttempts)', async () => {
    const cf = countingFetch(503);
    const http = new HttpClient({
      apiKey: 'k',
      baseUrl: 'http://api.test',
      fetch: cf.fetch,
      retry: FAST_RETRY,
    });
    await expect(http.request({ method: 'GET', path: '/v1/x' })).rejects.toBeInstanceOf(
      TransportError,
    );
    expect(cf.calls()).toBe(3);
  });

  it('does NOT retry a keyless POST (avoids double-submitting a create)', async () => {
    const cf = countingFetch(503);
    const http = new HttpClient({
      apiKey: 'k',
      baseUrl: 'http://api.test',
      fetch: cf.fetch,
      retry: FAST_RETRY,
    });
    await expect(
      http.request({ method: 'POST', path: '/v1/x', body: { a: 1 } }),
    ).rejects.toBeInstanceOf(TransportError);
    expect(cf.calls()).toBe(1);
  });

  it('retries a POST that carries an Idempotency-Key (server replays on the key)', async () => {
    const cf = countingFetch(503);
    const http = new HttpClient({
      apiKey: 'k',
      baseUrl: 'http://api.test',
      fetch: cf.fetch,
      retry: FAST_RETRY,
    });
    await expect(
      http.request({
        method: 'POST',
        path: '/v1/x',
        body: { a: 1 },
        headers: { 'Idempotency-Key': 'k-1' },
      }),
    ).rejects.toBeInstanceOf(TransportError);
    expect(cf.calls()).toBe(3);
  });

  it('matches the Idempotency-Key header case-insensitively', async () => {
    const cf = countingFetch(503);
    const http = new HttpClient({
      apiKey: 'k',
      baseUrl: 'http://api.test',
      fetch: cf.fetch,
      retry: FAST_RETRY,
    });
    await expect(
      http.request({ method: 'POST', path: '/v1/x', headers: { 'idempotency-key': 'k-1' } }),
    ).rejects.toBeInstanceOf(TransportError);
    expect(cf.calls()).toBe(3);
  });
});
