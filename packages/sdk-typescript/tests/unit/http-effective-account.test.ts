// V-326c/V-330 — effectiveAccount client option sends X-Driftstack-Account
// on every request (and absence sends nothing).

import { describe, expect, it, vi } from 'vitest';
import { Driftstack } from '../../src/client.js';

function capture(): { headers: () => Record<string, string>; fetch: typeof fetch } {
  let captured: Record<string, string> = {};
  const f = vi.fn((_url: unknown, init?: RequestInit) => {
    captured = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    return Promise.resolve(
      new Response(JSON.stringify({ data: [], has_more: false, next_cursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { headers: () => captured, fetch: f };
}

describe('effectiveAccount option', () => {
  it('sends x-driftstack-account on every request when set', async () => {
    const cap = capture();
    const client = new Driftstack({
      apiKey: 'ds_test_x',
      baseUrl: 'https://api.test',
      effectiveAccount: 'acc_00000000-0000-4000-8000-000000000001',
      fetch: cap.fetch,
    });
    await client.profiles.list();
    expect(cap.headers()['x-driftstack-account']).toBe('acc_00000000-0000-4000-8000-000000000001');
  });

  it('omits the header entirely when not set', async () => {
    const cap = capture();
    const client = new Driftstack({
      apiKey: 'ds_test_x',
      baseUrl: 'https://api.test',
      fetch: cap.fetch,
    });
    await client.profiles.list();
    expect('x-driftstack-account' in cap.headers()).toBe(false);
  });
});
