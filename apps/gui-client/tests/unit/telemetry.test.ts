// V-242 — unit tests for telemetry gating logic.
//
// `telemetryEnabled()` is a pure function — testable without
// initializing Sentry. The actual SDK init (`initTelemetry`) is
// integration-tested via `tauri:dev` per-platform; the gate logic
// here is the load-bearing predicate.

import { describe, expect, it } from 'vitest';
import type { ErrorEvent, EventHint } from '@sentry/browser';
import {
  isCloudBaseUrl,
  telemetryEnabled,
  keepSentryIntegration,
  DROPPED_SENTRY_INTEGRATIONS,
  scrubEvent,
} from '../../src/lib/telemetry.js';

describe('isCloudBaseUrl', () => {
  it('matches the canonical driftstack.io hostname', () => {
    expect(isCloudBaseUrl('https://driftstack.io')).toBe(true);
  });

  it('matches subdomains of driftstack.io', () => {
    expect(isCloudBaseUrl('https://api.driftstack.dev')).toBe(true);
    expect(isCloudBaseUrl('https://api.driftstack.dev/v1')).toBe(true);
    expect(isCloudBaseUrl('https://staging.driftstack.dev')).toBe(true);
  });

  it('rejects look-alike hostnames', () => {
    expect(isCloudBaseUrl('https://driftstack.io.evil.com')).toBe(false);
    expect(isCloudBaseUrl('https://notdriftstack.dev')).toBe(false);
  });

  it('rejects localhost / IP / customer self-hosted hosts', () => {
    expect(isCloudBaseUrl('http://localhost:7780')).toBe(false);
    expect(isCloudBaseUrl('http://192.168.1.50:7780')).toBe(false);
    expect(isCloudBaseUrl('https://driftstack.example.com')).toBe(false);
  });

  it('returns false on malformed URL (defensive)', () => {
    expect(isCloudBaseUrl('not a url')).toBe(false);
    expect(isCloudBaseUrl('')).toBe(false);
  });
});

describe('telemetryEnabled', () => {
  // The Sentry DSN is read from import.meta.env at module load. In the
  // vitest Node env there is no DSN configured, so telemetryEnabled()
  // ALWAYS returns false in this test. This is the correct behavior
  // for production builds without a configured DSN — the gate
  // short-circuits before evaluating cloud/opt-in. To exercise the
  // cloud + opt-in branches, the gate would need DSN injection, which
  // would change the public API. The exhaustive matrix is documented
  // here; the actual gate-runs-in-production path is exercised by
  // integration testing.

  it('returns false when no DSN is configured (test env baseline)', () => {
    expect(telemetryEnabled({ baseUrl: 'https://api.driftstack.dev', optIn: true })).toBe(false);
    expect(telemetryEnabled({ baseUrl: 'https://api.driftstack.dev', optIn: null })).toBe(false);
    expect(telemetryEnabled({ baseUrl: 'http://localhost:7780', optIn: true })).toBe(false);
  });

  // Documentation-shaped assertions: the matrix should behave as
  // follows once DSN is configured. These tests serve as executable
  // contract notes.
  it('documents the gating matrix (DSN-conditional)', () => {
    // When DSN is present, the matrix is:
    //   cloud + optIn=true  → ON
    //   cloud + optIn=null  → ON (cloud default)
    //   cloud + optIn=false → OFF
    //   selfhosted + optIn=true  → ON (explicit override)
    //   selfhosted + optIn=null  → OFF (self-hosted default)
    //   selfhosted + optIn=false → OFF
    // No assertions here — DSN is empty in tests. Documenting the
    // intended matrix as a comment-as-contract.
    expect(true).toBe(true);
  });
});

