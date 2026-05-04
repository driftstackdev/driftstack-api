import { describe, expect, it, vi } from 'vitest';
import { WebhooksResource, type WebhookDeliveryListPage } from '../../src/resources/webhooks.js';
import type { HttpClient } from '../../src/http.js';
import type { WebhookDelivery } from '@driftstack/api-types';

function fakeDelivery(
  id: string,
  status: WebhookDelivery['status'] = 'delivered',
): WebhookDelivery {
  return {
    id,
    webhook_id: 'wh_test',
    event_id: '00000000-0000-0000-0000-000000000000',
    event_type: 'session.completed',
    status,
    attempts: 1,
    next_attempt_at: '2026-05-04T00:00:00Z',
    last_response_status: 200,
    last_response_excerpt: null,
    last_error: null,
    delivered_at: '2026-05-04T00:00:00Z',
    created_at: '2026-05-04T00:00:00Z',
  };
}

interface RequestOpts {
  method: string;
  path: string;
  query?: Record<string, unknown>;
}

describe('WebhooksResource.iterateDeliveries', () => {
  it('walks all pages and threads the status filter', async () => {
    const seenQueries: Array<Record<string, unknown>> = [];
    const seenPaths: string[] = [];
    const responses: WebhookDeliveryListPage[] = [
      {
        data: [fakeDelivery('del_1', 'dlq'), fakeDelivery('del_2', 'dlq')],
        has_more: true,
        next_cursor: 'cur_2',
      },
      { data: [fakeDelivery('del_3', 'dlq')], has_more: false, next_cursor: null },
    ];
    let i = 0;
    const request = vi.fn((opts: RequestOpts) => {
      seenPaths.push(opts.path);
      seenQueries.push(opts.query ?? {});
      const r = responses[i]!;
      i += 1;
      return Promise.resolve(r);
    });
    const http = { request } as unknown as HttpClient;

    const webhooks = new WebhooksResource(http);
    const ids: string[] = [];
    for await (const d of webhooks.iterateDeliveries('wh_abc', { limit: 2, status: 'dlq' })) {
      ids.push(d.id);
    }
    expect(ids).toEqual(['del_1', 'del_2', 'del_3']);
    expect(seenPaths).toEqual(['/v1/webhooks/wh_abc/deliveries', '/v1/webhooks/wh_abc/deliveries']);
    // status threaded through every page; cursor only present on subsequent pages.
    expect(seenQueries).toEqual([
      { limit: 2, status: 'dlq' },
      { limit: 2, status: 'dlq', cursor: 'cur_2' },
    ]);
  });
});
