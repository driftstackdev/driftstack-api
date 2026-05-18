import { describe, expect, it, vi } from 'vitest';
import { SessionsResource, type SessionsListPage } from '../../src/resources/sessions.js';
import type { HttpClient } from '../../src/http.js';
import type { Session } from '@driftstack/api-types';

function fakeSession(id: string): Session {
  return {
    id,
    account_id: 'acc_test',
    api_key_id: 'key_test',
    status: 'ready',
    archetype: 'mac-iphone-14-safari',
    purpose: 'production_customer',
    label: null,
    metadata: null,
    egress_capabilities: null,
    egress_capability_report: null,
    created_at: '2026-05-04T00:00:00Z',
    updated_at: '2026-05-04T00:00:00Z',
    last_state_at: null,
    destroyed_at: null,
  };
}

interface RequestOpts {
  method: string;
  path: string;
  query?: Record<string, unknown>;
}

describe('SessionsResource.iterate', () => {
  it('walks all pages via the cursor helper', async () => {
    const seenQueries: Array<Record<string, unknown>> = [];
    const responses: SessionsListPage[] = [
      {
        data: [fakeSession('sess_1'), fakeSession('sess_2')],
        has_more: true,
        next_cursor: 'cur_2',
      },
      {
        data: [fakeSession('sess_3')],
        has_more: false,
        next_cursor: null,
      },
    ];
    let i = 0;
    const request = vi.fn((opts: RequestOpts) => {
      seenQueries.push(opts.query ?? {});
      const r = responses[i]!;
      i += 1;
      return Promise.resolve(r);
    });
    const http = { request } as unknown as HttpClient;

    const sessions = new SessionsResource(http);
    const ids: string[] = [];
    for await (const s of sessions.iterate({ limit: 2 })) {
      ids.push(s.id);
    }
    expect(ids).toEqual(['sess_1', 'sess_2', 'sess_3']);
    expect(seenQueries).toEqual([{ limit: 2 }, { limit: 2, cursor: 'cur_2' }]);
  });

  it('handles a single-page result', async () => {
    const onlyPage: SessionsListPage = {
      data: [fakeSession('sess_only')],
      has_more: false,
      next_cursor: null,
    };
    const request = vi.fn((_opts: RequestOpts) => Promise.resolve(onlyPage));
    const http = { request } as unknown as HttpClient;

    const sessions = new SessionsResource(http);
    const ids: string[] = [];
    for await (const s of sessions.iterate()) {
      ids.push(s.id);
    }
    expect(ids).toEqual(['sess_only']);
  });
});
