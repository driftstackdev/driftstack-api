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
  consecutive_failures: 0,
  last_success_at: null,
  last_failure_at: null,
  disabled_at: null,
  delivery_counts: { delivered: 0, failed: 0, dlq: 0 },
  created_at: '2026-05-09T18:00:00Z',
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

  // ⛔ rotateSecret shipped with NO test in ANY of the three SDKs (V-1978). It is
  // the one operation here that mints a credential, and its response is the ONLY
  // time the plaintext secret is ever returned — so a client that dropped a field
  // would lose a secret the server will not show again.

  it('CRITICAL rotateSecret POSTs an empty body to /v1/webhooks/{id}/rotate-secret', async () => {
    const calls: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      calls.push(opts);
      return Promise.resolve({
        id: 'whk_abc',
        secret: 'whsec_freshsecretvalue',
        secret_prefix: 'whsec_fr',
        prev_secret_prefix: 'whsec_aA',
        grace_expires_at: '2026-05-10T18:00:00Z',
      });
    });
    const webhooks = new WebhooksResource({ request } as unknown as HttpClient);
    await webhooks.rotateSecret('whk_abc');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/v1/webhooks/whk_abc/rotate-secret');
    // An empty object, not `undefined`: the route is a POST and some proxies
    // treat a bodyless POST differently from one carrying `{}`.
    expect(calls[0]!.body).toEqual({});
  });

  it('CRITICAL rotateSecret returns the plaintext secret and BOTH prefixes verbatim. The plaintext is shown exactly once, so a dropped field is an unrecoverable loss, and prev_secret_prefix plus grace_expires_at are what a caller needs to keep verifying old deliveries during the dual-sign window', async () => {
    const reply = {
      id: 'whk_abc',
      secret: 'whsec_freshsecretvalue',
      secret_prefix: 'whsec_fr',
      prev_secret_prefix: 'whsec_aA',
      grace_expires_at: '2026-05-10T18:00:00Z',
    };
    const request = vi.fn(() => Promise.resolve(reply));
    const webhooks = new WebhooksResource({ request } as unknown as HttpClient);
    const out = await webhooks.rotateSecret('whk_abc');
    expect(out).toEqual(reply);
  });

  it('rotateSecret URL-encodes the webhook id, so a caller-supplied id cannot alter the path', async () => {
    const calls: RequestOpts[] = [];
    const request = vi.fn((opts: RequestOpts) => {
      calls.push(opts);
      return Promise.resolve({
        id: 'x',
        secret: 's',
        secret_prefix: 'p',
        prev_secret_prefix: 'q',
        grace_expires_at: '2026-05-10T18:00:00Z',
      });
    });
    const webhooks = new WebhooksResource({ request } as unknown as HttpClient);
    await webhooks.rotateSecret('whk/with space');
    expect(calls[0]!.path).toBe('/v1/webhooks/whk%2Fwith%20space/rotate-secret');
  });
});
