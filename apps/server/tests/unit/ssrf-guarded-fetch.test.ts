// Connection-time SSRF pin for outbound webhook delivery. Tests the security
// core — makeSsrfLookup — with an injected resolver, so the resolve→classify→
// allow/block/forward decision is verified without real DNS. (classifyUnsafeHost
// itself is covered by webhook-target-guard tests.)

import { describe, expect, it } from 'vitest';
import { makeSsrfLookup, SsrfBlockedError } from '../../src/lib/ssrf-guarded-fetch.js';

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
    for (const ip of ['::1', 'fc00::1', 'fe80::1']) {
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
