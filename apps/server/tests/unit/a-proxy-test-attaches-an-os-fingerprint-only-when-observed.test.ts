// "we should also add passive OS TCP/IP fingerprint OS (for example IOS,
// Windows, Linux, and if its mismatched, it should be red, and if MAC/IOS then
// green (match)." (owner item N-2.)
//
// A SOCKS5 proxy opens its OWN connection to the destination, so the SYN the
// destination sees was built by the proxy host's kernel. The control plane
// cannot read that SYN from a connected socket, so it CONNECTs through the
// proxy to a raw-socket observer and reads the recorded signature back. These
// arms pin the part that can lie: WHEN a fingerprint is reported.
//
//   - Only after the tunnel is up (the SYN exists) and the observer has a
//     record under one of the two addresses the topology can produce.
//   - The address we dialled is tried FIRST — measured 2026-09-02: an
//     application-layer proxy emitted the SYN from its gateway address, not
//     from the CGNAT exit the echo reported — then the echo's exit IP.
//   - Never a default. A miss says why; it does not say "linux".

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, connect, type Server, type Socket } from 'node:net';
import {
  ProxyConnectivityProbe,
  type ProbeProxyDescriptor,
} from '../../src/services/proxy-connectivity-probe.js';
import {
  makeOsObserverLookup,
  parseObserverSignature,
  type OsObserverLookup,
  type OsObserverLookupResult,
} from '../../src/lib/os-observer-lookup.js';
import type { TcpSynSignature } from '../../src/lib/tcp-os-fingerprint.js';