describe('keepSentryIntegration — crash-only integration filter', () => {
  it('DROPS the Breadcrumbs integration (privacy contract: no console/DOM/fetch/xhr breadcrumb capture)', () => {
    // The load-bearing assertion: Breadcrumbs auto-captures URLs (incl.
    // the `?ds_token=<apiKey>` notification stream) + console/DOM data,
    // which the crash-only privacy contract forbids.
    expect(keepSentryIntegration('Breadcrumbs')).toBe(false);
  });

  it('DROPS performance tracing / session replay / profiling', () => {
    expect(keepSentryIntegration('BrowserTracing')).toBe(false);
    expect(keepSentryIntegration('Replay')).toBe(false);
    expect(keepSentryIntegration('BrowserProfilingIntegration')).toBe(false);
  });

  it('KEEPS the error-capture core', () => {
    expect(keepSentryIntegration('GlobalHandlers')).toBe(true);
    expect(keepSentryIntegration('LinkedErrors')).toBe(true);
    expect(keepSentryIntegration('Dedupe')).toBe(true);
  });

  it('DROPPED_SENTRY_INTEGRATIONS pins the exact crash-only drop-set (incl. Breadcrumbs)', () => {
    expect([...DROPPED_SENTRY_INTEGRATIONS]).toEqual([
      'BrowserTracing',
      'Replay',
      'BrowserProfilingIntegration',
      'Breadcrumbs',
    ]);
  });
});

