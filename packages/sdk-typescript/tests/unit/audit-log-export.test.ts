// V-462 — AuditLogResource.export unit tests.

import { describe, expect, it, vi } from 'vitest';
import { AuditLogResource, type AuditLogExportResponse } from '../../src/resources/audit-log.js';
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
