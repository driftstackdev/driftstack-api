// SSRF guard for customer webhook URLs. The critical property is no
// FALSE POSITIVES (a legit public target must never be rejected) and no
// FALSE NEGATIVES on the literal-internal-IP vectors. Boundary cases on
// every blocked range + public IPs are pinned so a typo'd CIDR (e.g. the
// `::ffff:/96` trap that blocks all IPv4) is caught.

import { describe, expect, it } from 'vitest';
import { unsafeWebhookTargetReason as reason } from '../../src/lib/webhook-target-guard.js';

describe('unsafeWebhookTargetReason — rejects internal/reserved targets', () => {
  it('rejects non-https', () => {
    expect(reason('http://example.com/hook')).toMatch(/https/);
    expect(reason('ftp://example.com')).toBeTruthy();
  });

  it('rejects localhost + *.localhost', () => {
    expect(reason('https://localhost/hook')).toMatch(/localhost/);
    expect(reason('https://api.localhost/hook')).toMatch(/localhost/);
  });

  it('rejects IPv4 private / loopback / link-local / reserved literals', () => {
    for (const h of [
      'https://10.0.0.5/h',
      'https://172.16.0.1/h',
      'https://172.31.255.255/h',
      'https://192.168.1.1/h',
      'https://127.0.0.1/h',
      'https://169.254.169.254/h', // cloud metadata
      'https://100.64.0.1/h', // CGNAT
      'https://0.0.0.0/h',
      'https://224.0.0.1/h', // multicast
      'https://240.0.0.1/h', // reserved
    ]) {
      expect(reason(h), h).toBeTruthy();
    }
  });

  it('rejects IPv6 loopback / ULA / link-local literals (bracketed)', () => {
    for (const h of [
      'https://[::1]/h',
      'https://[fc00::1]/h',
      'https://[fd12::1]/h',
      'https://[fe80::1]/h',
      'https://[::]/h',
    ]) {
      expect(reason(h), h).toBeTruthy();
    }
  });

  it('rejects IPv4-mapped IPv6 (private-IPv4 smuggling)', () => {
    expect(reason('https://[::ffff:10.0.0.5]/h')).toBeTruthy();
    expect(reason('https://[::ffff:192.168.0.1]/h')).toBeTruthy();
  });

  it('rejects numeric / hex / octal IP encodings that bypass isIP (SSRF-smuggling for 127.0.0.1)', () => {
    for (const h of [
      'https://2130706433/h', // decimal 127.0.0.1
      'https://0x7f000001/h', // hex 127.0.0.1
      'https://0x7f.0.0.1/h', // hex-leading dotted
      'https://0177.0.0.1/h', // octal 127.0.0.1
      'https://127.1/h', // inet_aton short-form 127.0.0.1
    ]) {
      expect(reason(h), h).toBeTruthy();
    }
  });

  it('rejects trailing-FQDN-dot localhost / literal-IP that would otherwise slip past the host checks', () => {
    expect(reason('https://localhost./h')).toMatch(/localhost/);
    expect(reason('https://127.0.0.1./h')).toBeTruthy();
  });
});

describe('unsafeWebhookTargetReason — allows legit public targets (NO false positives)', () => {
  it('allows public IPv4 incl. boundaries just outside blocked ranges', () => {
    for (const h of [
      'https://8.8.8.8/h',
      'https://1.1.1.1/h',
      'https://9.255.255.255/h', // just below 10/8
      'https://11.0.0.0/h', // just above 10/8
      'https://172.15.255.255/h', // just below 172.16/12
      'https://172.32.0.0/h', // just above 172.16/12
      'https://192.167.255.255/h', // just below 192.168/16
      'https://192.169.0.0/h', // just above 192.168/16
      'https://100.63.255.255/h', // just below 100.64/10
      'https://223.255.255.255/h', // just below 224/4 multicast
    ]) {
      expect(reason(h), h).toBeNull();
    }
  });

  it('allows public IPv6 + normal hostnames', () => {
    expect(reason('https://[2606:4700::1111]/h')).toBeNull();
    expect(reason('https://hooks.example.com/driftstack')).toBeNull();
    expect(reason('https://app.customer.io/webhooks/abc?x=1')).toBeNull();
  });

  it('does NOT over-reject hostnames with a numeric label or a trailing FQDN dot', () => {
    // The numeric-encoding guard requires EVERY label to be numeric/hex; a
    // real hostname always carries an alphabetic label/TLD, so these pass.
    expect(reason('https://1.example.com/h')).toBeNull();
    expect(reason('https://api.123.example.io/h')).toBeNull();
    expect(reason('https://hooks.example.com./h')).toBeNull(); // trailing FQDN dot
  });

  it('returns a reason (not throw) for a malformed URL', () => {
    expect(reason('not a url')).toBeTruthy();
    expect(reason('')).toBeTruthy();
  });
});
