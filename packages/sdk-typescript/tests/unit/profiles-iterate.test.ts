import { describe, expect, it, vi } from 'vitest';
import { ProfilesResource, type ProfilesListPage } from '../../src/resources/profiles.js';
import type { HttpClient } from '../../src/http.js';
import type { Profile } from '@driftstack/api-types';

function fakeProfile(id: string): Profile {
  return {
    id,
    name: `profile-${id}`,
    archetype: 'mac-iphone-14-safari',
    description: null,
    last_used_at: null,
    created_at: '2026-05-04T00:00:00Z',
    updated_at: '2026-05-04T00:00:00Z',
  };
}

interface RequestOpts {
  method: string;
  path: string;
  query?: Record<string, unknown>;
}

describe('ProfilesResource.iterate', () => {
  it('walks all pages via the cursor helper', async () => {
    const seenQueries: Array<Record<string, unknown>> = [];
    const responses: ProfilesListPage[] = [
      {
        data: [fakeProfile('prof_1'), fakeProfile('prof_2')],
        has_more: true,
        next_cursor: 'cur_2',
      },
      { data: [fakeProfile('prof_3')], has_more: false, next_cursor: null },
    ];
    let i = 0;
    const request = vi.fn((opts: RequestOpts) => {
      seenQueries.push(opts.query ?? {});
      const r = responses[i]!;
      i += 1;
      return Promise.resolve(r);
    });
    const http = { request } as unknown as HttpClient;

    const profiles = new ProfilesResource(http);
    const ids: string[] = [];
    for await (const p of profiles.iterate({ limit: 2 })) {
      ids.push(p.id);
    }
    expect(ids).toEqual(['prof_1', 'prof_2', 'prof_3']);
    expect(seenQueries).toEqual([{ limit: 2 }, { limit: 2, cursor: 'cur_2' }]);
  });
});
