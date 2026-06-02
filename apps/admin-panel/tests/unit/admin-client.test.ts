// Unit tests for the admin-panel shared client data layer + formatters
// (src/lib/admin-client.ts) — Phase-0 of the redesign. The escapeHtml test is
// the load-bearing one: every (re)built page interpolates API values into
// innerHTML through this single escaper, so an XSS regression here would hit
// the whole panel. adminFetch's bearer + base-URL construction is pinned so the
// SSO-bridge auth + prod-fail-fast base URL stay correct as pages migrate onto it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdminApiError,
  adminFetch,
  adminFetchJson,
  adminToken,
  escapeHtml,
  fmtCents,
  fmtInt,
  fmtIso,
} from '../../src/lib/admin-client';

describe('escapeHtml', () => {
  it('escapes all five HTML-significant characters', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('neutralises a script-injection payload (no live markup survives)', () => {
    const out = escapeHtml('<img src=x onerror="alert(1)"> & done');
    expect(out).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; done');
    expect(out).not.toContain('<img src=x');
  });

  it('coerces non-string input to a safe string', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(null)).toBe('null');
  });
});

describe('fmtIso', () => {
  it('renders an ISO timestamp as "YYYY-MM-DD HH:MM:SS UTC"', () => {
    expect(fmtIso('2026-06-02T09:15:30.500Z')).toBe('2026-06-02 09:15:30 UTC');
  });
});

describe('fmtInt', () => {
  it('thousands-separates and rounds', () => {
    expect(fmtInt(12345)).toBe('12,345');
    expect(fmtInt(0)).toBe('0');
    expect(fmtInt(1999.6)).toBe('2,000');
  });
});

describe('fmtCents', () => {
  it('renders integer cents as a currency string (EUR default)', () => {
    expect(fmtCents(19900)).toBe('€199.00');
    expect(fmtCents(0)).toBe('€0.00');
    expect(fmtCents(5)).toBe('€0.05');
  });

  it('honours an explicit currency', () => {
    expect(fmtCents(19900, 'USD')).toBe('$199.00');
  });
});

describe('adminToken', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the SSO-bridge session token from localStorage', () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'tok_abc') });
    expect(adminToken()).toBe('tok_abc');
  });

  it('returns null when storage throws (private mode / blocked)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(adminToken()).toBeNull();
  });
});

describe('adminFetch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.stubEnv('PUBLIC_API_BASE_URL', 'https://api.test');
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'tok_xyz') });
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('calls the resolved base URL + path with the bearer + credentials', async () => {
    await adminFetch('/v1/admin/overview');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/admin/overview');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok_xyz');
    expect(init.credentials).toBe('include');
  });

  it('omits the authorization header when no token is present', async () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null) });
    await adminFetch('/v1/admin/overview');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBeNull();
  });
});

describe('adminFetchJson', () => {
  beforeEach(() => {
    vi.stubEnv('PUBLIC_API_BASE_URL', 'https://api.test');
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'tok') });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('parses + returns the JSON body on 2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accounts: { active: 7 } }), { status: 200 })),
    );
    const body = await adminFetchJson<{ accounts: { active: number } }>('/v1/admin/overview');
    expect(body.accounts.active).toBe(7);
  });

  it('throws AdminApiError carrying status + problem-details title on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ title: 'Forbidden' }), { status: 403 })),
    );
    await expect(adminFetchJson('/v1/admin/overview')).rejects.toMatchObject({
      name: 'AdminApiError',
      status: 403,
      message: 'Forbidden',
    });
  });

  it('falls back to a generic message when the error body has no title', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    await expect(adminFetchJson('/x')).rejects.toBeInstanceOf(AdminApiError);
  });
});
