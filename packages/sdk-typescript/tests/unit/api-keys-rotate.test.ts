// V-296 — ApiKeysResource.rotate test.

import { describe, expect, it, vi } from 'vitest';
import { ApiKeysResource } from '../../src/resources/api-keys.js';
import type { HttpClient } from '../../src/http.js';

interface RequestOpts {
  method: string;
  path: string;
  body?: unknown;
}

describe('ApiKeysResource.rotate', () => {
  it('POSTs to /v1/api-keys/:id/rotate with the rename body', async () => {
    const calls: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      calls.push(opts);
      return Promise.resolve({
        id: 'key_new',
        name: 'production-2025',
        scopes: ['read', 'write'],
        plaintext: 'ds_live_NEWKEY',
        rotated_from: 'key_old',
        grace_period_ends_at: '2026-05-08T00:00:00Z',
      });
    });
    const http = { request } as unknown as HttpClient;
    const keys = new ApiKeysResource(http);

    const result = await keys.rotate('key_old', { name: 'production-2025' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/v1/api-keys/key_old/rotate');
    expect(calls[0]!.body).toEqual({ name: 'production-2025' });
    expect(result.plaintext).toBe('ds_live_NEWKEY');
    expect(result.rotated_from).toBe('key_old');
    expect(result.grace_period_ends_at).toBe('2026-05-08T00:00:00Z');
  });

  it('POSTs without body fields when no options passed', async () => {
    const calls: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      calls.push(opts);
      return Promise.resolve({
        id: 'key_new',
        plaintext: 'p',
        rotated_from: 'key_old',
        grace_period_ends_at: '2026-05-08T00:00:00Z',
      });
    });
    const http = { request } as unknown as HttpClient;
    const keys = new ApiKeysResource(http);

    await keys.rotate('key_old');
    expect(calls[0]!.body).toEqual({});
  });
});
