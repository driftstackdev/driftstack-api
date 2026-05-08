// V-307 — WebhooksResource.replayDelivery test.

import { describe, expect, it, vi } from 'vitest';
import { WebhooksResource } from '../../src/resources/webhooks.js';
import type { HttpClient } from '../../src/http.js';

interface RequestOpts {
  method: string;
  path: string;
  body?: unknown;
}

describe('WebhooksResource.replayDelivery', () => {
  it('POSTs to /v1/webhook-deliveries/:id/replay with empty body', async () => {
    const calls: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      calls.push(opts);
      return Promise.resolve({
        id: 'wdl_test',
        webhook_id: 'whk_test',
        event_id: 'evt_test',
        event_type: 'session.completed',
        status: 'pending',
        attempts: 0,
        next_attempt_at: '2026-05-08T00:00:00Z',
        last_response_status: null,
        last_response_excerpt: null,
        last_error: null,
        delivered_at: null,
        created_at: '2026-05-08T00:00:00Z',
      });
    });
    const http = { request } as unknown as HttpClient;
    const webhooks = new WebhooksResource(http);

    const result = await webhooks.replayDelivery('wdl_abc');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/v1/webhook-deliveries/wdl_abc/replay');
    expect(calls[0]!.body).toEqual({});
    expect(result.id).toBe('wdl_test');
    expect(result.status).toBe('pending');
  });
});
