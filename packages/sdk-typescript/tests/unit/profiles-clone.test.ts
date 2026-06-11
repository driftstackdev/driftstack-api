// V-379 — ProfilesResource.clone unit tests.

import { describe, expect, it, vi } from 'vitest';
import { ProfilesResource } from '../../src/resources/profiles.js';
import type { HttpClient } from '../../src/http.js';
import type { Profile } from '@driftstack/api-types';

interface RequestOpts {
  method: string;
  path: string;
  body?: unknown;
}

const fakeProfile = (id: string): Profile => ({
  id,
  name: `profile-${id}`,
  archetype: 'iphone17_ios18_7_safari26_4',
  description: null,
  last_used_at: null,
  created_at: '2026-05-09T00:00:00Z',
  updated_at: '2026-05-09T00:00:00Z',
});

describe('ProfilesResource.clone', () => {
  it('POSTs the empty body when no name is supplied (server auto-derives)', async () => {
    const seen: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      seen.push(opts);
      return Promise.resolve(fakeProfile('prof_clone'));
    });
    const http = { request } as unknown as HttpClient;
    const r = new ProfilesResource(http);
    const out = await r.clone('prof_src');
    expect(out.id).toBe('prof_clone');
    expect(seen[0]).toEqual({
      method: 'POST',
      path: '/v1/profiles/prof_src/clone',
      body: {},
    });
  });

  it('forwards an explicit name to the server', async () => {
    const seen: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      seen.push(opts);
      return Promise.resolve(fakeProfile('prof_x'));
    });
    const http = { request } as unknown as HttpClient;
    const r = new ProfilesResource(http);
    await r.clone('prof_src', { name: 'my-explicit-clone' });
    expect(seen[0]?.body).toEqual({ name: 'my-explicit-clone' });
  });
});
