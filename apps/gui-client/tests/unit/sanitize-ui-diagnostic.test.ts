import { describe, expect, it } from 'vitest';
import { sanitizeUiDiagnostic } from '../../src/lib/sanitize-ui-diagnostic';

describe('sanitizeUiDiagnostic', () => {
  it('redacts authorization, URL userinfo, and credential parameters', () => {
    const safe = sanitizeUiDiagnostic(
      'Bearer live-token https://alice:hunter2@example.test/cb?token=abc&ok=1#secret=xyz api_key=key-123 password: "two words"',
    );

    expect(safe).toContain('Bearer [redacted]');
    expect(safe).toContain('https://[redacted]@example.test/cb?token=[redacted]&ok=1');
    expect(safe).toContain('#secret=[redacted]');
    expect(safe).toContain('api_key=[redacted]');
    expect(safe).toContain('password: "[redacted]"');
    expect(safe).not.toMatch(/live-token|alice|hunter2|token=abc|secret=xyz|key-123|two words/);
  });

  it('redacts local user roots and private node addresses while retaining stack context', () => {
    const safe = sanitizeUiDiagnostic(
      'Error at /Users/john/code/driftstack/src/main.ts:42:7 via 10.22.3.4, node.internal:9443 and [fd00::12]',
    );

    expect(safe).toContain('~/code/driftstack/src/main.ts:42:7');
    expect(safe).toContain('[private-host]');
    expect(safe).not.toMatch(/\/Users\/john|10\.22\.3\.4|node\.internal|9443|fd00::12/);
  });

  it('redacts the complete input before applying the display bound', () => {
    const safe = sanitizeUiDiagnostic(`prefix token=${'s'.repeat(200)}`, 'fallback', 35);
    expect(safe).toBe('prefix token=[redacted]');
  });

  it('returns stable fallback copy when string conversion is empty or throws', () => {
    expect(sanitizeUiDiagnostic('   ', 'No details')).toBe('No details');
    expect(
      sanitizeUiDiagnostic(
        {
          toString(): string {
            throw new Error('must not escape');
          },
        },
        'No details',
      ),
    ).toBe('No details');
  });
});
