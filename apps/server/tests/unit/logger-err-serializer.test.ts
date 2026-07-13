// V-494 follow-up — the logger's `err` serializer must scrub credential tokens
// from a caught error's message/stack before it reaches the logs (the log-channel
// sibling of the lib/sentry.ts exception-message scrub). pino's default err
// serializer logs message/stack verbatim; redact.paths (key-based) can't reach
// a token embedded in that free text.

import { describe, expect, it } from 'vitest';
import { redactErrSerializer } from '../../src/lib/logger.js';

describe('redactErrSerializer', () => {
  it('redacts a credential query param in the error message + stack, keeps the rest', () => {
    const out = redactErrSerializer(
      new Error('upstream 502 for https://up/x?ds_token=ds_live_SECRET retry'),
    );
    const message = out.message as string;
    const stack = (out.stack as string | undefined) ?? '';
    expect(message).not.toContain('ds_live_SECRET');
    expect(message).toContain('ds_token=[redacted]');
    expect(message).toContain('upstream 502'); // diagnostic context kept
    expect(stack).not.toContain('ds_live_SECRET'); // stack's message line too
    expect(out.type).toBe('Error'); // std serializer shape preserved
  });

  it('redacts a Bearer token in the message', () => {
    const out = redactErrSerializer(new Error('rejected: Bearer sk-live-XYZ (401)'));
    const message = out.message as string;
    expect(message).not.toContain('sk-live-XYZ');
    expect(message).toContain('Bearer [redacted]');
  });

  it('leaves a token-free error untouched (shape intact)', () => {
    const out = redactErrSerializer(new Error('ECONNRESET'));
    expect(out.message).toBe('ECONNRESET');
    expect(out.type).toBe('Error');
  });

  it('redacts a credential in a NON-message/stack property (e.g. ApiError.detail) — pino copies it but the old message+stack-only redaction missed it', () => {
    const e = new Error('request failed') as Error & { detail?: string };
    // ApiError sets `this.detail` (own-enumerable) → pino.stdSerializers.err copies it.
    e.detail = 'upstream rejected https://api.x/cb?code=AUTH_SECRET&state=ok';
    const out = redactErrSerializer(e);
    const detail = out.detail as string;
    expect(detail).not.toContain('AUTH_SECRET');
    expect(detail).toContain('code=[redacted]');
    expect(detail).toContain('state=ok'); // benign context kept
  });

  it('redacts a credential in a NESTED property (e.g. an upstream error cause carrying a Bearer token)', () => {
    const e = new Error('dispatch failed') as Error & { cause?: unknown };
    e.cause = { kind: 'upstream', auth: 'Authorization: Bearer sk-live-NESTED (401)' };
    const out = redactErrSerializer(e);
    const cause = out.cause as Record<string, unknown>;
    expect(cause.auth as string).not.toContain('sk-live-NESTED');
    expect(cause.auth as string).toContain('Bearer [redacted]');
  });

  it('redacts nested sensitive keys even when the raw value has no URL or Bearer marker', () => {
    const e = new Error('dispatch failed') as Error & { cause?: unknown };
    e.cause = {
      config: {
        headers: {
          Authorization: 'raw-auth-secret',
          'x-api-key': 'raw-api-secret',
          Cookie: 'session=raw-cookie-secret',
        },
        credentials: { username: 'alice', password: 'raw-password-secret' },
      },
    };

    const serialized = JSON.stringify(redactErrSerializer(e));
    for (const secret of [
      'raw-auth-secret',
      'raw-api-secret',
      'raw-cookie-secret',
      'raw-password-secret',
      'alice',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('[redacted]');
  });

  it('preserves benign diagnostic keys including Error.code', () => {
    const e = new Error('socket failed') as Error & { code?: string; tokenBudget?: number };
    e.code = 'ECONNRESET';
    e.tokenBudget = 4096;
    const out = redactErrSerializer(e);
    expect(out.code).toBe('ECONNRESET');
    expect(out.tokenBudget).toBe(4096);
  });

  it('fails closed on an over-depth credential subtree instead of returning it untouched', () => {
    const e = new Error('dispatch failed') as Error & { upstream?: unknown };
    let nested: Record<string, unknown> = {
      detail: 'https://upstream.invalid/callback?code=DEEP_AUTH_SECRET',
    };
    for (let depth = 0; depth < 10; depth += 1) nested = { nested };
    e.upstream = nested;

    const serialized = JSON.stringify(redactErrSerializer(e));
    expect(serialized).not.toContain('DEEP_AUTH_SECRET');
    expect(serialized).toContain('[redacted: structure limit]');
  });

  it('cuts cyclic error properties so the redacted result remains JSON-serializable', () => {
    const e = new Error('dispatch failed') as Error & { upstream?: unknown };
    const cycle: Record<string, unknown> = { authorization: 'Bearer CYCLE_SECRET' };
    cycle.self = cycle;
    e.upstream = cycle;

    const serialized = JSON.stringify(redactErrSerializer(e));
    expect(serialized).not.toContain('CYCLE_SECRET');
    expect(serialized).toContain('[redacted: structure limit]');
  });
});
