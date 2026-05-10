// V-494 — Sentry beforeSend scrubber. Mirrors the pino redact list
// in `lib/logger.ts` so events that bypass pino (Sentry's automatic
// request capture, breadcrumb data attached by integrations) still
// land at sentry.io with secret values stripped.
//
// The scrubber is a private helper but exercised here via a tiny
// shim in lib/sentry.ts that re-exports it under a `__test_*` name.
// Keeping the shim out of public API surface but accessible for
// pinning the redaction matrix.

import { describe, expect, it } from 'vitest';
import { __test_scrubInPlace as scrubInPlace } from '../../src/lib/sentry.js';

describe('V-494 — Sentry scrub: top-level keys', () => {
  it('redacts password field', () => {
    const e = { password: 'hunter2', email: 'a@b.com' };
    scrubInPlace(e);
    expect(e.password).toBe('[redacted]');
    expect(e.email).toBe('a@b.com');
  });

  it('redacts new_password and current_password', () => {
    const e = { new_password: 'x', current_password: 'y', other: 'ok' };
    scrubInPlace(e);
    expect(e.new_password).toBe('[redacted]');
    expect(e.current_password).toBe('[redacted]');
    expect(e.other).toBe('ok');
  });

  it('redacts recovery_code + recovery_codes (single + array)', () => {
    const e = {
      recovery_code: 'abc-def',
      recovery_codes: ['a', 'b', 'c'],
    };
    scrubInPlace(e);
    expect(e.recovery_code).toBe('[redacted]');
    expect(e.recovery_codes).toBe('[redacted]');
  });

  it('redacts secret + signing_secret + webhook_secret', () => {
    const e = { secret: 's', signing_secret: 'ss', webhook_secret: 'ws' };
    scrubInPlace(e);
    expect(e.secret).toBe('[redacted]');
    expect(e.signing_secret).toBe('[redacted]');
    expect(e.webhook_secret).toBe('[redacted]');
  });

  it('redacts plaintext + apiKey + api_key', () => {
    const e = { plaintext: 'sk_live_x', apiKey: 'k', api_key: 'k2' };
    scrubInPlace(e);
    expect(e.plaintext).toBe('[redacted]');
    expect(e.apiKey).toBe('[redacted]');
    expect(e.api_key).toBe('[redacted]');
  });

  it('redacts authorization / cookie / set-cookie / stripe-signature headers', () => {
    const e = {
      authorization: 'Bearer x',
      cookie: 'sid=abc',
      'set-cookie': ['sid=abc'],
      'stripe-signature': 't=1,v1=abc',
    };
    scrubInPlace(e);
    expect(e.authorization).toBe('[redacted]');
    expect(e.cookie).toBe('[redacted]');
    expect(e['set-cookie']).toBe('[redacted]');
    expect(e['stripe-signature']).toBe('[redacted]');
  });

  it('is case-insensitive on key names', () => {
    const e = { Password: 'p', AUTHORIZATION: 'b', RecoveryCodes: ['x'] };
    scrubInPlace(e);
    expect(e.Password).toBe('[redacted]');
    expect(e.AUTHORIZATION).toBe('[redacted]');
    expect(e.RecoveryCodes).toBe('[redacted]');
  });
});

describe('V-494 — Sentry scrub: nested structures', () => {
  it('descends into request.headers', () => {
    const event = {
      request: {
        method: 'POST',
        url: '/v1/account/password',
        headers: { authorization: 'Bearer abc', accept: 'application/json' },
        data: { current_password: 'old', new_password: 'new' },
      },
    };
    scrubInPlace(event);
    expect(event.request.headers.authorization).toBe('[redacted]');
    expect(event.request.headers.accept).toBe('application/json');
    expect(event.request.data.current_password).toBe('[redacted]');
    expect(event.request.data.new_password).toBe('[redacted]');
  });

  it('descends into breadcrumb arrays + data', () => {
    const event = {
      breadcrumbs: [
        {
          category: 'http.request',
          message: 'POST /v1/auth/login',
          data: { password: 'hunter2', email: 'a@b.com' },
        },
        { category: 'auth', message: 'mfa.code', data: { code: '123456' } },
      ],
    };
    scrubInPlace(event);
    expect(event.breadcrumbs[0]!.data.password).toBe('[redacted]');
    expect(event.breadcrumbs[0]!.data.email).toBe('a@b.com');
    expect(event.breadcrumbs[1]!.data.code).toBe('[redacted]');
  });

  it('descends into extras', () => {
    const event = {
      extra: { signingSecret: 'sk_x', requestId: 'req_1' },
    };
    scrubInPlace(event);
    expect(event.extra.signingSecret).toBe('[redacted]');
    expect(event.extra.requestId).toBe('req_1');
  });

  it('does not infinite-loop on cycles (depth-bounded)', () => {
    const a: Record<string, unknown> = { password: 'x' };
    const b: Record<string, unknown> = { ref: a };
    a.ref = b;
    expect(() => scrubInPlace(a)).not.toThrow();
    expect(a.password).toBe('[redacted]');
  });

  it('leaves scalars and null alone', () => {
    expect(() => scrubInPlace(null)).not.toThrow();
    expect(() => scrubInPlace(undefined)).not.toThrow();
    expect(() => scrubInPlace(42)).not.toThrow();
    expect(() => scrubInPlace('hello')).not.toThrow();
  });
});
