import { describe, it, expect } from 'vitest';
import { parseProxyString } from '../../src/lib/parse-proxy';

describe('parseProxyString', () => {
  it('host:port:user:pass — the vendor colon-delimited form (NodeMaven)', () => {
    const got = parseProxyString(
      'gate.nodemaven.com:1080:nosnossos92_gmail_com-country-us-region-california-sid-0790a58056bf4-filter-medium-speed-fast:cv02xt720i',
    );
    expect(got).toEqual({
      host: 'gate.nodemaven.com',
      port: 1080,
      username:
        'nosnossos92_gmail_com-country-us-region-california-sid-0790a58056bf4-filter-medium-speed-fast',
      password: 'cv02xt720i',
    });
  });

  it('host:port — no auth', () => {
    expect(parseProxyString('1.2.3.4:1080')).toEqual({
      host: '1.2.3.4',
      port: 1080,
      username: null,
      password: null,
    });
  });

  it('host:port:user — username only', () => {
    expect(parseProxyString('proxy.example.com:1080:alice')).toEqual({
      host: 'proxy.example.com',
      port: 1080,
      username: 'alice',
      password: null,
    });
  });

  it('user:pass@host:port — authority form', () => {
    expect(parseProxyString('alice:s3cret@proxy.example.com:1080')).toEqual({
      host: 'proxy.example.com',
      port: 1080,
      username: 'alice',
      password: 's3cret',
    });
  });

  it('strips a socks5:// scheme', () => {
    expect(parseProxyString('socks5://alice:pw@1.2.3.4:1080')).toEqual({
      host: '1.2.3.4',
      port: 1080,
      username: 'alice',
      password: 'pw',
    });
  });

  it('keeps a colon inside the password (host:port form)', () => {
    expect(parseProxyString('h:1080:user:pa:ss')).toEqual({
      host: 'h',
      port: 1080,
      username: 'user',
      password: 'pa:ss',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseProxyString('  1.2.3.4:1080  ')?.host).toBe('1.2.3.4');
  });

  it('returns null for junk / missing port / bad port', () => {
    expect(parseProxyString('')).toBeNull();
    expect(parseProxyString('justahost')).toBeNull();
    expect(parseProxyString('host:0')).toBeNull();
    expect(parseProxyString('host:70000')).toBeNull();
    expect(parseProxyString('host:notaport')).toBeNull();
  });

  it('parses a bracketed IPv6 authority — [v6]:port', () => {
    expect(parseProxyString('[2001:db8::1]:1080')).toEqual({
      host: '2001:db8::1',
      port: 1080,
      username: null,
      password: null,
    });
  });

  it('parses a bracketed IPv6 authority with user:pass@ credentials', () => {
    expect(parseProxyString('alice:s3cret@[2001:db8::1]:1080')).toEqual({
      host: '2001:db8::1',
      port: 1080,
      username: 'alice',
      password: 's3cret',
    });
  });

  it('strips a scheme before a bracketed IPv6 authority', () => {
    expect(parseProxyString('socks5://[fe80::1]:1080')?.host).toBe('fe80::1');
  });

  it('returns null for an unbracketed IPv6 (ambiguous host/port split)', () => {
    // Without brackets the address colons are indistinguishable from the
    // port separator, so we require the bracket form.
    expect(parseProxyString('2001:db8::1:1080')).toBeNull();
  });
});
