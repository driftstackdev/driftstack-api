import { describe, expect, it } from 'vitest';
import { humanizeError } from '../../src/lib/humanize-error';
import { DriftstackError } from '../../src/lib/client';

describe('humanizeError', () => {
  it('maps browser transport failures to actionable connection copy', () => {
    expect(humanizeError(new TypeError('Failed to fetch'))).toBe(
      'Check your connection and try again.',
    );
    expect(humanizeError(new TypeError('fetch failed'))).toBe(
      'Check your connection and try again.',
    );
    expect(humanizeError(new Error('offline'))).toBe('Check your connection and try again.');
  });

  it('maps timeouts, verification failures, and HTTP classes without raw internals', () => {
    expect(humanizeError(new DOMException('aborted', 'AbortError'))).toContain('took too long');
    expect(humanizeError(new Error('signature mismatch: key id 7'))).toBe(
      "This download couldn't be verified. Try again later.",
    );
    expect(humanizeError(new Error('HTTP 503 upstream host 10.0.0.4'))).toBe(
      'The service is temporarily unavailable. Try again shortly.',
    );
  });

  it('uses task-specific fallback copy for unknown exceptions', () => {
    expect(humanizeError(new Error('SQLSTATE 23505'), "Couldn't save. Try again.")).toBe(
      "Couldn't save. Try again.",
    );
  });

  it('classifies typed API problems without reflecting remote problem prose', () => {
    const internal = new DriftstackError({
      kind: 'internal',
      status: 500,
      type: 'https://errors.driftstack.dev/internal',
      title: 'upstream failure on node 10.0.0.4',
      detail: 'request req_secret reached postgres://operator:password@db.internal',
    });
    const copy = humanizeError(internal, 'fallback');

    expect(copy).toBe('The service is temporarily unavailable. Try again shortly.');
    expect(copy).not.toContain('10.0.0.4');
    expect(copy).not.toContain('req_secret');
    expect(copy).not.toContain('postgres');
  });

  it('maps SDK kind aliases and payment status to fixed actionable copy', () => {
    expect(
      humanizeError({
        kind: 'validation',
        status: 422,
        message: 'selector parse failed at internal offset 71',
      }),
    ).toBe('Some information was not accepted. Check your input and try again.');
    expect(
      humanizeError({ kind: 'payment_required', status: 402, message: 'raw billing row' }),
    ).toBe('This action requires an active plan. Review Billing and try again.');
  });

  it('keeps transport errors on the connection classifier instead of API status copy', () => {
    const transport = Object.assign(new TypeError('Failed to fetch upstream 10.0.0.8'), {
      kind: 'transport',
      status: 0,
    });
    expect(humanizeError(transport)).toBe('Check your connection and try again.');
  });
});
