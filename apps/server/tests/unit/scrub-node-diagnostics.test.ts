// audit M2 — scrubNodeDiagnostics redacts the Mac fleet node's real egress IP
// (the W1859 `direct=<node-ip>` format) + bare IPv4 literals from a free-form
// harness diagnostic before it crosses to a customer surface (webhook / SDK).

import { describe, expect, it } from 'vitest';
import { scrubNodeDiagnostics } from '../../src/services/scrub-node-diagnostics.js';

describe('scrubNodeDiagnostics', () => {
  it('redacts the documented `direct=<node-ip>` egress-leak segment', () => {
    const out = scrubNodeDiagnostics('blocked proxied=203.0.113.5 direct=10.0.0.7');
    expect(out).not.toContain('10.0.0.7');
    expect(out).toContain('direct=[redacted]');
  });

  it('redacts an IPv6 node IP carried in the `direct=` form (whole token)', () => {
    const out = scrubNodeDiagnostics('direct=2001:db8::42 lost');
    expect(out).not.toContain('2001:db8::42');
    expect(out).toContain('direct=[redacted]');
  });

  it('redacts bare IPv4 literals (defence-in-depth, outside a direct= segment)', () => {
    expect(scrubNodeDiagnostics('connect 192.168.1.9 failed')).not.toContain('192.168.1.9');
    expect(scrubNodeDiagnostics('connect 192.168.1.9 failed')).toContain('[redacted-ip]');
  });

  it('is a no-op on a string with no node diagnostics', () => {
    expect(scrubNodeDiagnostics('captcha challenge presented')).toBe('captcha challenge presented');
  });

  it('does NOT scrub timestamps (colon-separated decimals are not treated as IPv6)', () => {
    expect(scrubNodeDiagnostics('failed at 12:34:56')).toBe('failed at 12:34:56');
  });

  it('handles `direct =` with surrounding whitespace', () => {
    expect(scrubNodeDiagnostics('direct = 10.1.2.3')).toContain('direct=[redacted]');
  });
});
