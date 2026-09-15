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

import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('tunnels to the OBSERVER (not the egress target) and reports the signature found under the EXIT address, which it consults first', async () => {
    const { dial, connects } = await fakeSocks5(0x00);
    const { lookup, asked } = tableLookup({
      '203.0.113.9': { kind: 'observed', signature: DARWIN, seenAtMs: Date.now() },
    });
    const probe = new ProxyConnectivityProbe({ dial, osObserver: observerFor(lookup) });
    const r = await probe.observeOs(PROXY, '203.0.113.9');
    expect(connects).toEqual(['observer.example:7791']);
    if (!r.observed) throw new Error(`expected observed, got: ${r.reason}`);
    expect(r.via).toBe('exit_ip');
    expect(r.observedIp).toBe('203.0.113.9');
    expect(r.os).toBe('macos-or-ios');
    // ⛔ THE EXIT IS ASKED FIRST, and the front door is never needed here. A
    // proxy egresses from its exit, so that is the source the observer sees.
    // Asking the dialled address first meant a hit on shared provider
    // infrastructure outranked the address that describes THIS proxy.
    expect(asked).toEqual(['203.0.113.9']);
  });

  it('falls back to the dialled address when the exit has no record, and labels it proxy_host', async () => {
    const { dial } = await fakeSocks5(0x00);
    const { lookup, asked } = tableLookup({
      '127.0.0.1': { kind: 'observed', signature: WINDOWS, seenAtMs: Date.now() },
    });
    const probe = new ProxyConnectivityProbe({ dial, osObserver: observerFor(lookup) });
    const r = await probe.observeOs(PROXY, '203.0.113.9');
    if (!r.observed) throw new Error(`expected observed, got: ${r.reason}`);
    expect(r.via).toBe('proxy_host');
    expect(r.os).toBe('windows');
    expect(asked).toEqual(['203.0.113.9', '127.0.0.1']);
  });

  it('CRITICAL a record that PREDATES the connection is refused, and says so. The observer keeps the last SYN per address for 15 minutes, so a lookup by address alone answers "what did this address recently do" — and residential exit IPs rotate between customers, so that can be a different person\'s machine reported as this one with full confidence.', async () => {
    const { dial } = await fakeSocks5(0x00);
    const { lookup } = tableLookup({
      // Four minutes old: inside the observer's 15-minute window, so it is
      // served — and still not ours.
      '203.0.113.9': { kind: 'observed', signature: WINDOWS, seenAtMs: Date.now() - 240_000 },
    });
    const probe = new ProxyConnectivityProbe({ dial, osObserver: observerFor(lookup) });
    const r = await probe.observeOs(PROXY, '203.0.113.9');
    expect(r.observed).toBe(false);
    if (r.observed) throw new Error('unreachable');
    expect(r.reason).toContain('predates this connection');
    expect(r).not.toHaveProperty('os');
  });

  it('CRITICAL VACUITY CONTROL: a record stamped a moment BEFORE the dial is still accepted. `seen_at` is whole seconds against a millisecond dial, so a SYN at t=100.9 records 100 for a dial at 100.5 — a strict comparison would reject almost every real observation.', async () => {
    const { dial } = await fakeSocks5(0x00);
    const { lookup } = tableLookup({
      '203.0.113.9': { kind: 'observed', signature: DARWIN, seenAtMs: Date.now() - 900 },
    });
    const probe = new ProxyConnectivityProbe({ dial, osObserver: observerFor(lookup) });
    const r = await probe.observeOs(PROXY, '203.0.113.9');
    if (!r.observed) throw new Error(`the second-quantisation tolerance is too tight: ${r.reason}`);
    expect(r.os).toBe('macos-or-ios');
  });

  it('CRITICAL when the front door IS the exit — an ordinary datacentre SOCKS5 — the reading is labelled exit_ip, not proxy_host. Labelling it proxy_host made the client render it as an unreadable front door and suppressed a perfectly good verdict on every such proxy.', async () => {
    const { dial } = await fakeSocks5(0x00);
    const { lookup, asked } = tableLookup({
      '127.0.0.1': { kind: 'observed', signature: DARWIN, seenAtMs: Date.now() },
    });
    const probe = new ProxyConnectivityProbe({ dial, osObserver: observerFor(lookup) });
    // Exit == the address we dialled.
    const r = await probe.observeOs(PROXY, '127.0.0.1');
    if (!r.observed) throw new Error(`expected observed, got: ${r.reason}`);
    expect(r.via).toBe('exit_ip');
    expect(r.os).toBe('macos-or-ios');
    // One address, asked once — the two collapse rather than being asked twice.
    expect(asked).toEqual(['127.0.0.1']);
  });

  // ⛔ (V-219) WHICH readings are about the path a WEBSITE gets. Measured on
  // production 2026-09-15: four mobile proxies presented a Linux layout on the
  // observer port and a Darwin layout on 443, and 443 agreed with an independent
  // browserleaks reading. The web-port claim is only honest at an IP literal —
  // a NAME on 443 can be a CDN edge, a stable fingerprint of Cloudflare.
  it('CRITICAL a reading taken on 443 at an IP literal is a web-port vantage; the same port behind a NAME, or the observer port, is not', async () => {
    const at = async (host: string, port: number) => {
      const { dial } = await fakeSocks5(0x00);
      const { lookup } = tableLookup({
        '203.0.113.9': { kind: 'observed', signature: DARWIN, seenAtMs: Date.now() },
      });
      const probe = new ProxyConnectivityProbe({ dial, osObserver: { host, port, lookup } });
      const r = await probe.observeOs(PROXY, '203.0.113.9');
      if (!r.observed) throw new Error(`expected observed, got: ${r.reason}`);
      return r;
    };
    const web = await at('198.51.100.4', 443);
    expect(web.webPortVantage).toBe(true);
    expect(web.observedPort).toBe(443);
    expect((await at('fleet.example', 443)).webPortVantage, 'a name may be a CDN edge').toBe(false);
    expect((await at('198.51.100.4', 7791)).webPortVantage, 'the observer port').toBe(false);
  });

  // ⛔ (V-219) A VPN row's stack. The control plane cannot bring a tunnel up, so
  // it never dials; it reads the record a FLEET NODE caused by connecting to the
  // observer through the tunnel, under the exit the node reported, bound to the
  // dispatch instant exactly as a dialled reading is bound to its dial.
  describe('observeOsAtExit — a reading another path caused', () => {
    it("CRITICAL reads the exit's record without dialling, labels it exit_ip, never single-host, and carries the port vantage", async () => {
      const dial = vi.fn(() => Promise.reject(new Error('must not dial')));
      const { lookup, asked } = tableLookup({
        '203.0.113.9': { kind: 'observed', signature: DARWIN, seenAtMs: Date.now() },
      });
      const probe = new ProxyConnectivityProbe({
        dial,
        osObserver: { host: '198.51.100.4', port: 443, lookup },
      });
      const r = await probe.observeOsAtExit('203.0.113.9', Date.now() - 5_000);
      expect(dial).not.toHaveBeenCalled();
      if (!r.observed) throw new Error(`expected observed, got: ${r.reason}`);
      expect(asked).toEqual(['203.0.113.9']);
      expect(r.via).toBe('exit_ip');
      expect(r.singleHostVantage, 'a tunnel is more than one machine by definition').toBe(false);
      expect(r.webPortVantage).toBe(true);
      expect(r.os).toBe('macos-or-ios');
    });

    it('CRITICAL a record OLDER than the dispatch is refused — it is some earlier connection from the same exit, not the one the node just made', async () => {
      const { lookup } = tableLookup({
        '203.0.113.9': { kind: 'observed', signature: DARWIN, seenAtMs: Date.now() - 60_000 },
      });
      const probe = new ProxyConnectivityProbe({
        dial: vi.fn(),
        osObserver: { host: '198.51.100.4', port: 443, lookup },
      });
      const r = await probe.observeOsAtExit('203.0.113.9', Date.now() - 2_000);
      expect(r.observed).toBe(false);
      if (r.observed) return;
      expect(r.reason).toMatch(/predates this connection/);
    });

    it('VACUITY CONTROL — with no observer configured it looks nothing up', async () => {
      const probe = new ProxyConnectivityProbe({ dial: vi.fn() });
      expect(await probe.observeOsAtExit('203.0.113.9', 0)).toEqual({
        observed: false,
        reason: 'observer not configured',
      });
    });
  });

  it('reports NOT observed — naming both misses — when neither address has a record', async () => {
    const { dial } = await fakeSocks5(0x00);
    const { lookup } = tableLookup({});
    const probe = new ProxyConnectivityProbe({ dial, osObserver: observerFor(lookup) });
    const r = await probe.observeOs(PROXY, '203.0.113.9');
    expect(r.observed).toBe(false);
    if (r.observed) throw new Error('unreachable');
    // THE property: a miss is a miss with a reason, never a default OS.
    expect(r.reason).toContain('203.0.113.9: no SYN recorded');
    expect(r.reason).toContain('127.0.0.1: no SYN recorded');
    expect(r).not.toHaveProperty('os');
  });

  it('does not consult the observer at all when the tunnel is refused (no SYN was sent)', async () => {
    const { dial } = await fakeSocks5(0x05); // connection refused by host
    const { lookup, asked } = tableLookup({
      '127.0.0.1': { kind: 'observed', signature: DARWIN, seenAtMs: Date.now() },
    });
    const probe = new ProxyConnectivityProbe({ dial, osObserver: observerFor(lookup) });
    const r = await probe.observeOs(PROXY, '203.0.113.9');
    expect(r.observed).toBe(false);
    // A stale record under the proxy's address would otherwise be reported as
    // if this tunnel had produced it. Note the record here is FRESH — the point
    // is that no lookup happens at all, so freshness cannot be what saves us.
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

  it('CRITICAL (V-219) the lookup reads the record for the port the probe DIALLED — the observer keys per (address, port), so a probe dialled on 443 that read the bare 7791 path would bind to a connection that was never made', async () => {
    const web = fetchFor(404, { error: 'no' });
    await makeOsObserverLookup('http://127.0.0.1:7792', web.fetchImpl, undefined, 443)('10.0.0.1');
    expect(web.urls).toEqual(['http://127.0.0.1:7792/sig/10.0.0.1/443']);
    // CONTROL — the default port asks the bare path byte for byte, so nothing
    // already running asks a different question than it did.
    const obs = fetchFor(404, { error: 'no' });
    await makeOsObserverLookup('http://127.0.0.1:7792', obs.fetchImpl, undefined, 7791)('10.0.0.1');
    expect(obs.urls).toEqual(['http://127.0.0.1:7792/sig/10.0.0.1']);
  });

  it('404 is "absent", 200 is the parsed signature, anything else is an error', async () => {
    // `seen_at` is part of the observer's wire shape (observer.py writes
    // int(time.time()) on every record) and is REQUIRED here: without it a
    // signature cannot be bound to the connection that caused it.
    const SEEN_AT = 1_757_000_000;
    const WIRE = {
      ttl: 54,
      df: true,
      window: 65535,
      mss: 1460,
      wscale: 6,
      options: [2, 1, 3, 1, 1, 8, 4, 0],
      seen_at: SEEN_AT,
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
      seenAtMs: SEEN_AT * 1000,
    });
    const c = fetchFor(503, {});
    expect(
      (await makeOsObserverLookup('http://127.0.0.1:7792', c.fetchImpl)('10.0.0.1')).kind,
    ).toBe('error');
    const d = fetchFor(200, { ttl: 'x' });
    expect(
      (await makeOsObserverLookup('http://127.0.0.1:7792', d.fetchImpl)('10.0.0.1')).kind,
    ).toBe('error');
    // ⛔ A record we cannot DATE is an error, not an observation. An observer too
    // old to send `seen_at` is a deployment mismatch we want to see — accepting
    // an undatable signature would hand back a fingerprint that may belong to
    // another connection entirely, which is the whole defect this closes.
    const e = fetchFor(200, { ...WIRE, seen_at: undefined });
    expect(
      (await makeOsObserverLookup('http://127.0.0.1:7792', e.fetchImpl)('10.0.0.1')).kind,
    ).toBe('error');
    // A nonsense timestamp is refused the same way, rather than being floored
    // into some epoch that would then pass the freshness check.
    const f = fetchFor(200, { ...WIRE, seen_at: 0 });
    expect(
      (await makeOsObserverLookup('http://127.0.0.1:7792', f.fetchImpl)('10.0.0.1')).kind,
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
