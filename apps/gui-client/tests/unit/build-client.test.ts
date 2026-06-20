// Unit coverage for buildClient (lib/client). It gates the GUI's
// connected/not-connected state: a null/empty API key must yield null
// (so views render the "set an API key" surface instead of firing
// opaque 401s), and a present key must construct a real SDK client.
// Previously untested.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { Driftstack } from '@driftstack/sdk';
import { buildClient } from '../../src/lib/client';

const BASE = 'https://api.driftstack.dev';

describe('buildClient (gui-client/lib/client)', () => {
  it('returns null for a null API key (not-connected state)', () => {
    expect(buildClient(null, BASE)).toBeNull();
  });

  it('returns null for an empty-string API key', () => {
    expect(buildClient('', BASE)).toBeNull();
  });

  it('constructs a real Driftstack SDK client when a key is present', () => {
    const client = buildClient('ds_test_key', BASE);
    expect(client).not.toBeNull();
    expect(client).toBeInstanceOf(Driftstack);
  });

  it('builds a client against a localhost base URL too', () => {
    expect(buildClient('ds_test_key', 'http://localhost:3000')).toBeInstanceOf(Driftstack);
  });

  it('treats a whitespace-only key as present (only null/empty are guarded)', () => {
    // Documents the actual guard: `apiKey === null || apiKey.length === 0`.
    // A whitespace key is length>0, so a client is built — the server
    // rejects it with 401, surfaced by the per-view error handling.
    expect(buildClient('   ', BASE)).toBeInstanceOf(Driftstack);
  });
});

// fd417eb6 — central 401 re-auth observer: buildClient layers authFetch (a pure
// pass-through over loggingFetch) that calls onUnauthorized when any request
// returns 401, so an expired/revoked key surfaces ONE central re-auth banner
// instead of scattered per-view 401 copy.
describe('buildClient — central 401 re-auth observer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires onUnauthorized when a request returns 401 (key expired/revoked mid-session)', async () => {
    const onUnauthorized = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      // A well-formed RFC7807 Problem → the SDK raises DriftstackError(401),
      // which is NOT retried (4xx). (A non-Problem 401 body would be retried as
      // a TransportError and fire the observer once per attempt — that's fine,
      // onUnauthorized is idempotent — so assert "called", not an exact count.)
      new Response(
        '{"type":"about:blank","title":"Unauthorized","status":401,"detail":"Invalid or expired API key"}',
        { status: 401, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    const client = buildClient('ds_test_key', BASE, null, onUnauthorized);
    if (client === null) throw new Error('expected a client for a present key');
    // The call itself rejects (401); we only assert the observer side-effect fired.
    await client.account.me().catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalled();
  });

  it('does NOT fire onUnauthorized on a 2xx response', async () => {
    const onUnauthorized = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"tier":"free","profile_cap":3,"profile_count":0}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = buildClient('ds_test_key', BASE, null, onUnauthorized);
    if (client === null) throw new Error('expected a client for a present key');
    await client.account.me().catch(() => undefined);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('a missing key yields no client, so the observer can never fire', () => {
    const onUnauthorized = vi.fn();
    expect(buildClient(null, BASE, null, onUnauthorized)).toBeNull();
    expect(buildClient('', BASE, null, onUnauthorized)).toBeNull();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
