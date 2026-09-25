// Owner item 8, 2026-09-24. The developer log showed a burst at 11:58:45Z:
// `GET /v1/sessions` and `GET /v1/profiles?limit=50` → "network failure:
// TypeError: Failed to fetch", then "[ui] Couldn't reach https://api.driftstack.dev.
// Check the URL, connection, firewall, or VPN, then try again." A production
// deploy restarted the API at 11:58:53Z.
//
// What the app did (measured on HEAD, arm 1's negative control): the SDK spent
// its three retries inside ~1.4 s (full-jitter 0.2/0.4/0.8 s), every try was
// logged as its own ERROR, and the read failed — so the view put up the
// firewall/VPN banner for a restart of a few seconds.
//
// The contract now: a read rides the restart out quietly (backoff, up to
// RIDE_OUT_BUDGET_MS from when the server stopped answering), the log gets one
// calm line each way, and only an outage that LASTS fails the read and logs
// ONE error. Writes are never repeated by this layer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiReachability,
  buildClient,
  RIDE_OUT_BUDGET_MS,
  resetApiReachabilityForTests,
} from '../../src/lib/client';
import { clearLogEntries, getLogEntries } from '../../src/lib/log-buffer';

const BASE = 'https://api.example.com';

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const EMPTY_PAGE = { data: [], has_more: false, next_cursor: null };

function apiLines(): Array<{ level: string; text: string }> {
  return getLogEntries()
    .filter((e) => e.text.startsWith('[api]'))
    .map((e) => ({ level: e.level, text: e.text }));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date('2026-09-24T11:58:45Z'));
  resetApiReachabilityForTests();
  clearLogEntries();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function clientOrThrow(): NonNullable<ReturnType<typeof buildClient>> {
  const client = buildClient('ds_live_test_key', BASE);
  if (client === null) throw new Error('expected a client');
  return client;
}

describe('a server restart is ridden out without an error spray', () => {
  it('CRITICAL a read that fails for the 8 s of a restart still succeeds, with no ERROR line and no failure for the view', async () => {
    const restartEndsAt = Date.now() + 8_000;
    const fetchMock = vi.fn(() =>
      Date.now() < restartEndsAt
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(ok(EMPTY_PAGE)),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = clientOrThrow();
    const settled = client.sessions.list().then(
      (page) => ({ ok: true as const, page }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await settled;

    expect(result.ok, 'the read failed — the view would show the firewall/VPN banner').toBe(true);
    const lines = apiLines();
    expect(lines.filter((l) => l.level === 'error')).toEqual([]);
    // ONE calm line when it stopped answering, ONE when it came back.
    expect(lines).toHaveLength(2);
    expect(lines[0]?.level).toBe('info');
    expect(lines[0]?.text).toMatch(/api\.example\.com is not answering/);
    expect(lines[1]?.level).toBe('info');
    expect(lines[1]?.text).toMatch(/answering again after \d+\.\ds/);
    expect(apiReachability(BASE).state).toBe('answering');
    // It retried with backoff, not in a tight loop.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it('CRITICAL an outage that lasts fails the read after the budget, with ONE error line, not one per try', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('fetch', fetchMock);

    const client = clientOrThrow();
    let settledAt: number | null = null;
    const started = Date.now();
    const settled = client.sessions.list().then(
      () => 'resolved',
      () => {
        settledAt = Date.now();
        return 'rejected';
      },
    );
    await vi.advanceTimersByTimeAsync(RIDE_OUT_BUDGET_MS + 15_000);
    expect(await settled).toBe('rejected');
    // Not before the budget: a short outage must never reach the view.
    expect((settledAt ?? 0) - started).toBeGreaterThanOrEqual(RIDE_OUT_BUDGET_MS);

    const errors = apiLines().filter((l) => l.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.text).toMatch(/has not answered for \d+s/);
    expect(apiReachability(BASE).state).toBe('down');
  });

  it('while the server is down, further reads fail at once rather than each waiting out a budget', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const client = clientOrThrow();
    const first = client.sessions.list().catch(() => 'rejected');
    await vi.advanceTimersByTimeAsync(RIDE_OUT_BUDGET_MS + 15_000);
    expect(await first).toBe('rejected');

    const started = Date.now();
    let settledAt: number | null = null;
    const second = client.sessions.list().catch(() => {
      settledAt = Date.now();
      return 'rejected';
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await second).toBe('rejected');
    // Only the SDK's own sub-second retries, not another 20 s wait.
    expect((settledAt ?? Number.POSITIVE_INFINITY) - started).toBeLessThan(3_000);
    expect(apiLines().filter((l) => l.level === 'error')).toHaveLength(1);
  });

  it('a gateway 502 during the restart is ridden out the same way', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        calls += 1;
        return Promise.resolve(
          calls <= 2
            ? new Response('<html>502 Bad Gateway</html>', {
                status: 502,
                headers: { 'content-type': 'text/html' },
              })
            : ok(EMPTY_PAGE),
        );
      }),
    );
    const client = clientOrThrow();
    const settled = client.sessions.list().then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await settled).toBe('resolved');
    expect(apiLines().filter((l) => l.level === 'error')).toEqual([]);
  });

  it("the API's own 503 answer is not a restart: it reaches the caller without a ride-out", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'https://docs.driftstack.dev/errors/driver-not-integrated',
            title: 'Driver not integrated',
            status: 503,
            detail: 'not wired',
          }),
          { status: 503, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = clientOrThrow();
    let settledAt: number | null = null;
    const started = Date.now();
    const settled = client.sessions.list().catch(() => {
      settledAt = Date.now();
      return 'rejected';
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await settled).toBe('rejected');
    expect((settledAt ?? Number.POSITIVE_INFINITY) - started).toBeLessThan(3_000);
    expect(apiLines().some((l) => /not answering/.test(l.text))).toBe(false);
    expect(apiReachability(BASE).state).toBe('answering');
  });

  it('CRITICAL a write is never repeated by this layer — it may already have reached the server', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('fetch', fetchMock);
    const client = clientOrThrow();
    const settled = client.profiles.create({ name: 'x' }).catch(() => 'rejected');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await settled).toBe('rejected');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const warns = apiLines().filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.text).toMatch(/POST \/v1\/profiles → network failure.*not retried/);
  });

  it('a 4xx the caller handles is a warning, not an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ type: 'about:blank', title: 'Not found', status: 404, detail: 'x' }),
            {
              status: 404,
              statusText: 'Not Found',
              headers: { 'content-type': 'application/problem+json' },
            },
          ),
        ),
      ),
    );
    const client = clientOrThrow();
    await client.sessions.list().catch(() => undefined);
    const lines = apiLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('warn');
    expect(lines[0]?.text).toContain('→ 404 Not Found');
  });
});
