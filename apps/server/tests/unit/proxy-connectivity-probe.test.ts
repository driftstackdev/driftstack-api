// Founder directive #63 — unit tests for the CP-side live proxy connectivity
// probe. The probe CONNECTs THROUGH a proxy (SOCKS5 / HTTP CONNECT) to a neutral
// target + does a real egress round-trip; on failure the launch gate maps the
// typed reason to a clean 422 (no dispatch).
//
// We don't open real outbound sockets. A local TCP server plays the role of the
// PROXY: the probe's injected dialer connects to it, the server speaks a scripted
// SOCKS5 / HTTP-CONNECT handshake + a canned egress HTTP response. This exercises
// the real handshake bytes (pass), the auth-reject framing (auth_failed), and the
// CONNECT-refused framing (egress_blocked). Connect-level failures (refused /
// timeout) use a rejecting dial stub.

import { createServer, connect, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProxyConnectivityProbe,
  ProbeDialError,
  parseExitIdentityFromResponseTail,
  exitIdentityMissDetail,
  type ProbeProxyDescriptor,
} from '../../src/services/proxy-connectivity-probe.js';

// #128 — the pure exit-identity parse used by the PEEK-ONLY capture. Given the
// buffered HTTP response tail (everything after the status line), it returns the
// identity or undefined; it must NEVER throw and never partially-accept.
describe('parseExitIdentityFromResponseTail (#128 new-tab panel capture)', () => {
  const resp = (body: string, extraHeaders = ''): Buffer =>
    Buffer.from(
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extraHeaders}\r\n${body}`,
    );

  it('captures ip/country/region/city/timezone from a complete 200 body', () => {
    const body = JSON.stringify({
      ip: '203.0.113.7',
      country: 'NL',
      region: 'North Holland',
      city: 'Amsterdam',
      timezone: 'Europe/Amsterdam',
    });
    expect(parseExitIdentityFromResponseTail(resp(body))).toEqual({
      ip: '203.0.113.7',
      country: 'NL',
      region: 'North Holland',
      city: 'Amsterdam',
      timezone: 'Europe/Amsterdam',
    });
  });

  // T-11 (exit lat/lon — A2 half of live geolocation spoofing): the parser reads the
  // exit COORDINATES back off the echo body so they can ride the assign to the box.
  // MEASURED: the echo emits `lat`/`lon` as JSON numbers only when the CF transform
  // resolved them; the body rides back THROUGH the customer's (MITM-able) proxy, so
  // the parser accepts ONLY a finite in-range number and DROPS anything else (absent,
  // never a bogus 0 — a missing fix must stay distinguishable from a real one).
  it('T-11 captures a valid lat/lon pair (vacuity control) and DROPS an out-of-range or non-numeric coordinate', () => {
    // VACUITY CONTROL: a real in-range pair must survive, or every "dropped" arm
    // below would pass against a parser that never reads a coordinate.
    const ok = parseExitIdentityFromResponseTail(
      resp(JSON.stringify({ ip: '203.0.113.7', country: 'NL', lat: 52.37, lon: 4.9 })),
    );
    expect(ok?.lat).toBe(52.37);
    expect(ok?.lon).toBe(4.9);
    // absent coordinates ⇒ the KEYS are absent (not null, not 0) so the assign frame
    // and box panel stay silent about a coordinate the edge never resolved.
    const none = parseExitIdentityFromResponseTail(
      resp(JSON.stringify({ ip: '1.2.3.4', country: 'US' })),
    );
    expect(none && 'lat' in none).toBe(false);
    expect(none && 'lon' in none).toBe(false);
    // an out-of-range latitude (999 > 90) is dropped; the valid longitude survives.
    const badLat = parseExitIdentityFromResponseTail(
      resp(JSON.stringify({ ip: '1.2.3.4', country: 'US', lat: 999, lon: 4.9 })),
    );
    expect(badLat && 'lat' in badLat).toBe(false);
    expect(badLat?.lon).toBe(4.9);
    // an out-of-range longitude (999 > 180) is dropped; the valid latitude survives.
    const badLon = parseExitIdentityFromResponseTail(
      resp(JSON.stringify({ ip: '1.2.3.4', country: 'US', lat: 52.37, lon: 999 })),
    );
    expect(badLon?.lat).toBe(52.37);
    expect(badLon && 'lon' in badLon).toBe(false);
    // a coordinate delivered as a STRING (untrusted proxy body) is not a number ⇒
    // dropped, never coerced.
    const strCoord = parseExitIdentityFromResponseTail(
      resp(JSON.stringify({ ip: '1.2.3.4', country: 'US', lat: '52.37', lon: '4.9' })),
    );
    expect(strCoord && 'lat' in strCoord).toBe(false);
    expect(strCoord && 'lon' in strCoord).toBe(false);
  });

  it("normalises country null/absent → 'XX' and missing geo → null (matches the wire contract)", () => {
    expect(
      parseExitIdentityFromResponseTail(resp(JSON.stringify({ ip: '1.2.3.4', country: null }))),
    ).toEqual({
      ip: '1.2.3.4',
      country: 'XX',
      region: null,
      city: null,
      timezone: null,
    });
  });

  it('handles a multi-byte city name (byte-correct body slice)', () => {
    const body = JSON.stringify({ ip: '9.9.9.9', country: 'BR', city: 'São Paulo' });
    expect(parseExitIdentityFromResponseTail(resp(body))?.city).toBe('São Paulo');
  });

  it('bounds untrusted field lengths from a malicious/MITM proxy body — ip>45 rejects the block; over-long region/city/timezone degrade to null (#128 hardening)', () => {
    // An "ip" longer than an IPv6 literal (45 chars) is bogus → whole block rejected.
    expect(
      parseExitIdentityFromResponseTail(
        resp(JSON.stringify({ ip: 'x'.repeat(46), country: 'US' })),
      ),
    ).toBeUndefined();
    // A 45-char value is still accepted (the IPv6-max boundary).
    const ip45 = '2'.repeat(45);
    expect(
      parseExitIdentityFromResponseTail(resp(JSON.stringify({ ip: ip45, country: 'US' })))?.ip,
    ).toBe(ip45);
    // region/city over 128 + timezone over 64 → null (no assign-wire / panel bloat).
    expect(
      parseExitIdentityFromResponseTail(
        resp(
          JSON.stringify({
            ip: '1.2.3.4',
            country: 'US',
            region: 'r'.repeat(129),
            city: 'c'.repeat(200),
            timezone: 't'.repeat(65),
          }),
        ),
      ),
    ).toEqual({ ip: '1.2.3.4', country: 'US', region: null, city: null, timezone: null });
    // At-cap values (128/128/64) are kept verbatim.
    const kept = parseExitIdentityFromResponseTail(
      resp(
        JSON.stringify({
          ip: '1.2.3.4',
          country: 'US',
          region: 'r'.repeat(128),
          city: 'c'.repeat(128),
          timezone: 't'.repeat(64),
        }),
      ),
    );
    expect(kept?.region?.length).toBe(128);
    expect(kept?.city?.length).toBe(128);
    expect(kept?.timezone?.length).toBe(64);
  });

  it('returns undefined (never throws) on partial body, no content-length, oversize, non-JSON, or missing ip', () => {
    const full = JSON.stringify({ ip: '1.2.3.4', country: 'US' });
    // body not fully buffered (Content-Length says more than present)
    expect(
      parseExitIdentityFromResponseTail(Buffer.from(`Content-Length: 999\r\n\r\n${full}`)),
    ).toBeUndefined();
    // no content-length
    expect(
      parseExitIdentityFromResponseTail(Buffer.from(`Content-Type: x\r\n\r\n${full}`)),
    ).toBeUndefined();
    // headers not terminated yet
    expect(parseExitIdentityFromResponseTail(Buffer.from('Content-Length: 5\r\n'))).toBeUndefined();
    // oversize declared
    expect(
      parseExitIdentityFromResponseTail(Buffer.from(`Content-Length: 99999\r\n\r\n${full}`)),
    ).toBeUndefined();
    // non-JSON body
    expect(parseExitIdentityFromResponseTail(resp('not json at all'))).toBeUndefined();
    // JSON but missing ip
    expect(
      parseExitIdentityFromResponseTail(resp(JSON.stringify({ country: 'US' }))),
    ).toBeUndefined();
    // empty
    expect(parseExitIdentityFromResponseTail(Buffer.alloc(0))).toBeUndefined();
  });
});

// Plaintext HTTP target (useTls=false) so the egress round-trip stays on the raw
// tunneled socket — no TLS upgrade in unit tests.
const TARGET = 'http://probe-target.test/v1/egress/echo';

const SOCKS5_PROXY: ProbeProxyDescriptor = {
  protocol: 'socks5',
  host: '127.0.0.1', // overwritten per-test with the fake-proxy port host
  port: 0,
};

const servers: Server[] = [];
// net.Server has no closeAllConnections (that's http.Server) — track accepted
// sockets ourselves so the silent-proxy timeout test doesn't leave one hanging
// and stall server.close().
const liveSockets = new Set<Socket>();

afterEach(async () => {
  for (const s of liveSockets) s.destroy();
  liveSockets.clear();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** Spin a local TCP server that runs `handler` on each connection, then return a
 *  dialer that connects to it (so the probe dials the fake proxy, not the real
 *  internet). */
async function fakeProxy(handler: (sock: Socket) => void): Promise<{
  dial: (host: string, port: number, timeoutMs: number) => Promise<Socket>;
  /** The listening port, for the arms that must exercise the DEFAULT dialler
   *  rather than an injected stub (see the last describe block). */
  port: number;
}> {
  const server = createServer((sock) => {
    liveSockets.add(sock);
    sock.on('close', () => liveSockets.delete(sock));
    handler(sock);
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const dial = (_host: string, _port: number): Promise<Socket> =>
    new Promise<Socket>((resolve, reject) => {
      const s = connect({ host: '127.0.0.1', port }, () => resolve(s));
      s.on('error', reject);
    });
  return { dial, port };
}

const EGRESS_204 = 'HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n';
const EGRESS_200 =
  'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}';

describe('ProxyConnectivityProbe — SOCKS5', () => {
  it('PASS: no-auth handshake + CONNECT success + 2xx egress round-trip → { ok: true }', async () => {
    const { dial } = await fakeProxy((sock) => {
      let step = 0;
      sock.on('data', (chunk) => {
        if (step === 0) {
          // greeting: VER=5, n methods… → choose NO-AUTH (0x00)
          expect(chunk[0]).toBe(0x05);
          sock.write(Buffer.from([0x05, 0x00]));
          step = 1;
        } else if (step === 1) {
          // CONNECT request → reply succeeded (REP=0x00) with a dummy bound addr
          expect(chunk[1]).toBe(0x01); // CMD = CONNECT
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          step = 2;
        } else {
          // tunneled HTTP GET → canned 204
          sock.write(EGRESS_204);
        }
      });
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe(SOCKS5_PROXY);
    expect(res).toEqual({ ok: true });
  });

  it('PASS: username/password auth accepted (RFC 1929 status 0x00) → { ok: true }', async () => {
    const { dial } = await fakeProxy((sock) => {
      let step = 0;
      sock.on('data', (chunk) => {
        if (step === 0) {
          // greeting advertises NO-AUTH + USER/PASS → choose USER/PASS (0x02)
          expect(Array.from(chunk.subarray(2))).toContain(0x02);
          sock.write(Buffer.from([0x05, 0x02]));
          step = 1;
        } else if (step === 1) {
          // username/password sub-negotiation → STATUS 0x00 (success)
          expect(chunk[0]).toBe(0x01); // auth VER
          sock.write(Buffer.from([0x01, 0x00]));
          step = 2;
        } else if (step === 2) {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          step = 3;
        } else {
          sock.write(EGRESS_200);
        }
      });
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe({ ...SOCKS5_PROXY, username: 'alice', password: 'pw' });
    expect(res).toEqual({ ok: true });
  });

  it('AUTH_FAILED: proxy rejects the credentials (RFC 1929 status != 0) → { ok:false, auth_failed }', async () => {
    const { dial } = await fakeProxy((sock) => {
      let step = 0;
      sock.on('data', () => {
        if (step === 0) {
          sock.write(Buffer.from([0x05, 0x02])); // choose USER/PASS
          step = 1;
        } else {
          sock.write(Buffer.from([0x01, 0x01])); // STATUS=0x01 → bad creds
          step = 2;
        }
      });
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe({ ...SOCKS5_PROXY, username: 'alice', password: 'wrong' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('auth_failed');
  });

  it('AUTH_FAILED: proxy offers no acceptable method (0xff) → { ok:false, auth_failed }', async () => {
    const { dial } = await fakeProxy((sock) => {
      sock.on('data', () => sock.write(Buffer.from([0x05, 0xff])));
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe(SOCKS5_PROXY);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('auth_failed');
  });

  // V-1402 — the method byte is the PROXY's choice, not ours. With no credentials
  // configured the greeting advertises NO-AUTH only, so a proxy selecting 0x02 or
  // GSSAPI has answered with something it was never offered. Both refusals were dark.
  it('AUTH_FAILED: a proxy selects USERNAME/PASSWORD when we advertised only NO-AUTH → refused, naming the missing configuration. The credential reads below this point are casts (`proxy.username as string`), so this guard is what makes them safe: without it an unadvertised 0x02 reaches Buffer.from(undefined) and the customer gets `egress_blocked` carrying a Node type error instead of the one reason they can act on.', async () => {
    const { dial } = await fakeProxy((sock) => {
      sock.on('data', () => sock.write(Buffer.from([0x05, 0x02])));
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });

    const res = await probe.probe(SOCKS5_PROXY); // deliberately no username/password

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('auth_failed');
    expect(
      res.detail,
      'the detail must name the missing configuration; a bare auth_failed here is indistinguishable from wrong credentials, which is the opposite fix',
    ).toMatch(/none was configured/);
  });

  it('UNREACHABLE: a proxy selects an auth method we never advertised (GSSAPI 0x01) → refused, naming the method. Falling through instead would send CONNECT to a proxy still waiting to negotiate, and the probe would report a timeout after the full budget rather than the mismatch it can already see.', async () => {
    const { dial } = await fakeProxy((sock) => {
      sock.on('data', () => sock.write(Buffer.from([0x05, 0x01])));
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });

    const res = await probe.probe(SOCKS5_PROXY);

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unreachable');
    expect(res.detail).toMatch(/unsupported auth method \(0x1\)/);
  });

  it('EGRESS_BLOCKED: CONNECT reply REP != 0 (proxy connected but upstream failed) → { ok:false, egress_blocked }', async () => {
    const { dial } = await fakeProxy((sock) => {
      let step = 0;
      sock.on('data', () => {
        if (step === 0) {
          sock.write(Buffer.from([0x05, 0x00]));
          step = 1;
        } else {
          // REP=0x05 connection refused by destination host
          sock.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          step = 2;
        }
      });
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe(SOCKS5_PROXY);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('egress_blocked');
  });

  it('UNREACHABLE: first byte is not SOCKS5 version 5 (not a SOCKS5 proxy) → { ok:false, unreachable }', async () => {
    const { dial } = await fakeProxy((sock) => {
      sock.on('data', () => sock.write(Buffer.from([0x04, 0x00]))); // SOCKS4-ish / garbage
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe(SOCKS5_PROXY);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unreachable');
  });

  it('PASS: tunnel established + egress GET returns 5xx (round-trip completed → egress works) → { ok: true }', async () => {
    // New ANY-response-passes semantics: a 5xx from the target endpoint STILL
    // proves the proxy tunneled to the internet and the round-trip completed. We
    // validate proxy connectivity, not the endpoint's HTTP status.
    const { dial } = await fakeProxy((sock) => {
      let step = 0;
      sock.on('data', () => {
        if (step === 0) {
          sock.write(Buffer.from([0x05, 0x00]));
          step = 1;
        } else if (step === 1) {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          step = 2;
        } else {
          sock.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
        }
      });
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe(SOCKS5_PROXY);
    expect(res).toEqual({ ok: true });
  });

  it('PASS: tunnel established + egress GET returns 429 (rate-limited echo, healthy proxy) → { ok: true }', async () => {
    // The exact false-block this redesign fixes: the CF-fronted, per-exit-IP
    // rate-limited echo returns 429 to a healthy proxy on a shared/burst exit. The
    // 429 round-trip proves egress works → PASS (was egress_blocked → 422 block).
    const { dial } = await fakeProxy((sock) => {
      let step = 0;
      sock.on('data', () => {
        if (step === 0) {
          sock.write(Buffer.from([0x05, 0x00]));
          step = 1;
        } else if (step === 1) {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          step = 2;
        } else {
          sock.write('HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n');
        }
      });
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe(SOCKS5_PROXY);
    expect(res).toEqual({ ok: true });
  });

  it('PASS: tunnel established + egress GET returns 403 (CF challenge to flagged exit IP) → { ok: true }', async () => {
    const { dial } = await fakeProxy((sock) => {
      let step = 0;
      sock.on('data', () => {
        if (step === 0) {
          sock.write(Buffer.from([0x05, 0x00]));
          step = 1;
        } else if (step === 1) {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          step = 2;
        } else {
          sock.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
        }
      });
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe(SOCKS5_PROXY);
    expect(res).toEqual({ ok: true });
  });

  it('PASS (CF non-HTTP body): tunnel established but the egress target returns a NON-HTTP line → ok:true (tunnel-proven reachability)', async () => {
    // The CONNECT/tunnel succeeded (REP 0x00), which already proves the proxy
    // reached the target host:port over the internet. A non-HTTP body from a
    // CF-fronted echo target on a flagged exit IP must NOT hard-block a working
    // proxy — the round-trip reaching the target endpoint at all is the proof.
    const { dial } = await fakeProxy((sock) => {
      let step = 0;
      sock.on('data', () => {
        if (step === 0) {
          sock.write(Buffer.from([0x05, 0x00]));
          step = 1;
        } else if (step === 1) {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          step = 2;
        } else {
          // Not an HTTP status line — a terminated line of garbage, then close.
          sock.write('NOT-HTTP garbage\r\n');
          sock.end();
        }
      });
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe(SOCKS5_PROXY);
    expect(res.ok).toBe(true);
  });

  it('PASS (CF hard-drop): tunnel established but the egress target RESETS the connection before any response → ok:true (not a false egress_blocked)', async () => {
    // The Cloudflare-fronted echo target silently drops (TCP reset) a flagged exit
    // IP instead of returning an HTTP status. The CONNECT already proved egress
    // reachability, so the drop during the GET must NOT block the launch.
    const { dial } = await fakeProxy((sock) => {
      let step = 0;
      sock.on('data', () => {
        if (step === 0) {
          sock.write(Buffer.from([0x05, 0x00]));
          step = 1;
        } else if (step === 1) {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          step = 2;
        } else {
          // No response bytes at all — close (reset) the moment the GET arrives.
          sock.destroy();
        }
      });
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe(SOCKS5_PROXY);
    expect(res.ok).toBe(true);
  });
});

describe('the exit identity survives a body that arrives late (V-2154)', () => {
  const IDENTITY_BODY = JSON.stringify({
    ip: '203.0.113.7',
    country: 'NL',
    region: 'North Holland',
    city: 'Amsterdam',
    timezone: 'Europe/Amsterdam',
  });

  /** A SOCKS5 proxy whose tunneled origin answers the GET in TWO writes: the head
   *  first, the body `bodyDelayMs` later. That is what a TLS-fronted origin through
   *  a remote proxy actually does — and it is precisely what the old peek-only
   *  capture could not see. */
  function splitBodyProxy(bodyDelayMs: number): Promise<{
    dial: (host: string, port: number, timeoutMs: number) => Promise<Socket>;
  }> {
    return fakeProxy((sock) => {
      let step = 0;
      sock.on('data', (chunk) => {
        if (step === 0) {
          expect(chunk[0]).toBe(0x05);
          sock.write(Buffer.from([0x05, 0x00]));
          step = 1;
        } else if (step === 1) {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          step = 2;
        } else {
          sock.write(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${String(
              Buffer.byteLength(IDENTITY_BODY),
            )}\r\n\r\n`,
          );
          setTimeout(() => sock.write(IDENTITY_BODY), bodyDelayMs);
        }
      });
    });
  }

  it('⛔ captures the identity when the body lands AFTER the status line, not before', async () => {
    // The old capture peeked whatever was buffered the instant the status line
    // parsed, so this returned no identity — and because the identity is baked into
    // the box fork's env once at launch, every new tab in the session then read
    // "No exit IP" with an empty panel for the session's whole life.
    const { dial } = await splitBodyProxy(120);
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe(SOCKS5_PROXY);
    expect(res.ok).toBe(true);
    expect(res.exitIdentity).toEqual({
      ip: '203.0.113.7',
      country: 'NL',
      region: 'North Holland',
      city: 'Amsterdam',
      timezone: 'Europe/Amsterdam',
    });
  });

  it('⛔ V-2167: a late body near the DEADLINE still passes — the tail wait is clamped', async () => {
    // The unclamped defect: the tail wait held a fixed 1.5s cap while the outer
    // `Promise.race` in `probe()` was armed with whatever budget remained. When the
    // deadline fired mid-wait, the race settled with the deadline's REJECTION —
    // and the PASS already decided from the 200 status line never left the round
    // trip. Net effect: a WORKING proxy, hard-blocked at launch as
    // `{ok:false, reason:'timeout'}`, because we waited for a cosmetic panel field.
    //
    // Reproduce it exactly: a probe whose total budget (600ms) is smaller than the
    // tail cap (1500ms), against a proxy that answers the handshake + status line
    // fast and then delays the body past the deadline. The clamp keeps the wait
    // below the deadline, so the probe must PASS with no identity — never time out.
    const { dial } = await splitBodyProxy(60_000);
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET, timeoutMs: 600 });
    const res = await probe.probe(SOCKS5_PROXY);
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(res.exitIdentity).toBeUndefined();
    expect(res.detail).toMatch(/exit identity unavailable/);
  });

  it('a body that never arrives still PASSES the probe — the verdict is already decided', async () => {
    // The invariant the bounded wait must not break: waiting for a panel field can
    // never turn a working proxy into a failed launch.
    const { dial } = await splitBodyProxy(60_000);
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe(SOCKS5_PROXY);
    expect(res.ok).toBe(true);
    expect(res.exitIdentity).toBeUndefined();
    // …and it says WHY, so the miss is diagnosable server-side instead of only
    // showing up as an empty panel on someone's phone.
    expect(res.detail).toMatch(/exit identity unavailable/);
  }, 15_000);
});

