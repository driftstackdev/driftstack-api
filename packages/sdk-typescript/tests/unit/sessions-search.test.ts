import { describe, expect, it, vi } from 'vitest';
import type { SearchResponse } from '@driftstack/api-types';
import type { HttpClient } from '../../src/http.js';
import { SessionsResource } from '../../src/resources/sessions.js';

type RequestOptions = {
  method: string;
  path: string;
  body?: unknown;
};

describe('SessionsResource.search', () => {
  it('posts to the encoded path and retains the complete non-submitting branch', async () => {
    const response = {
      submitted: false,
      query_truncated: false,
      results_visible: false,
      duration_ms: 8_420,
    } satisfies SearchResponse;
    const request = vi.fn((_options: RequestOptions) => Promise.resolve(response));
    const sessions = new SessionsResource({ request } as unknown as HttpClient);
    const body = { query: 'wireless headphones', submit: false };

    const result = await sessions.search('ses/with space', body);

    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/sessions/ses%2Fwith%20space/search',
      body,
    });
    expect(result).toEqual(response);
    if (!result.query_truncated) {
      expect(result.submitted).toBe(false);
      expect(result.results_visible).toBe(false);
    }
  });

  it('retains the exact safe zero-submit refusal branch', async () => {
    const response = {
      submitted: false,
      query_truncated: true,
      duration_ms: 600_000,
    } satisfies SearchResponse;
    const request = vi.fn((_options: RequestOptions) => Promise.resolve(response));
    const sessions = new SessionsResource({ request } as unknown as HttpClient);

    const result = await sessions.search('ses_123', { query: 'wireless headphones' });

    expect(result).toEqual(response);
    if (result.query_truncated) {
      expect(result.submitted).toBe(false);
      expect(result).not.toHaveProperty('results_visible');
    }
  });

  it.each([
    { submitted: true, query_truncated: true, duration_ms: 1 },
    {
      submitted: false,
      query_truncated: true,
      results_visible: false,
      duration_ms: 1,
    },
    {
      submitted: true,
      query_truncated: false,
      results_visible: null,
      duration_ms: 1,
    },
    { submitted: true, query_truncated: false, duration_ms: 600_001 },
    { submitted: true, query_truncated: false, duration_ms: 1, unexpected: true },
    { query_truncated: false, duration_ms: 1 },
  ])('rejects a malformed successful response as a transport error: %#', async (response) => {
    const request = vi.fn((_options: RequestOptions) => Promise.resolve(response));
    const sessions = new SessionsResource({ request } as unknown as HttpClient);

    await expect(
      sessions.search('ses_123', { query: 'wireless headphones' }),
    ).rejects.toMatchObject({
      name: 'TransportError',
      kind: 'transport',
      status: 200,
      message: 'invalid session search response body',
    });
  });
});
