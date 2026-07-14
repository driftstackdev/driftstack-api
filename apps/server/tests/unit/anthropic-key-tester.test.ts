import { describe, expect, it, vi } from 'vitest';

import { makeAnthropicKeyTester } from '../../src/services/anthropic-key-tester.js';

function response(status: number, body = 'upstream-private-body'): Response {
  return new Response(body, { status });
}

describe('makeAnthropicKeyTester', () => {
  it('authenticates with the no-inference model-list endpoint and cancels the body', async () => {
    const upstream = response(200);
    const cancel = vi.spyOn(upstream.body!, 'cancel');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(upstream);
    const testKey = makeAnthropicKeyTester({ fetchImpl });

    await expect(testKey('sk-ant-secret-value')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.body).toBeUndefined();
    const headers = new Headers(init?.headers);
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('x-api-key')).toBe('sk-ant-secret-value');
    expect(typeof url).toBe('string');
    if (typeof url !== 'string') throw new Error('expected a fixed string URL');
    expect(url).not.toContain('sk-ant-secret-value');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('maps HTTP %s to fixed invalid-key guidance', async (status) => {
    const testKey = makeAnthropicKeyTester({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response(status, 'secret upstream body')),
    });

    const result = await testKey('sk-ant-secret-value');
    expect(result).toEqual({
      ok: false,
      outcome: 'invalid',
      reason:
        'Anthropic rejected this API key as invalid or unauthorized. Check or rotate it and try again.',
    });
    expect(JSON.stringify(result)).not.toContain('secret upstream body');
    expect(JSON.stringify(result)).not.toContain('sk-ant-secret-value');
  });

  it.each([401, 429, 503])(
    'cancels an HTTP %s response body without reading it',
    async (status) => {
      const upstream = response(status);
      const cancel = vi.spyOn(upstream.body!, 'cancel');
      const testKey = makeAnthropicKeyTester({
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(upstream),
      });

      await testKey('sk-ant-secret-value');

      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it('maps rate limiting without claiming the key is invalid', async () => {
    const testKey = makeAnthropicKeyTester({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response(429)),
    });

    await expect(testKey('sk-ant-secret-value')).resolves.toEqual({
      ok: false,
      outcome: 'quota_exceeded',
      reason: 'Anthropic rate-limited the connection test. Wait a moment and try again.',
    });
  });

  it.each([400, 404, 500, 503])(
    'maps unexpected HTTP %s without reflecting its body',
    async (status) => {
      const testKey = makeAnthropicKeyTester({
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockResolvedValue(response(status, 'https://internal/?token=secret')),
      });

      const result = await testKey('sk-ant-secret-value');
      expect(result).toEqual({
        ok: false,
        outcome: 'unknown',
        reason:
          'Anthropic could not complete the connection test right now. Wait a moment and try again.',
      });
      expect(JSON.stringify(result)).not.toContain('internal');
      expect(JSON.stringify(result)).not.toContain('secret');
    },
  );

  it('maps native network errors to fixed copy', async () => {
    const testKey = makeAnthropicKeyTester({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.7 token=secret')),
    });

    const result = await testKey('sk-ant-secret-value');
    expect(result).toEqual({
      ok: false,
      outcome: 'unknown',
      reason: 'Could not reach Anthropic to test this key. Check your network and try again.',
    });
    expect(JSON.stringify(result)).not.toContain('10.0.0.7');
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('aborts a stalled request at the configured deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      });
      const testKey = makeAnthropicKeyTester({ fetchImpl, timeoutMs: 25 });
      const pending = testKey('sk-ant-secret-value');

      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toEqual({
        ok: false,
        outcome: 'unknown',
        reason: 'The Anthropic connection test timed out. Check your network and try again.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an empty key without making an outbound request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const testKey = makeAnthropicKeyTester({ fetchImpl });

    const result = await testKey('');
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
