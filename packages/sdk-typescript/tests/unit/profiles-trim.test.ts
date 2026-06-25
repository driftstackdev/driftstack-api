// doc-150 §8 — ProfilesResource.trim unit tests. "Clear cache, keep logins":
// POST /v1/profiles/:id/trim. The server always returns 200 with a discriminated
// body; consumers branch on `status`, so these pin the path + that each shape
// flows through verbatim.

import { describe, expect, it, vi } from 'vitest';
import { ProfilesResource, type TrimProfileResponse } from '../../src/resources/profiles.js';
import type { HttpClient } from '../../src/http.js';

interface RequestOpts {
  method: string;
  path: string;
  body?: unknown;
}

describe('ProfilesResource.trim', () => {
  it('POSTs to /v1/profiles/:id/trim with no body (id url-encoded)', async () => {
    const seen: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      seen.push(opts);
      const ok: TrimProfileResponse = {
        status: 'ok',
        size_bytes: 1024,
        bytes_reclaimed: 2048,
      };
      return Promise.resolve(ok);
    });
    const http = { request } as unknown as HttpClient;
    const r = new ProfilesResource(http);
    const out = await r.trim('prof_a b');
    expect(seen[0]).toEqual({ method: 'POST', path: '/v1/profiles/prof_a%20b/trim' });
    // Discriminated 200 body flows through unchanged.
    expect(out).toEqual({ status: 'ok', size_bytes: 1024, bytes_reclaimed: 2048 });
  });

  it('passes through the non-ok discriminated shapes (unavailable / timeout / error)', async () => {
    const shapes: TrimProfileResponse[] = [
      { status: 'unavailable', reason: 'no saved state to trim yet' },
      { status: 'timeout' },
      { status: 'error', reason: 'node reported a failure' },
    ];
    for (const shape of shapes) {
      const request = vi.fn(() => Promise.resolve(shape));
      const http = { request } as unknown as HttpClient;
      const r = new ProfilesResource(http);
      expect(await r.trim('prof_1')).toEqual(shape);
    }
  });
});
