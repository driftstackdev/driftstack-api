// V-462 — AuditLogResource.export unit tests.

import { describe, expect, it, vi } from 'vitest';
import {
  AuditLogResource,
  type AuditLogExportResponse,
  type AuditLogListPage,
} from '../../src/resources/audit-log.js';
import type { HttpClient } from '../../src/http.js';

interface RequestOpts {
  method: string;
  path: string;
  query?: Record<string, string | number | undefined>;
}

const fakeExport = (): AuditLogExportResponse => ({
  generated_at: '2026-05-09T18:00:00Z',
  account_id: 'acc_abc',
  row_count: 2,
  truncated: false,
  data: [
    {
      id: '11111111-1111-1111-1111-111111111111',
      account_id: 'acc_abc',
      actor_type: 'customer',
      actor_account_id: 'acc_abc',
      actor_key_id: null,
      action: 'profile.created',
      target_resource_id: 'profile_xyz',
      payload: null,
      ip_address: null,
      user_agent: null,
      timestamp: '2026-05-09T17:00:00Z',
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      account_id: 'acc_abc',
      actor_type: 'customer',
      actor_account_id: 'acc_abc',
      actor_key_id: null,
      action: 'webhook.created',
      target_resource_id: 'whk_123',
      payload: null,
      ip_address: null,
      user_agent: null,
      timestamp: '2026-05-09T17:30:00Z',
    },
  ],
});

describe('AuditLogResource.export', () => {
  it('GETs /v1/account/audit-log/export with format=json', async () => {
    const seen: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      seen.push(opts);
      return Promise.resolve(fakeExport());
    });
    const http = { request } as unknown as HttpClient;
    const r = new AuditLogResource(http);
    const out = await r.export();

    expect(seen[0]).toEqual({
      method: 'GET',
      path: '/v1/account/audit-log/export',
      query: { format: 'json' },
    });
    expect(out.row_count).toBe(2);
    expect(out.truncated).toBe(false);
    expect(out.data).toHaveLength(2);
    expect(out.data[0]?.action).toBe('profile.created');
  });

  it('surfaces the truncated flag from the server', async () => {
    const truncated: AuditLogExportResponse = {
      ...fakeExport(),
      row_count: 10_000,
      truncated: true,
    };
    const request = vi.fn(() => Promise.resolve(truncated));
    const http = { request } as unknown as HttpClient;
    const r = new AuditLogResource(http);
    const out = await r.export();
    expect(out.row_count).toBe(10_000);
    expect(out.truncated).toBe(true);
  });
});

// The query-building branches below were entirely unexercised: coverage read
// 0 of 14 for this file, so every `...(x !== undefined ? { x } : {})` spread in
// `list` and `iterate` was untested. A refactor that silently dropped `action`
// would have failed nothing — the customer-visible symptom is a filter that
// stops filtering, which no server-side test can see because the parameter
// never leaves the SDK.
const fakePage = (next: string | null): AuditLogListPage => ({
  data: fakeExport().data,
  next_cursor: next,
});

describe('AuditLogResource.list / iterate query building', () => {
  const capture = (pages: AuditLogListPage[]) => {
    const seen: RequestOpts[] = [];
    let i = 0;
    const request = vi.fn((opts: RequestOpts) => {
      seen.push(opts);
      return Promise.resolve(pages[Math.min(i++, pages.length - 1)]!);
    });
    return { seen, http: { request } as unknown as HttpClient };
  };

  it('sends NO query keys when called with no arguments', async () => {
    const { seen, http } = capture([fakePage(null)]);
    await new AuditLogResource(http).list();
    // Not `{ limit: undefined }` — an undefined value would serialise as a
    // literal "undefined" on some clients.
    expect(seen[0]).toEqual({ method: 'GET', path: '/v1/account/audit-log', query: {} });
  });

  it('forwards limit, cursor and action when all are supplied', async () => {
    const { seen, http } = capture([fakePage(null)]);
    await new AuditLogResource(http).list({
      limit: 25,
      cursor: 'cur_1',
      action: 'profile.created',
    });
    expect(seen[0]?.query).toEqual({ limit: 25, cursor: 'cur_1', action: 'profile.created' });
  });

  it('CRITICAL forwards action ALONE without inventing the other keys', async () => {
    // The regression this exists for: a filter that silently stops filtering.
    const { seen, http } = capture([fakePage(null)]);
    await new AuditLogResource(http).list({ action: 'api_key.revoked' });
    expect(seen[0]?.query).toEqual({ action: 'api_key.revoked' });
  });

  it('iterate forwards limit and omits action when only limit is given', async () => {
    // The mirror of the arm below: covers iterate's limit-present and
    // action-absent arms, which the action-only case leaves untouched.
    const { seen, http } = capture([fakePage(null)]);
    for await (const _ of new AuditLogResource(http).iterate({ limit: 5 })) void _;
    expect(seen[0]?.query).toEqual({ limit: 5 });
  });

  it('iterate omits the cursor on the FIRST page and sends the server cursor on the next', async () => {
    const { seen, http } = capture([fakePage('cur_2'), fakePage(null)]);
    const out = [];
    for await (const e of new AuditLogResource(http).iterate({ action: 'profile.created' }))
      out.push(e);
    expect(seen[0]?.query).toEqual({ action: 'profile.created' });
    expect(seen[1]?.query).toEqual({ action: 'profile.created', cursor: 'cur_2' });
    expect(out.length).toBe(4);
  });
});