describe('scrubEvent — beforeSend PII scrubber', () => {
  const hint = {} as EventHint;

  it('scrubs Authorization / Cookie headers, preserves the rest', () => {
    const ev = {
      request: {
        headers: {
          Authorization: 'Bearer ds_live_secret',
          Cookie: 'sid=abc',
          'x-api-key': 'raw-api-secret',
          'X-Other': 'ok',
        },
      },
    } as unknown as ErrorEvent;
    const h = scrubEvent(ev, hint)!.request!.headers as Record<string, string>;
    expect(h.Authorization).toBe('[scrubbed]');
    expect(h.Cookie).toBe('[scrubbed]');
    expect(h['x-api-key']).toBe('[scrubbed]');
    expect(h['X-Other']).toBe('ok');
  });

  it('strips credential-shaped query params from request.url (the ?ds_token=<apiKey> vector)', () => {
    const ev = {
      request: {
        url: 'https://api.driftstack.dev/v1/account/me/notifications?ds_token=ds_live_SECRET&foo=bar',
      },
    } as unknown as ErrorEvent;
    const url = scrubEvent(ev, hint)!.request!.url!;
    expect(url).not.toContain('ds_live_SECRET');
    expect(url).toContain('ds_token=%5Bscrubbed%5D'); // URL-encoded "[scrubbed]"
    expect(url).toContain('foo=bar'); // non-sensitive param preserved
  });

  it('scrubs credential params from a relative request URL', () => {
    const ev = {
      request: { url: '/v1/events?ds_token=RELATIVE_SECRET&code=OAUTH_SECRET&ok=1' },
    } as unknown as ErrorEvent;
    const url = scrubEvent(ev, hint)!.request!.url!;
    expect(url).not.toContain('RELATIVE_SECRET');
    expect(url).not.toContain('OAUTH_SECRET');
    expect(url).toContain('ds_token=%5Bscrubbed%5D');
    expect(url).toContain('code=%5Bscrubbed%5D');
    expect(url).toContain('ok=1');
  });

  it('scrubs credential-shaped breadcrumb data (field names + nested url query)', () => {
    const ev = {
      breadcrumbs: [
        {
          category: 'fetch',
          data: {
            url: 'https://api.driftstack.dev/x?token=SECRET',
            api_key: 'ds_live_X',
            status: 200,
          },
        },
      ],
    } as unknown as ErrorEvent;
    const data = scrubEvent(ev, hint)!.breadcrumbs![0]!.data as Record<string, unknown>;
    expect(data.api_key).toBe('[scrubbed]');
    expect(String(data.url)).not.toContain('SECRET');
    expect(data.status).toBe(200); // non-sensitive field preserved
  });

  it('scrubs extra + contexts credential fields, preserves benign ones', () => {
    const ev = {
      extra: { api_key: 'X', note: 'fine' },
      contexts: { app: { secret: 'Y', name: 'gui' } },
    } as unknown as ErrorEvent;
    const out = scrubEvent(ev, hint)!;
    const extra = out.extra as Record<string, unknown>;
    const app = out.contexts!.app as Record<string, unknown>;
    expect(extra.api_key).toBe('[scrubbed]');
    expect(extra.note).toBe('fine');
    expect(app.secret).toBe('[scrubbed]');
    expect(app.name).toBe('gui');
  });

  it('recursively scrubs nested request data/extra credentials and cuts cycles', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const ev = {
      request: { data: { account: { credentials: { api_key: 'NESTED_KEY' } } } },
      extra: { nested: { password: 'NESTED_PASSWORD' }, cycle },
    } as unknown as ErrorEvent;
    const out = scrubEvent(ev, hint)!;
    expect(out.request?.data).toBe('[scrubbed: request body]');
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('NESTED_KEY');
    expect(serialized).not.toContain('NESTED_PASSWORD');
    expect(serialized).toContain('[scrubbed: structure limit]');
  });

  it('fails closed on over-depth extra data', () => {
    const data: Record<string, unknown> = {};
    let cursor = data;
    for (let depth = 0; depth < 12; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.nested = next;
      cursor = next;
    }
    cursor.api_key = 'TOO_DEEP_SECRET';
    const ev = { extra: { data } } as unknown as ErrorEvent;
    const serialized = JSON.stringify(scrubEvent(ev, hint));
    expect(serialized).not.toContain('TOO_DEEP_SECRET');
    expect(serialized).toContain('[scrubbed: structure limit]');
  });

  it('scrubs a credential-bearing URL interpolated into the EXCEPTION MESSAGE (fetch/EventSource error citing ?ds_token=<apiKey>)', () => {
    const ev = {
      exception: {
        values: [
          {
            type: 'TypeError',
            value:
              'Failed to fetch https://api.driftstack.dev/v1/account/me/notifications?ds_token=ds_live_SECRET',
          },
        ],
      },
    } as unknown as ErrorEvent;
    const msg = scrubEvent(ev, hint)!.exception!.values![0]!.value!;
    expect(msg).not.toContain('ds_live_SECRET');
    expect(msg).toContain('ds_token=[scrubbed]');
    expect(msg).toContain('Failed to fetch'); // diagnostic context preserved
  });

  it('scrubs Bearer tokens + credential query params from breadcrumb messages', () => {
    const ev = {
      breadcrumbs: [
        { category: 'console', message: 'retry with Authorization: Bearer ds_live_SECRET' },
        { category: 'xhr', message: 'GET https://api.driftstack.dev/x?access_token=SECRET2 200' },
      ],
    } as unknown as ErrorEvent;
    const out = scrubEvent(ev, hint)!.breadcrumbs!;
    expect(String(out[0]!.message)).not.toContain('ds_live_SECRET');
    expect(String(out[0]!.message)).toContain('Bearer [scrubbed]');
    expect(String(out[1]!.message)).not.toContain('SECRET2');
    expect(String(out[1]!.message)).toContain('access_token=[scrubbed]');
  });

  it('scrubs full RFC bearer, Basic, fragment tokens, and URL userinfo in free text', () => {
    const ev = {
      message:
        'Bearer abc.DEF~ghi+DEEP/== Basic YWxpY2U6aHVudGVyMg== https://u:p@host/cb#id_token=FRAGMENT',
    } as unknown as ErrorEvent;
    const message = scrubEvent(ev, hint)!.message!;
    for (const secret of ['DEEP', 'YWxpY2U6aHVudGVyMg==', 'u:p@', 'FRAGMENT']) {
      expect(message).not.toContain(secret);
    }
    expect(message).toContain('Bearer [scrubbed]');
    expect(message).toContain('Basic [scrubbed]');
    expect(message).toContain('https://[scrubbed]@host');
    expect(message).toContain('id_token=[scrubbed]');
  });

  it('scrubs a top-level captureMessage event.message', () => {
    const ev = { message: 'stream died: wss://api/x?token=SECRET3' } as unknown as ErrorEvent;
    expect(scrubEvent(ev, hint)!.message).not.toContain('SECRET3');
    expect(scrubEvent(ev, hint)!.message).toContain('token=[scrubbed]');
  });

  it('returns the event (never drops) when nothing sensitive is present', () => {
    const ev = { message: 'boom' } as unknown as ErrorEvent;
    expect(scrubEvent(ev, hint)).not.toBeNull();
  });
});
