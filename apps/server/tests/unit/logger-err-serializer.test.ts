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
});
