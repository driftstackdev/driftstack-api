// Connection-time SSRF pin for outbound webhook delivery. Tests the security
// core — makeSsrfLookup — with an injected resolver, so the resolve→classify→
// allow/block/forward decision is verified without real DNS. (classifyUnsafeHost
// itself is covered by webhook-target-guard tests.)

import { describe, expect, it } from 'vitest';
import {
  assertSafeSsrfFetchTarget,
  makeSsrfLookup,
  ssrfGuardedFetch,
  SsrfBlockedError,
} from '../../src/lib/ssrf-guarded-fetch.js';

type Addr = string | { address: string; family: number }[];
function fakeResolver(result: { err?: NodeJS.ErrnoException; address?: Addr; family?: number }) {
  return (
    _hostname: string,
    _options: unknown,
    cb: (e: NodeJS.ErrnoException | null, a: Addr, f?: number) => void,
  ): void => {
    cb(result.err ?? null, result.address ?? '', result.family);
  };
}

function runLookup(
  lookup: ReturnType<typeof makeSsrfLookup>,
  options: unknown = {},
): { err: unknown; address: unknown } {
  let captured: { err: unknown; address: unknown } = { err: 'UNSET', address: undefined };
  lookup('host.test', options, (err, address) => {
    captured = { err, address };
  });
  return captured;
}

describe('makeSsrfLookup — connection-time SSRF pin', () => {
  it('allows a public IPv4 address', () => {
    const lookup = makeSsrfLookup(fakeResolver({ address: '93.184.216.34', family: 4 }));
    const { err, address } = runLookup(lookup);
    expect(err).toBeNull();
    expect(address).toBe('93.184.216.34');
  });

  it('blocks the cloud-metadata address (169.254.169.254)', () => {
    const lookup = makeSsrfLookup(fakeResolver({ address: '169.254.169.254', family: 4 }));
    expect(runLookup(lookup).err).toBeInstanceOf(SsrfBlockedError);
  });

  it('blocks loopback + RFC1918 + CGNAT IPv4', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '100.64.0.1']) {
      const lookup = makeSsrfLookup(fakeResolver({ address: ip, family: 4 }));
      expect(runLookup(lookup).err, ip).toBeInstanceOf(SsrfBlockedError);
    }
  });

  it('blocks IPv6 loopback / ULA / link-local', () => {
    for (const ip of [
      '::1',
      'fc00::1',
      'fe80::1',
      '64:ff9b:1::a9fe:a9fe',
      '2001::1',
      '2001:db8::1',
    ]) {
      const lookup = makeSsrfLookup(fakeResolver({ address: ip, family: 6 }));
      expect(runLookup(lookup).err, ip).toBeInstanceOf(SsrfBlockedError);
    }
  });

  it('blocks when ANY address in an all:true result is private', () => {
    const lookup = makeSsrfLookup(
      fakeResolver({
        address: [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ],
      }),
    );
    expect(runLookup(lookup, { all: true }).err).toBeInstanceOf(SsrfBlockedError);
  });

  it('allows when every address in an all:true result is public', () => {
    const lookup = makeSsrfLookup(
      fakeResolver({
        address: [
          { address: '93.184.216.34', family: 4 },
          { address: '1.1.1.1', family: 4 },
        ],
      }),
    );
    expect(runLookup(lookup, { all: true }).err).toBeNull();
  });

  it('forwards a resolver (DNS) error unchanged', () => {
    const dnsErr = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    const lookup = makeSsrfLookup(fakeResolver({ err: dnsErr }));
    expect(runLookup(lookup).err).toBe(dnsErr);
  });
});

describe('ssrfGuardedFetch — literal preflight before dispatcher selection', () => {
  it('rejects direct string/URL/Request literals that bypass DNS lookup', async () => {
    const blocked = [
      'https://198.18.0.1/hook',
      'https://[64:ff9b:1::a9fe:a9fe]/hook',
      'https://[2001::1]/hook',
    ];
    for (const target of blocked) {
      expect(() => assertSafeSsrfFetchTarget(target), target).toThrow(SsrfBlockedError);
      expect(() => assertSafeSsrfFetchTarget(new URL(target)), target).toThrow(SsrfBlockedError);
      expect(() => assertSafeSsrfFetchTarget(new Request(target)), target).toThrow(
        SsrfBlockedError,
      );
      await expect(ssrfGuardedFetch(target), target).rejects.toBeInstanceOf(SsrfBlockedError);
    }
  });

  it('allows public URL forms to continue to connection-time DNS pinning', () => {
    for (const target of [
      'https://hooks.example.com/delivery',
      'https://8.8.8.8/delivery',
      'https://[2606:4700:4700::1111]/delivery',
    ]) {
      expect(() => assertSafeSsrfFetchTarget(target), target).not.toThrow();
      expect(() => assertSafeSsrfFetchTarget(new URL(target)), target).not.toThrow();
      expect(() => assertSafeSsrfFetchTarget(new Request(target)), target).not.toThrow();
    }
  });

  it('rejects malformed, non-HTTPS, and credential-bearing direct calls without reflecting secrets', () => {
    for (const target of [
      'not a URL',
      'http://hooks.example.com/insecure',
      'https://user:super-secret@hooks.example.com/delivery',
      // Unparseable AND credential-bearing. Neither of the two cases above
      // reaches the branch this one does: 'not a URL' takes the unparseable
      // path but carries no secret to detect, and the credential URL above
      // parses fine, so its hostname is read normally and the catch never
      // runs. Only this combination puts a secret in front of the catch that
      // decides whether to reflect the raw target.
      'https://user:super-secret@[not-a-host',
    ]) {
      try {
        assertSafeSsrfFetchTarget(target);
        throw new Error('expected target rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(SsrfBlockedError);
        expect((error as Error).message).not.toContain('super-secret');
      }
    }
  });

  it('CRITICAL names an unparseable target by a fixed placeholder rather than by its own text', () => {
    // The rejection message is built from a hostname the guard re-parses out of
    // the target. When that re-parse fails it keeps a fixed placeholder, and
    // that choice is the whole protection: the raw string is the one thing
    // guaranteed to still hold the credential, and this message is logged.
    //
    // Pinning the placeholder positively — not just asserting the secret is
    // absent — is what makes the arm survive a rewrite of the fallback. A
    // fallback that reflected the target would satisfy "throws SsrfBlockedError"
    // and, for every other fixture in this file, "contains no secret" too.
    try {
      assertSafeSsrfFetchTarget('https://user:super-secret@[not-a-host');
      throw new Error('expected target rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SsrfBlockedError);
      const { message } = error as Error;
      expect(message).toContain('<invalid target>');
      expect(message).not.toContain('super-secret');
      expect(message).not.toContain('not-a-host');
    }
  });
});
