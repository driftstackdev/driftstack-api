// V-463 + V-464 — WebhooksResource.sendTest + .update unit tests.

import { describe, expect, it, vi } from 'vitest';
import { WebhooksResource } from '../../src/resources/webhooks.js';
import type { HttpClient } from '../../src/http.js';
import type { WebhookEndpoint } from '@driftstack/api-types';

interface RequestOpts {
  method: string;
  path: string;
  body?: unknown;
}

const fakeEndpoint = (): WebhookEndpoint => ({
  id: 'whk_abc',
  url: 'https://example.com/hook',
  events: ['session.completed'],
  description: null,
  active: true,
  secret_prefix: 'whsec_aA',
  prev_secret_prefix: null,
  rotation_grace_expires_at: null,
  delivery_counts: { delivered: 0, dlq: 0, failed: 0 },
  created_at: '2026-05-09T18:00:00Z',
  updated_at: '2026-05-09T18:00:00Z',
});

describe('WebhooksResource.sendTest (V-463)', () => {
  it('POSTs an empty body to /v1/webhooks/{id}/test and returns the synthetic delivery receipt', async () => {
    const seen: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      seen.push(opts);
      return Promise.resolve({
        delivery_id: 'wdl_test1',
        event_id: 'evt_test1',
        event_type: 'test.ping' as const,
      });
    });
    const http = { request } as unknown as HttpClient;
    const r = new WebhooksResource(http);
    const out = await r.sendTest('whk_abc');
    expect(seen[0]).toEqual({
      method: 'POST',
      path: '/v1/webhooks/whk_abc/test',
      body: {},
    });
    expect(out.event_type).toBe('test.ping');
    expect(out.delivery_id).toBe('wdl_test1');
  });
});

describe('WebhooksResource.update (V-464)', () => {
  it('PATCHes /v1/webhooks/{id} with the partial body and returns the updated endpoint', async () => {
    const seen: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      seen.push(opts);
      return Promise.resolve({
        ...fakeEndpoint(),
        events: ['session.completed', 'session.failed'],
        description: 'after-update',
      });
    });
    const http = { request } as unknown as HttpClient;
    const r = new WebhooksResource(http);
    const out = await r.update('whk_abc', {
      events: ['session.completed', 'session.failed'],
      description: 'after-update',
    });
    expect(seen[0]).toEqual({
      method: 'PATCH',
      path: '/v1/webhooks/whk_abc',
      body: {
        events: ['session.completed', 'session.failed'],
        description: 'after-update',
      },
    });
    expect(out.events).toEqual(['session.completed', 'session.failed']);
    expect(out.description).toBe('after-update');
  });

  it('forwards `active: false` for soft-disable', async () => {
    const seen: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      seen.push(opts);
      return Promise.resolve({ ...fakeEndpoint(), active: false });
    });
    const http = { request } as unknown as HttpClient;
    const r = new WebhooksResource(http);
    const out = await r.update('whk_abc', { active: false });
    expect(seen[0]?.body).toEqual({ active: false });
    expect(out.active).toBe(false);
  });
});
