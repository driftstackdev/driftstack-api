import { describe, expect, it } from 'vitest';
import { humanizeError } from '../../src/lib/humanize-error';

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
});
