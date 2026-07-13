// Unit tests for sendGUIInput (gui-control plane client helper).
//
// The function talks to /v1/sessions/:id/gui-input (a scope-gated
// internal-only endpoint not surfaced via the customer SDK per
// L-001). Previously NO direct test coverage — the LiveSessionView
// tests would exercise the happy path indirectly but didn't pin the
// auth-missing branch, the problem+json error mapping, or the
// trailing-slash-stripped baseUrl.
//
// 10 cases cover:
//   - auth-missing fast-fail (no fetch call, no JSON parse)
//   - trailing-slash strip on baseUrl
//   - happy-path response decode
//   - tap_at + type_focused action JSON encoding
//   - error: problem+json with detail + type URI (kind extracted)
//   - error: problem+json with only title (no detail)
//   - error: non-JSON body falls back to HTTP <status>
//   - GUIInputError carries status + kind for callers to dispatch

import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendGUIInput, GUIInputError, type GUIInputAction } from '../../src/lib/gui-input';
import type { DriftstackSettings } from '../../src/lib/settings';

function baseSettings(over: Partial<DriftstackSettings> = {}): DriftstackSettings {
  return {
    apiKey: 'ds_live_testkey0123456789',
    baseUrl: 'https://api.driftstack.dev',
    actAsAccountId: null,
    ...over,
  };
}

interface MockFetch {
  mock: ReturnType<typeof vi.fn>;
  restore: () => void;
}

function mockFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): MockFetch {
  const mock = vi.fn(impl);
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  return {
    mock,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('sendGUIInput', () => {
  it('aborts a stalled coordinate-input request after 15 seconds', async () => {
    vi.useFakeTimers();
    const f = mockFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    try {
      const pending = sendGUIInput(baseSettings(), 'ses_test', { kind: 'tap_at', x: 1, y: 2 });
      const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
    } finally {
      f.restore();
    }
  });

  it('throws GUIInputError(auth_missing) without calling fetch when apiKey is null', async () => {
    const f = mockFetch(() => Promise.reject(new Error('should not be called')));
    try {
      await expect(
        sendGUIInput(baseSettings({ apiKey: null }), 'ses_test', { kind: 'tap_at', x: 1, y: 2 }),
      ).rejects.toMatchObject({
        name: 'GUIInputError',
        status: 0,
        kind: 'auth_missing',
      });
      expect(f.mock).not.toHaveBeenCalled();
    } finally {
      f.restore();
    }
  });

  it('throws GUIInputError(auth_missing) when apiKey is empty string', async () => {
    const f = mockFetch(() => Promise.reject(new Error('should not be called')));
    try {
      await expect(
        sendGUIInput(baseSettings({ apiKey: '' }), 'ses_test', { kind: 'tap_at', x: 1, y: 2 }),
      ).rejects.toBeInstanceOf(GUIInputError);
      expect(f.mock).not.toHaveBeenCalled();
    } finally {
      f.restore();
    }
  });

  it('strips a trailing slash on baseUrl before composing the URL', async () => {
    let capturedUrl = '';
    const f = mockFetch((input) => {
      capturedUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, duration_ms: 12 }), { status: 200 }),
      );
    });
    try {
      await sendGUIInput(baseSettings({ baseUrl: 'https://api.driftstack.dev/' }), 'ses_abc', {
        kind: 'tap_at',
        x: 0,
        y: 0,
      });
      // No double-slash between origin and /v1.
      expect(capturedUrl).toBe('https://api.driftstack.dev/v1/sessions/ses_abc/gui-input');
    } finally {
      f.restore();
    }
  });

  it('strips multiple trailing slashes on baseUrl', async () => {
    let capturedUrl = '';
    const f = mockFetch((input) => {
      capturedUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, duration_ms: 5 }), { status: 200 }),
      );
    });
    try {
      await sendGUIInput(baseSettings({ baseUrl: 'https://api.driftstack.dev///' }), 'ses_x', {
        kind: 'tap_at',
        x: 0,
        y: 0,
      });
      expect(capturedUrl).toBe('https://api.driftstack.dev/v1/sessions/ses_x/gui-input');
    } finally {
      f.restore();
    }
  });

  it('URL-encodes the session id', async () => {
    let capturedUrl = '';
    const f = mockFetch((input) => {
      capturedUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, duration_ms: 1 }), { status: 200 }),
      );
    });
    try {
      // Deliberately weird id (won't actually occur in prod — sessions are uuid-shaped
      // — but the helper still must not corrupt the URL with raw input).
      await sendGUIInput(baseSettings(), 'ses with spaces', {
        kind: 'tap_at',
        x: 0,
        y: 0,
      });
      expect(capturedUrl).toBe(
        'https://api.driftstack.dev/v1/sessions/ses%20with%20spaces/gui-input',
      );
    } finally {
      f.restore();
    }
  });

  it('decodes the happy-path 200 response into the typed GUIInputResponse', async () => {
    const f = mockFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, duration_ms: 42 }), { status: 200 })),
    );
    try {
      const result = await sendGUIInput(baseSettings(), 'ses_test', {
        kind: 'tap_at',
        x: 100,
        y: 200,
      });
      expect(result).toEqual({ ok: true, duration_ms: 42 });
    } finally {
      f.restore();
    }
  });

  it('encodes the tap_at action body verbatim under { action }', async () => {
    let capturedBody = '';
    const f = mockFetch((_input, init) => {
      capturedBody = (init?.body as string) ?? '';
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, duration_ms: 1 }), { status: 200 }),
      );
    });
    try {
      const action: GUIInputAction = { kind: 'tap_at', x: 17, y: 42 };
      await sendGUIInput(baseSettings(), 'ses_test', action);
      expect(JSON.parse(capturedBody)).toEqual({ action: { kind: 'tap_at', x: 17, y: 42 } });
    } finally {
      f.restore();
    }
  });

  it('encodes the type_focused action body with delay_ms', async () => {
    let capturedBody = '';
    const f = mockFetch((_input, init) => {
      capturedBody = (init?.body as string) ?? '';
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, duration_ms: 1 }), { status: 200 }),
      );
    });
    try {
      const action: GUIInputAction = { kind: 'type_focused', text: 'hello', delay_ms: 50 };
      await sendGUIInput(baseSettings(), 'ses_test', action);
      expect(JSON.parse(capturedBody)).toEqual({
        action: { kind: 'type_focused', text: 'hello', delay_ms: 50 },
      });
    } finally {
      f.restore();
    }
  });

  it('maps a problem+json error: detail + type URI → GUIInputError(detail, status, kind)', async () => {
    const f = mockFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'https://errors.driftstack.dev/forbidden',
            title: 'Caller not permitted',
            status: 403,
            detail: 'Missing gui_control scope.',
          }),
          { status: 403, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    try {
      await expect(
        sendGUIInput(baseSettings(), 'ses_test', { kind: 'tap_at', x: 0, y: 0 }),
      ).rejects.toMatchObject({
        name: 'GUIInputError',
        message: 'Missing gui_control scope.',
        status: 403,
        kind: 'forbidden',
      });
    } finally {
      f.restore();
    }
  });

  it('falls back to title when detail is absent on the problem+json body', async () => {
    const f = mockFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'https://errors.driftstack.dev/rate-limited',
            title: 'Rate limit exceeded',
            status: 429,
          }),
          { status: 429 },
        ),
      ),
    );
    try {
      await expect(
        sendGUIInput(baseSettings(), 'ses_test', { kind: 'tap_at', x: 0, y: 0 }),
      ).rejects.toMatchObject({
        message: 'Rate limit exceeded',
        status: 429,
        kind: 'rate-limited',
      });
    } finally {
      f.restore();
    }
  });

  it('falls back to "HTTP <status>" when the body is not JSON', async () => {
    const f = mockFetch(() =>
      Promise.resolve(new Response('<!doctype html>error', { status: 502 })),
    );
    try {
      await expect(
        sendGUIInput(baseSettings(), 'ses_test', { kind: 'tap_at', x: 0, y: 0 }),
      ).rejects.toMatchObject({
        message: 'HTTP 502',
        status: 502,
        kind: 'unknown',
      });
    } finally {
      f.restore();
    }
  });
});