const servers: Server[] = [];
const liveSockets = new Set<Socket>();
afterEach(async () => {
  for (const s of liveSockets) s.destroy();
  liveSockets.clear();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** A scripted SOCKS5 proxy on loopback: greeting → NO-AUTH; CONNECT → `rep`. */
async function fakeSocks5(rep: number): Promise<{
  dial: (host: string, port: number, timeoutMs: number) => Promise<Socket>;
  connects: string[];
}> {
  const connects: string[] = [];
  const server = createServer((sock) => {
    liveSockets.add(sock);
    sock.on('close', () => liveSockets.delete(sock));
    let step = 0;
    sock.on('data', (chunk) => {
      if (step === 0) {
        sock.write(Buffer.from([0x05, 0x00]));
        step = 1;
      } else if (step === 1) {
        // ATYP 0x03 DOMAINNAME: len at [4], name follows, port after.
        const len = chunk[4] ?? 0;
        const host = chunk.subarray(5, 5 + len).toString('utf8');
        const port = ((chunk[5 + len] ?? 0) << 8) | (chunk[6 + len] ?? 0);
        connects.push(`${host}:${String(port)}`);
        sock.write(Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        step = 2;
      }
    });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const dial = (_h: string, _p: number): Promise<Socket> =>
    new Promise<Socket>((resolve, reject) => {
      const s = connect({ host: '127.0.0.1', port }, () => resolve(s));
      s.on('error', reject);
    });
  return { dial, connects };
}

const PROXY: ProbeProxyDescriptor = { protocol: 'socks5', host: 'proxy.example', port: 1080 };
const DARWIN: TcpSynSignature = {
  ttl: 54,
  windowSize: 65535,
  mss: 1460,
  windowScale: 6,
  optionOrder: [2, 1, 3, 1, 1, 8, 4, 0],
  df: true,
};
const WINDOWS: TcpSynSignature = {
  ttl: 117,
  windowSize: 64240,
  mss: 1460,
  windowScale: 8,
  optionOrder: [2, 1, 3, 1, 1, 4],
  df: true,
};

/** A lookup that answers from a table and records what it was asked. */
function tableLookup(table: Record<string, OsObserverLookupResult>): {
  lookup: OsObserverLookup;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    lookup: (ip) => {
      asked.push(ip);
      return Promise.resolve(table[ip] ?? { kind: 'absent' });
    },
  };
}

const observerFor = (lookup: OsObserverLookup) => ({
  host: 'observer.example',
  port: 7791,
  lookup,
});

describe('a fingerprint is reported only when a SYN was observed', () => {
  it('tunnels to the OBSERVER (not the egress target) and reports the signature found under the dialled address', async () => {
    const { dial, connects } = await fakeSocks5(0x00);
    const { lookup, asked } = tableLookup({ '127.0.0.1': { kind: 'observed', signature: DARWIN } });
    const probe = new ProxyConnectivityProbe({ dial, osObserver: observerFor(lookup) });
    const r = await probe.observeOs(PROXY, '203.0.113.9');
    expect(connects).toEqual(['observer.example:7791']);
    if (!r.observed) throw new Error(`expected observed, got: ${r.reason}`);
    expect(r.via).toBe('proxy_host');
    expect(r.observedIp).toBe('127.0.0.1');
    expect(r.os).toBe('macos-or-ios');
    // The dialled address is consulted FIRST; the exit IP is never needed here.
    expect(asked).toEqual(['127.0.0.1']);
  });

  it('falls back to the echo exit IP when the dialled address has no record', async () => {
    const { dial } = await fakeSocks5(0x00);
    const { lookup, asked } = tableLookup({
      '203.0.113.9': { kind: 'observed', signature: WINDOWS },
    });
    const probe = new ProxyConnectivityProbe({ dial, osObserver: observerFor(lookup) });
    const r = await probe.observeOs(PROXY, '203.0.113.9');
    if (!r.observed) throw new Error(`expected observed, got: ${r.reason}`);
    expect(r.via).toBe('exit_ip');
    expect(r.os).toBe('windows');
    expect(asked).toEqual(['127.0.0.1', '203.0.113.9']);
  });

  it('reports NOT observed — naming both misses — when neither address has a record', async () => {
    const { dial } = await fakeSocks5(0x00);
    const { lookup } = tableLookup({});
    const probe = new ProxyConnectivityProbe({ dial, osObserver: observerFor(lookup) });
    const r = await probe.observeOs(PROXY, '203.0.113.9');
    expect(r.observed).toBe(false);
    if (r.observed) throw new Error('unreachable');
    // THE property: a miss is a miss with a reason, never a default OS.
    expect(r.reason).toContain('127.0.0.1: no SYN recorded');
    expect(r.reason).toContain('203.0.113.9: no SYN recorded');
    expect(r).not.toHaveProperty('os');
  });

  it('does not consult the observer at all when the tunnel is refused (no SYN was sent)', async () => {
    const { dial } = await fakeSocks5(0x05); // connection refused by host
    const { lookup, asked } = tableLookup({ '127.0.0.1': { kind: 'observed', signature: DARWIN } });
    const probe = new ProxyConnectivityProbe({ dial, osObserver: observerFor(lookup) });
    const r = await probe.observeOs(PROXY, '203.0.113.9');
    expect(r.observed).toBe(false);
    // A stale record under the proxy's address would otherwise be reported as
    // if this tunnel had produced it.
    expect(asked).toEqual([]);
  });

  it('surfaces an observer error as the reason, distinct from "no SYN"', async () => {
    const { dial } = await fakeSocks5(0x00);
    const { lookup } = tableLookup({
      '127.0.0.1': { kind: 'error', detail: 'observer answered 503' },
    });
    const probe = new ProxyConnectivityProbe({ dial, osObserver: observerFor(lookup) });
    const r = await probe.observeOs(PROXY);
    expect(r.observed).toBe(false);
    if (r.observed) throw new Error('unreachable');
    expect(r.reason).toContain('observer answered 503');
  });

  it('with no observer configured it neither dials nor looks up', async () => {
    let dials = 0;
    const dial = (): Promise<Socket> => {
      dials += 1;
      return Promise.reject(new Error('must not dial'));
    };
    const probe = new ProxyConnectivityProbe({ dial });
    const r = await probe.observeOs(PROXY, '203.0.113.9');
    expect(r).toEqual({ observed: false, reason: 'observer not configured' });
    expect(dials).toBe(0);
  });

  it('the launch probe is untouched by the observer: probe() never tunnels to it', async () => {
    // Vacuity control for the design rule "observeOs is not part of probe()".
    const { dial, connects } = await fakeSocks5(0x05);
    const { lookup, asked } = tableLookup({});
    const probe = new ProxyConnectivityProbe({
      dial,
      osObserver: observerFor(lookup),
      targetUrl: 'http://echo.example:8080/v1/egress/echo',
    });
    await probe.probe(PROXY);
    expect(connects).toEqual(['echo.example:8080']);
    expect(asked).toEqual([]);
  });
});

describe('the observer record is parsed strictly', () => {
  const WIRE = {
    ttl: 54,
    df: true,
    window: 65535,
    mss: 1460,
    wscale: 6,
    options: [2, 1, 3, 1, 1, 8, 4, 0],
    seen_at: 1,
  };

  it('maps a complete record onto the classifier signature', () => {
    expect(parseObserverSignature(WIRE)).toEqual(DARWIN);
  });

  it('accepts absent (null) MSS and window scale — a minimal stack omits them', () => {
    const sig = parseObserverSignature({ ...WIRE, mss: null, wscale: null });
    expect(sig?.mss).toBeNull();
    expect(sig?.windowScale).toBeNull();
  });

  it('rejects a record missing a field every SYN carries, or carrying a malformed one', () => {
    const { options: _o, ...noOptions } = WIRE;
    expect(parseObserverSignature(noOptions)).toBeNull();
    expect(parseObserverSignature({ ...WIRE, ttl: 300 })).toBeNull();
    expect(parseObserverSignature({ ...WIRE, mss: 'x' })).toBeNull();
    expect(parseObserverSignature({ ...WIRE, wscale: 300 })).toBeNull();
    expect(parseObserverSignature({ ...WIRE, options: [2, 'a'] })).toBeNull();
    expect(parseObserverSignature(null)).toBeNull();
  });
});

describe('the loopback lookup', () => {
  const fetchFor = (status: number, body: unknown): { fetchImpl: typeof fetch; urls: string[] } => {
    const urls: string[] = [];
    const fetchImpl = (url: string | URL | Request): Promise<Response> => {
      urls.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    };
    return { fetchImpl, urls };
  };

  it('404 is "absent", 200 is the parsed signature, anything else is an error', async () => {
    const WIRE = {
      ttl: 54,
      df: true,
      window: 65535,
      mss: 1460,
      wscale: 6,
      options: [2, 1, 3, 1, 1, 8, 4, 0],
    };
    const a = fetchFor(404, { error: 'no' });
    expect(await makeOsObserverLookup('http://127.0.0.1:7792/', a.fetchImpl)('10.0.0.1')).toEqual({
      kind: 'absent',
    });
    expect(a.urls).toEqual(['http://127.0.0.1:7792/sig/10.0.0.1']);
    const b = fetchFor(200, WIRE);
    expect(await makeOsObserverLookup('http://127.0.0.1:7792', b.fetchImpl)('10.0.0.1')).toEqual({
      kind: 'observed',
      signature: DARWIN,
    });
    const c = fetchFor(503, {});
    expect(
      (await makeOsObserverLookup('http://127.0.0.1:7792', c.fetchImpl)('10.0.0.1')).kind,
    ).toBe('error');
    const d = fetchFor(200, { ttl: 'x' });
    expect(
      (await makeOsObserverLookup('http://127.0.0.1:7792', d.fetchImpl)('10.0.0.1')).kind,
    ).toBe('error');
  });

  it('refuses a key that is not an IP literal without touching the network', async () => {
    // The exit IP arrived THROUGH the customer's proxy; it is untrusted text
    // until isIP says otherwise, and must never be spliced into a URL as-is.
    const f = fetchFor(200, {});
    const r = await makeOsObserverLookup('http://127.0.0.1:7792', f.fetchImpl)('../healthz');
    expect(r.kind).toBe('error');
    expect(f.urls).toEqual([]);
  });
});
