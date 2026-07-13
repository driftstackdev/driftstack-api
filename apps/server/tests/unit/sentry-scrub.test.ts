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
import type { ErrorEvent as SentryErrorEvent } from '@sentry/node';
import {
  __test_scrubInPlace as scrubInPlace,
  __test_scrubSentryEvent as scrubSentryEvent,
} from '../../src/lib/sentry.js';

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

  it('redacts MFA challenge bearer keys in snake_case and camelCase', () => {
    const e = {
      request: {
        data: {
          challenge_token: 'ds_mfa_snake_secret',
          challengeToken: 'ds_mfa_camel_secret',
          code: '123456',
        },
      },
      extra: { challengeToken: 'ds_mfa_extra_secret', outcome: 'invalid' },
    };
    scrubInPlace(e);
    expect(e.request.data.challenge_token).toBe('[redacted]');
    expect(e.request.data.challengeToken).toBe('[redacted]');
    expect(e.request.data.code).toBe('[redacted]');
    expect(e.extra.challengeToken).toBe('[redacted]');
    expect(e.extra.outcome).toBe('invalid');
  });

  it('redacts enrollment seeds, PKCE verifier, and web/OAuth bearer aliases', () => {
    const e = {
      request: {
        data: {
          code_verifier: 'verifier-secret',
          client_secret: 'client-secret',
        },
      },
      extra: {
        debug_token: 'debug-secret',
        sessionToken: 'session-secret',
        id_token: 'id-secret',
        otpauth_uri: 'otpauth://totp/x?secret=seed-secret',
        secretBase32: 'seed-secret',
        authorize_url: 'https://idp.invalid/auth?state=state-secret',
        code_challenge: 'public-challenge',
      },
    };
    scrubInPlace(e);
    expect(JSON.stringify(e)).not.toMatch(
      /verifier-secret|client-secret|debug-secret|session-secret|id-secret|seed-secret|state-secret/,
    );
    expect(e.extra.code_challenge).toBe('public-challenge');
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

  it('redacts account-proxy VPN secrets — config_blob + private_key (a captured POST /v1/account/me/proxies body)', () => {
    // The OpenVPN config_blob embeds certs/keys; the WireGuard private_key is the
    // tunnel key; the nested openvpn.password rides the existing `password` key.
    const e = {
      request: {
        data: {
          label: 'home',
          scheme: 'openvpn',
          openvpn: { config_blob: '-----BEGIN PRIVATE KEY-----xxx', password: 'p' },
          wireguard: { private_key: 'aGVsbG8=' },
        },
      },
    };
    scrubInPlace(e);
    expect(e.request.data.openvpn.config_blob).toBe('[redacted]');
    expect(e.request.data.openvpn.password).toBe('[redacted]');
    expect(e.request.data.wireguard.private_key).toBe('[redacted]');
    // Non-secret fields survive.
    expect(e.request.data.label).toBe('home');
    expect(e.request.data.scheme).toBe('openvpn');
  });

  it('redacts OAuth token fields — token + access_token + refresh_token (introspect/revoke body + token-endpoint response)', () => {
    const e = { token: 'tok_x', access_token: 'at_x', refresh_token: 'rt_x', client_id: 'public' };
    scrubInPlace(e);
    expect(e.token).toBe('[redacted]');
    expect(e.access_token).toBe('[redacted]');
    expect(e.refresh_token).toBe('[redacted]');
    // client_id is a public identifier — must NOT be redacted.
    expect(e.client_id).toBe('public');
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

  // Arc 7 obs.2.b — v2-#8 BYOK + gui_control_key Sentry mirror.
  it('redacts x-byok-anthropic-api-key header (request.headers shape) — v2-#8 BYOK Sentry mirror', () => {
    const e: Record<string, string> = { 'x-byok-anthropic-api-key': 'sk-ant-api03-...' };
    scrubInPlace(e);
    expect(e['x-byok-anthropic-api-key']).toBe('[redacted]');
  });

  it('redacts gui_control_key (snake_case) + guiControlKey (camelCase) — v2-#8 sub-slice 8.4 plaintext', () => {
    const e: Record<string, string> = {
      gui_control_key: 'gck_live_...',
      guiControlKey: 'gck_live_...',
    };
    scrubInPlace(e);
    expect(e.gui_control_key).toBe('[redacted]');
    expect(e.guiControlKey).toBe('[redacted]');
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

  it('cuts cycles instead of leaving an unserializable reference attached', () => {
    const a: Record<string, unknown> = { password: 'x' };
    const b: Record<string, unknown> = { ref: a };
    a.ref = b;
    expect(() => scrubInPlace(a)).not.toThrow();
    expect(a.password).toBe('[redacted]');
    const serialized = JSON.stringify(a);
    expect(serialized).toContain('[redacted: structure limit]');
  });

  it('fails closed on over-depth subtrees so a deep secret cannot reach Sentry', () => {
    const event: Record<string, unknown> = {};
    let cursor = event;
    for (let depth = 0; depth < 12; depth += 1) {
      const child: Record<string, unknown> = {};
      cursor.nested = child;
      cursor = child;
    }
    cursor.authorization = 'Bearer DEEP_SENTRY_SECRET';

    scrubInPlace(event);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('DEEP_SENTRY_SECRET');
    expect(serialized).toContain('[redacted: structure limit]');
  });

  it('leaves scalars and null alone', () => {
    expect(() => scrubInPlace(null)).not.toThrow();
    expect(() => scrubInPlace(undefined)).not.toThrow();
    expect(() => scrubInPlace(42)).not.toThrow();
    expect(() => scrubInPlace('hello')).not.toThrow();
  });
});

describe('V-494 follow-up — Sentry scrub: credential params in request URL', () => {
  it('strips the SSE ds_token from event.request.url + query_string', () => {
    const event = {
      request: {
        url: '/v1/agent-sessions/abc/events?ds_token=sk-live-SECRET',
        query_string: 'ds_token=sk-live-SECRET',
      },
    } as unknown as SentryErrorEvent;
    scrubSentryEvent(event);
    expect(String(event.request?.url)).not.toContain('sk-live-SECRET');
    expect((event.request?.query_string ?? '') as string).not.toContain('sk-live-SECRET');
    expect(String(event.request?.url)).toContain('/v1/agent-sessions/abc/events');
  });

  it('leaves a token-free request URL intact', () => {
    const event = {
      request: { url: '/v1/sessions?limit=20' },
    } as unknown as SentryErrorEvent;
    scrubSentryEvent(event);
    expect(String(event.request?.url)).toBe('/v1/sessions?limit=20');
  });
});

describe('Sentry scrub: credential tokens in exception message / event.message (free-text vector)', () => {
  it('redacts a token embedded in the EXCEPTION MESSAGE (not request.url — the W341 gap)', () => {
    const event = {
      exception: {
        values: [
          {
            type: 'FetchError',
            value: 'request failed: GET https://up/x?ds_token=sk-live-SECRET (502)',
          },
        ],
      },
    } as unknown as SentryErrorEvent;
    scrubSentryEvent(event);
    const v = event.exception!.values![0]!.value!;
    expect(v).not.toContain('sk-live-SECRET');
    expect(v).toContain('ds_token=[redacted]');
    expect(v).toContain('(502)'); // diagnostic context preserved
  });

  it('redacts a token in a top-level captureMessage event.message', () => {
    const event = { message: 'oauth cb ?code=AUTHCODE failed' } as unknown as SentryErrorEvent;
    scrubSentryEvent(event);
    expect(String(event.message)).not.toContain('AUTHCODE');
    expect(String(event.message)).toContain('code=[redacted]');
  });
});