describe('exitIdentityMissDetail names the reason a 200 carried no identity', () => {
  it('separates a chunked response from a slow one — outage vs race', () => {
    const chunked = Buffer.from(
      'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1a\r\n{}',
    );
    // Chunked fails the parse EVERY time, so it is a permanent outage, not a race.
    expect(exitIdentityMissDetail(chunked)).toMatch(/chunked/);

    const noLength = Buffer.from('Content-Type: application/json\r\n\r\n{}');
    expect(exitIdentityMissDetail(noLength)).toMatch(/no content-length/);

    const headless = Buffer.from('Content-Type: application/js');
    expect(exitIdentityMissDetail(headless)).toMatch(/headers did not arrive/);

    const truncated = Buffer.from('Content-Length: 99\r\n\r\n{"ip":"1.2');
    expect(exitIdentityMissDetail(truncated)).toMatch(/incomplete or unparseable/);
  });
});

describe('ProxyConnectivityProbe — HTTP CONNECT', () => {
  const HTTP_PROXY: ProbeProxyDescriptor = { protocol: 'http', host: '127.0.0.1', port: 0 };

  it('PASS: 200 CONNECT + 2xx egress round-trip → { ok: true }', async () => {
    const { dial } = await fakeProxy((sock) => {
      let connected = false;
      sock.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (!connected && text.startsWith('CONNECT')) {
          sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          connected = true;
        } else {
          sock.write(EGRESS_204);
        }
      });
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe(HTTP_PROXY);
    expect(res).toEqual({ ok: true });
  });

  it('AUTH_FAILED: 407 Proxy Authentication Required → { ok:false, auth_failed }', async () => {
    const { dial } = await fakeProxy((sock) => {
      sock.on('data', () =>
        sock.write('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'),
      );
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe({ ...HTTP_PROXY, username: 'a', password: 'b' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('auth_failed');
  });

  it('EGRESS_BLOCKED: CONNECT 502 (proxy reached but upstream refused) → { ok:false, egress_blocked }', async () => {
    const { dial } = await fakeProxy((sock) => {
      sock.on('data', () => sock.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'));
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe(HTTP_PROXY);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('egress_blocked');
  });
});

describe('ProxyConnectivityProbe — connect-level failures (rejecting dial stub)', () => {
  const PROXY: ProbeProxyDescriptor = { protocol: 'socks5', host: '203.0.113.9', port: 1080 };

  it('UNREACHABLE: dial rejects with connection-refused → { ok:false, unreachable }', async () => {
    const dial = (): Promise<Socket> =>
      Promise.reject(new ProbeDialError('unreachable', 'ECONNREFUSED'));
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe(PROXY);
    expect(res).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('TIMEOUT: dial rejects with a classified timeout → { ok:false, timeout }', async () => {
    const dial = (): Promise<Socket> =>
      Promise.reject(new ProbeDialError('timeout', 'connect timed out'));
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe(PROXY);
    expect(res).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('UNREACHABLE: a plain (unclassified) dial error defaults to unreachable', async () => {
    const dial = (): Promise<Socket> => Promise.reject(new Error('getaddrinfo ENOTFOUND'));
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });
    const res = await probe.probe(PROXY);
    expect(res).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('TIMEOUT: a proxy that connects but never answers the handshake trips the deadline', async () => {
    const { dial } = await fakeProxy(() => {
      /* accept the socket, then say nothing — the post-connect deadline fires */
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET, timeoutMs: 80 });
    const res = await probe.probe({ protocol: 'socks5', host: '127.0.0.1', port: 0 });
    expect(res).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('TIMEOUT (not masked as a CF PASS): a proxy that completes CONNECT then HANGS on the GET still trips the deadline', async () => {
    // The CF hard-drop softening (a connection RESET before the response → PASS)
    // must NOT mask a genuinely hung proxy: when the probe's own deadline destroys
    // the socket, the read-close is deadline-triggered and must surface as `timeout`.
    const { dial } = await fakeProxy((sock) => {
      let step = 0;
      sock.on('data', () => {
        if (step === 0) {
          sock.write(Buffer.from([0x05, 0x00]));
          step = 1;
        } else if (step === 1) {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          step = 2;
        }
        // step 2 (the GET): say NOTHING — hang until the deadline destroys the socket.
      });
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET, timeoutMs: 80 });
    const res = await probe.probe(SOCKS5_PROXY);
    expect(res).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('SINGLE DEADLINE: a slow dial + a silent handshake times out within ~one budget, not two', async () => {
    // Regression for the double-applied-deadline bug: the budget must be ONE
    // wall-clock window across dial + post-connect, not `timeoutMs` per phase. A
    // dial that consumes most of the budget then a silent proxy must trip the
    // deadline shortly after the dial resolves — total ≈ budget, not ≈ 2× budget.
    const BUDGET = 300;
    const DIAL_DELAY = 220;
    const { dial: rawDial } = await fakeProxy(() => {
      /* accept then stay silent — relies on the post-connect deadline */
    });
    // Wrap the dialer to take DIAL_DELAY before resolving the socket.
    const slowDial = (host: string, port: number, timeoutMs: number): Promise<Socket> =>
      new Promise<Socket>((resolve, reject) => {
        setTimeout(() => {
          rawDial(host, port, timeoutMs).then(resolve, reject);
        }, DIAL_DELAY);
      });
    const probe = new ProxyConnectivityProbe({
      dial: slowDial,
      targetUrl: TARGET,
      timeoutMs: BUDGET,
    });
    const startedAt = Date.now();
    const res = await probe.probe({ protocol: 'socks5', host: '127.0.0.1', port: 0 });
    const elapsed = Date.now() - startedAt;
    expect(res).toMatchObject({ ok: false, reason: 'timeout' });
    // The post-connect window is BUDGET - DIAL_DELAY (≈80ms), not a fresh BUDGET.
    // Total must be well under 2× BUDGET; generous ceiling for CI jitter.
    expect(elapsed).toBeLessThan(BUDGET + DIAL_DELAY);
  });
});

// V-1401 — three guards on this probe that no injected dialler can reach.
//
// Every arm above supplies its own `dial`, which is what makes them deterministic — and
// also means the PRODUCTION dialler has never run: coverage put the whole body of
// `defaultDial` in the never-executed set, including its post-connect SSRF re-check. Two
// more guards were dark for the same reason, both on the reader that consumes bytes from
// a customer-supplied proxy: the 256 KiB buffer cap, and the reason split that decides
// whether an unparseable CONNECT reply reads as `unreachable` or `egress_blocked`.
//
// The proxy host here is customer-supplied (`account_proxies.host`), so all three sit on
// attacker-influenced input.
describe('ProxyConnectivityProbe — guards an injected dialler cannot reach', () => {
  const HTTP_PROXY: ProbeProxyDescriptor = { protocol: 'http', host: '127.0.0.1', port: 0 };

  it('CRITICAL the DEFAULT dialler refuses a proxy whose CONNECTED PEER is an internal address. The literal-host guard runs before DNS, so a customer host that is a DOMAIN resolving inward slips it; socket.remoteAddress after connect is the real resolved IP, and this is the only place that sees it. Every other arm in this file injects a dialler and therefore skips it entirely.', async () => {
    // No `dial` dep — this is the dialler bootstrap uses.
    const { port } = await fakeProxy(() => {
      /* never speaks: the refusal must happen at dial time, before any protocol byte */
    });
    const probe = new ProxyConnectivityProbe({ targetUrl: TARGET, timeoutMs: 2_000 });

    const res = await probe.probe({ ...HTTP_PROXY, port });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unreachable');
    expect(
      res.detail,
      'the refusal must be the peer-address guard and not a generic dial failure — otherwise this arm passes on any connection that simply did not work',
    ).toMatch(/resolved to internal address/);
  });

  it('CRITICAL a proxy that answers CONNECT with a NON-HTTP head is reported `unreachable`, not `egress_blocked`. The two mean different things to the customer — nothing is speaking HTTP on that port, versus a working proxy refusing the destination — and the SDKs branch on the reason.', async () => {
    const { dial } = await fakeProxy((sock) => {
      // e.g. the host/port was pointed at an SSH daemon rather than a proxy.
      sock.on('data', () => sock.write('SSH-2.0-OpenSSH_9.6\r\n\r\n'));
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });

    const res = await probe.probe(HTTP_PROXY);

    expect(res.ok).toBe(false);
    expect(
      res.reason,
      'no three-digit status could be parsed, so there is no evidence a proxy answered at all',
    ).toBe('unreachable');
  });

  it('CRITICAL a proxy that floods the probe with unframed bytes is cut off at the buffer cap rather than buffered without bound. The probe dials a customer-supplied host, so the far end chooses how much to send and whether to ever send a delimiter; without the cap a single probe grows until the process does.', async () => {
    const { dial } = await fakeProxy((sock) => {
      // No CRLFCRLF anywhere, so `readUntil` can never complete on its own.
      sock.on('data', () => sock.write(Buffer.alloc(300 * 1024, 0x41)));
    });
    const probe = new ProxyConnectivityProbe({ dial, targetUrl: TARGET });

    const res = await probe.probe(HTTP_PROXY);

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('egress_blocked');
    expect(
      res.detail,
      'the cap must be what ended it — a deadline expiry here would mean the flood was buffered for the whole budget, which is the thing the cap exists to prevent',
    ).toMatch(/exceeded probe buffer cap/);
  });
});
