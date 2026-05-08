// V-376 — ProfileSnapshotsResource unit tests.

import { describe, expect, it, vi } from 'vitest';
import {
  ProfileSnapshotsResource,
  type ProfileSnapshotsListPage,
} from '../../src/resources/profile-snapshots.js';
import type { HttpClient } from '../../src/http.js';
import type { Profile, ProfileSnapshot } from '@driftstack/api-types';

function fakeSnapshot(id: string, parentId: string | null = 'prof_p'): ProfileSnapshot {
  return {
    id,
    parent_profile_id: parentId,
    label: `label-${id}`,
    description: null,
    parent_archetype: 'iphone16pro_ios18_7_safari26_4',
    parent_name: 'parent',
    captured_at: '2026-05-09T00:00:00Z',
    created_at: '2026-05-09T00:00:00Z',
  };
}

interface RequestOpts {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

describe('ProfileSnapshotsResource', () => {
  it('capture POSTs to the per-profile path with the body verbatim', async () => {
    const seen: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      seen.push(opts);
      return Promise.resolve(fakeSnapshot('psnap_1'));
    });
    const http = { request } as unknown as HttpClient;
    const r = new ProfileSnapshotsResource(http);
    await r.capture('prof_p', { label: 'before-migration', description: 'pre-iOS-18' });
    expect(seen[0]).toEqual({
      method: 'POST',
      path: '/v1/profiles/prof_p/snapshots',
      body: { label: 'before-migration', description: 'pre-iOS-18' },
    });
  });

  it('list calls the cross-account path; listForProfile narrows to per-profile', async () => {
    const seen: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      seen.push(opts);
      return Promise.resolve({ data: [], has_more: false, next_cursor: null });
    });
    const http = { request } as unknown as HttpClient;
    const r = new ProfileSnapshotsResource(http);
    await r.list({ limit: 5 });
    await r.listForProfile('prof_p', { limit: 5, cursor: 'cur_x' });
    expect(seen).toEqual([
      { method: 'GET', path: '/v1/profile-snapshots', query: { limit: 5 } },
      {
        method: 'GET',
        path: '/v1/profiles/prof_p/snapshots',
        query: { limit: 5, cursor: 'cur_x' },
      },
    ]);
  });

  it('iterate walks all pages via the cursor helper', async () => {
    const seenQueries: Array<Record<string, unknown>> = [];
    const responses: ProfileSnapshotsListPage[] = [
      {
        data: [fakeSnapshot('psnap_1'), fakeSnapshot('psnap_2')],
        has_more: true,
        next_cursor: 'cur_2',
      },
      { data: [fakeSnapshot('psnap_3')], has_more: false, next_cursor: null },
    ];
    let i = 0;
    const request = vi.fn((opts: RequestOpts) => {
      seenQueries.push(opts.query ?? {});
      const resp = responses[i]!;
      i += 1;
      return Promise.resolve(resp);
    });
    const http = { request } as unknown as HttpClient;
    const r = new ProfileSnapshotsResource(http);
    const ids: string[] = [];
    for await (const s of r.iterate({ limit: 2 })) {
      ids.push(s.id);
    }
    expect(ids).toEqual(['psnap_1', 'psnap_2', 'psnap_3']);
    expect(seenQueries).toEqual([{ limit: 2 }, { limit: 2, cursor: 'cur_2' }]);
  });

  it('restore POSTs the new name and returns a Profile', async () => {
    const seen: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      seen.push(opts);
      return Promise.resolve({
        id: 'prof_new',
        name: 'restored-baseline',
        archetype: 'iphone16pro_ios18_7_safari26_4',
        description: null,
        last_used_at: null,
        created_at: '2026-05-09T00:00:00Z',
        updated_at: '2026-05-09T00:00:00Z',
      } as Profile);
    });
    const http = { request } as unknown as HttpClient;
    const r = new ProfileSnapshotsResource(http);
    const out = await r.restore('psnap_1', { name: 'restored-baseline' });
    expect(out.id).toBe('prof_new');
    expect(seen[0]).toEqual({
      method: 'POST',
      path: '/v1/profile-snapshots/psnap_1/restore',
      body: { name: 'restored-baseline' },
    });
  });

  it('delete sends DELETE to the snapshot path', async () => {
    const seen: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      seen.push(opts);
      return Promise.resolve(undefined);
    });
    const http = { request } as unknown as HttpClient;
    const r = new ProfileSnapshotsResource(http);
    await r.delete('psnap_1');
    expect(seen[0]).toEqual({ method: 'DELETE', path: '/v1/profile-snapshots/psnap_1' });
  });
});
