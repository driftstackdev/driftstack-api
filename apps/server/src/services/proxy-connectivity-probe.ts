// Founder directive #63 — CP-side LIVE proxy connectivity probe.
//
// "A proxy must be TESTED LIVE + validated BEFORE a profile launch — not just
// asked. If the live test fails, BLOCK the launch with a clean specific error —
// zero session dispatched, zero simulator spin-up."
//
// This is the server-side half. Given an already-resolved proxy (host / port /
// protocol / credentials — the output of AccountProxiesService.resolveForDispatch,
// owner-scoped + decrypted + SSRF-guarded), it CONNECTs THROUGH the proxy to a
// stable neutral target and performs a real egress round-trip (a tiny HTTP GET).
// It returns a typed result the launch gate maps to a clean 422 on failure or a
// dispatch on success.
//
// Distinct from the GUI-side device probe (docs/internal/2026-06-12-proxy-probe-
// backend-design.md): THAT probes device-only, locally-stored proxies through the
// native Rust layer (privacy promise — never uploaded). THIS probes the SEPARATE
// org-level proxy population the customer uploaded to the control plane on purpose
// (account_proxies, resolved at dispatch). The design doc itself flags this as the
// distinct "server-side probing of session-wired proxies … with consent" path —
// uploading a proxy to the CP for dispatch IS that consent.
//
// Reuse, don't reinvent: the SocksProxyBackend already does a raw TCP CONNECT
// pre-flight (proxy-backends/socks5.ts). That catches "wrong host/port/firewall"
// but NOT "the proxy speaks SOCKS5", "the credentials are right", or "the proxy
// can actually reach the internet". This probe goes the rest of the way — a full
// SOCKS5 (or HTTP CONNECT) handshake plus an egress round-trip — which is exactly
// what the founder asked for: validate the proxy WORKS, not just that the port is
// open.
//
// Forward-compatible with A3's W2931 (post-dispatch box-reported egress failure):
// the same { ok, reason } shape + the same ProxyValidationFailedError problem-type
// surface a box-reported launch failure the same clean way. See the route gate.

import { connect, type Socket } from 'node:net';
import { classifyUnsafeHost } from '../lib/webhook-target-guard.js';

/** Default neutral egress target. The Driftstack-owned exit-IP echo
 *  (GET /v1/egress/echo) is the design-doc-recommended endpoint (option A):
 *  Driftstack-operated (no third-party leak of customer exit IPs), tiny 2xx
 *  response, already the established convention. Overridable via env so the
 *  target can be retuned without a code change. */
export const DEFAULT_PROBE_TARGET_URL = 'https://api.driftstack.dev/v1/egress/echo';

/** Overall per-probe deadline — ONE wall-clock budget across the WHOLE live test
 *  (TCP connect + proxy handshake + egress round-trip), not per-phase. A
 *  slow/half-open proxy that blows the budget is a `timeout` failure, not a hung
 *  launch. Bumped from the original 6s: real residential/mobile proxies (the exact
 *  kind anti-detect customers use) routinely take 6-7 RTT at ~700-900ms each, so 6s
 *  false-failed slow-but-working proxies. 12s gives them room while still bounding
 *  launch latency. Env-tunable via DRIFTSTACK_PROXY_PROBE_TIMEOUT_MS. */
export const DEFAULT_PROBE_TIMEOUT_MS = 12_000;

/** Machine-readable failure enum. Mirrors ProxyValidationFailedError's `reason`
 *  so the route gate maps one to the other 1:1, and A3's W2931 box-reported
 *  failure can reuse the same vocabulary. */
export type ProxyProbeReason = 'unreachable' | 'auth_failed' | 'timeout' | 'egress_blocked';

/** #128 — the exit identity the world sees THROUGH the proxy, parsed best-effort
 *  from a clean 200 /v1/egress/echo body. Feeds the box-local new-tab IP panel
 *  (exit_identity dispatch block). `country` is ISO-3166 alpha-2 or 'XX' (the echo
 *  returns null for unknown; we normalise to 'XX' to match the wire contract);
 *  region/city/timezone are best-effort (null when the CF edge couldn't resolve). */
export interface ProbeExitIdentity {
  ip: string;
  country: string;
  region: string | null;
  city: string | null;
  timezone: string | null;
}

export interface ProxyProbeResult {
  ok: boolean;
  reason?: ProxyProbeReason;
  /** Human one-liner for logs / the 422 detail. Never contains credentials. */
  detail?: string;
  /** #128 best-effort exit identity captured from the echo round-trip. Present
   *  ONLY when the proxy returned a clean, fully-buffered 200 JSON body; undefined
   *  otherwise. Capture may wait briefly for the body, but the wait is clamped
   *  below the probe's own deadline, so it can never flip the ok/reason
   *  connectivity verdict — a launch is never blocked by its absence. */
  exitIdentity?: ProbeExitIdentity;
}

/** Pure, no-I/O parse of the exit identity from the already-buffered HTTP response
 *  tail (everything after the status line). Returns undefined on ANY deviation —
 *  incomplete buffer, no Content-Length, oversize, non-JSON, missing ip. Never
 *  throws. Kept a free function so it's unit-testable without a socket. */
export function parseExitIdentityFromResponseTail(tail: Buffer): ProbeExitIdentity | undefined {
  try {
    const sep = tail.indexOf('\r\n\r\n'); // byte-wise; header block is ASCII
    if (sep === -1) return undefined; // headers not fully buffered
    const headerBlock = tail.subarray(0, sep).toString('utf8');
    const clMatch = /content-length:\s*(\d+)/i.exec(headerBlock);
    if (!clMatch) return undefined;
    const len = Number(clMatch[1]);
    if (!Number.isInteger(len) || len <= 0 || len > 4096) return undefined; // echo body is tiny
    const bodyStart = sep + 4;
    if (tail.length - bodyStart < len) return undefined; // body not fully buffered yet
    const parsed: unknown = JSON.parse(tail.subarray(bodyStart, bodyStart + len).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const o = parsed as Record<string, unknown>;
    // Length caps — the body is our OWN echo endpoint's, but it rides back THROUGH
    // the customer's (attacker-influenceable / MITM-able) proxy, so treat every
    // field as untrusted. An IPv6 literal maxes at 45 chars; a bogus over-long "ip"
    // invalidates the whole block. region/city/timezone over their sane ceilings
    // degrade to null rather than bloating the assign wire frame + the box panel.
    if (typeof o.ip !== 'string' || o.ip.length === 0 || o.ip.length > 45) return undefined;
    const str = (v: unknown, max: number): string | null =>
      typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
    const country =
      typeof o.country === 'string' && /^[A-Z]{2}$/.test(o.country) ? o.country : 'XX';
    return {
      ip: o.ip,
      country,
      region: str(o.region, 128),
      city: str(o.city, 128),
      timezone: str(o.timezone, 64),
    };
  } catch {
    return undefined;
  }
}

/** Is the buffered tail a COMPLETE HTTP response?
 *
 * ⛔ This is the stopping condition for the capture wait, and it is deliberately NOT
 * "did the identity parse". A complete body that simply carries no `ip` (our echo
 * answers `{}` when Cloudflare's visitor-location headers are off) is a finished
 * answer, not a slow one — waiting on it would burn the whole cap on the launch path
 * for a response that already arrived. Completeness is what the wait is for;
 * usefulness is the parser's business. */
export function isResponseTailComplete(tail: Buffer): boolean {
  const sep = tail.indexOf('\r\n\r\n');
  if (sep === -1) return false;
  const headerBlock = tail.subarray(0, sep).toString('utf8');
  const clMatch = /content-length:\s*(\d+)/i.exec(headerBlock);
  // No content-length (e.g. chunked) — nothing here can say when the body ends, so
  // do not spin: report complete and let the parser refuse it, with
  // `exitIdentityMissDetail` naming chunked as the cause.
  if (!clMatch) return true;
  const len = Number(clMatch[1]);
  if (!Number.isInteger(len) || len < 0) return true;
  return tail.length - (sep + 4) >= len;
}

/** How long the probe waits for the echo body AFTER the connectivity verdict is
 *  already decided. Small on purpose: this sits on the launch path, and a missing
 *  panel field costs far less than a slow launch. ⛔ A CEILING, not the wait: the
 *  actual wait is clamped below the probe's own deadline (minus the margin below),
 *  because the outer `Promise.race` in `probe()` REJECTS when that deadline fires —
 *  an unclamped 1.5s tail wait after a slow dial turned an already-decided PASS
 *  into `{ok:false, reason:'timeout'}` and hard-blocked launches on working
 *  proxies. */
const EXIT_IDENTITY_TAIL_CAP_MS = 1_500;

/** Headroom kept between the tail wait and the probe deadline so the round-trip's
 *  `return {ok:true}` wins the race against the deadline rejection. */
const EXIT_IDENTITY_DEADLINE_MARGIN_MS = 100;

/** Name WHY a 200 produced no exit identity. The failure was previously invisible —
 *  it surfaced only as "No exit IP" on the device, with nothing server-side to
 *  separate "headers never arrived" (a race) from "no content-length" (a chunked
 *  response fails the parse EVERY time, a permanent outage). Those must not look
 *  alike to whoever reads the probe result next. */
export function exitIdentityMissDetail(tail: Buffer): string {
  const sep = tail.indexOf('\r\n\r\n');
  if (sep === -1) return 'exit identity unavailable: response headers did not arrive in time';
  const headerBlock = tail.subarray(0, sep).toString('utf8');
  if (!/content-length:\s*\d+/i.test(headerBlock)) {
    return /transfer-encoding:\s*chunked/i.test(headerBlock)
      ? 'exit identity unavailable: echo response was chunked (no content-length), which the parser cannot read'
      : 'exit identity unavailable: echo response carried no content-length';
  }
  return 'exit identity unavailable: body incomplete or unparseable within the capture window';
}

/** The minimal resolved-proxy shape the probe needs. A superset of
 *  SocksProxyConfig (host/port/username/password) plus the protocol. The launch
 *  gate adapts AccountProxiesService.resolveForDispatch's output into this. VPN
 *  (openvpn/wireguard) schemes are NOT probed here — they tunnel at the box, not
 *  via a CP-dialable proxy protocol; the gate skips the probe for them (see the
 *  route). */
export interface ProbeProxyDescriptor {
  protocol: 'socks5' | 'http';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ProxyConnectivityProbeDeps {
  /** Injectable dialer — opens a RAW TCP socket to (host, port). Tests pass a
   *  deterministic stub (a paired in-memory socket / a rejecting one) so unit
   *  tests never open real sockets. Default uses node:net connect(). */
  dial?: (host: string, port: number, timeoutMs: number) => Promise<Socket>;
  /** Probe deadline; default 6000ms. */
  timeoutMs?: number;
  /** Neutral egress target URL; default the Driftstack echo. */
  targetUrl?: string;
}

/** Default dialer: a RAW TCP connect with a bounded deadline. Re-asserts the
 *  connection-time SSRF guard (the SocksProxyBackend's defaultTcpProbe does the
 *  same): a customer host that is a DOMAIN resolving to an internal IP slips the
 *  literal-host guard, but the connected peer address is the real resolved IP —
 *  reject it so the probe never reaches Driftstack's internal network. */
function defaultDial(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host, port }, () => {
      clearTimeout(timer);
      const peer = socket.remoteAddress;
      if (peer !== undefined && classifyUnsafeHost(peer) !== null) {
        socket.destroy();
        reject(
          new ProbeDialError('unreachable', `proxy host resolved to internal address ${peer}`),
        );
        return;
      }
      resolve(socket);
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ProbeDialError('timeout', `timed out connecting to ${host}:${port}`));
    }, timeoutMs);
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(new ProbeDialError('unreachable', err.message));
    });
  });
}

/** A dial failure that already carries a classified probe reason (so the default
 *  dialer can distinguish "timed out connecting" from "connection refused"). */
export class ProbeDialError extends Error {
  constructor(
    readonly reason: ProxyProbeReason,
    detail: string,
  ) {
    super(detail);
    this.name = 'ProbeDialError';
  }
}

/**
 * CP-side live proxy connectivity probe. One public method, `probe`, returns a
 * typed pass/fail. Never throws for an expected failure (unreachable / auth /
 * timeout / egress-blocked) — those are `{ ok: false, reason }` so the gate maps
 * them to a clean 422. A genuinely unexpected internal error (bug) propagates so
 * it isn't silently swallowed into a false "ok".
 */
export class ProxyConnectivityProbe {
  private readonly dial: (host: string, port: number, timeoutMs: number) => Promise<Socket>;
  private readonly timeoutMs: number;
  private readonly target: URL;

  constructor(deps: ProxyConnectivityProbeDeps = {}) {
    this.dial = deps.dial ?? defaultDial;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.target = new URL(deps.targetUrl ?? DEFAULT_PROBE_TARGET_URL);
  }

  async probe(proxy: ProbeProxyDescriptor): Promise<ProxyProbeResult> {
    const targetHost = this.target.hostname;
    const targetPort = this.target.port !== '' ? Number(this.target.port) : 443;
    const useTls = this.target.protocol === 'https:';

    // ONE wall-clock deadline across the WHOLE probe (dial + handshake + round-
    // trip), not a fresh `timeoutMs` per phase. Previously `this.timeoutMs` was
    // spent on dial AND again on the post-connect exchange → worst case ~2× the
    // promised budget. We track elapsed and bound the post-connect phase by what
    // remains so a slow-connecting-then-slow-handshaking proxy can't double-spend.
    const startedAt = Date.now();

    let socket: Socket;
    try {
      socket = await this.dial(proxy.host, proxy.port, this.timeoutMs);
    } catch (err) {
      if (err instanceof ProbeDialError) {
        return { ok: false, reason: err.reason, detail: err.message };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: 'unreachable', detail: message };
    }

    // A single deadline spans the whole post-connect exchange (handshake +
    // egress round-trip), bounded by the budget REMAINING after the dial. On
    // expiry, destroy the socket → any pending read rejects → `timeout`. Floor at
    // a small positive value so a dial that already consumed the budget still
    // gives the handshake a brief chance rather than firing instantly.
    const remainingMs = Math.max(this.timeoutMs - (Date.now() - startedAt), 250);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Shared deadline state so the egress round-trip can tell a deadline-triggered
    // socket close (→ honest `timeout`) apart from a target-side connection RESET
    // before the deadline (→ tunnel-proven PASS, the Cloudflare hard-drop case).
    const deadlineState = { expired: false, deadlineAt: Date.now() + remainingMs };
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        deadlineState.expired = true;
        socket.destroy();
        reject(new ProbeDialError('timeout', `proxy did not complete the round-trip in time`));
      }, remainingMs);
    });

    try {
      const result = await Promise.race([
        proxy.protocol === 'socks5'
          ? this.runSocks5RoundTrip(socket, proxy, targetHost, targetPort, useTls, deadlineState)
          : this.runHttpRoundTrip(socket, proxy, targetHost, targetPort, useTls, deadlineState),
        deadline,
      ]);
      return result;
    } catch (err) {
      if (err instanceof ProbeDialError) {
        return { ok: false, reason: err.reason, detail: err.message };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: 'egress_blocked', detail: message };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      socket.destroy();
    }
  }

  // ── SOCKS5 ────────────────────────────────────────────────────────────────
  // RFC 1928 greeting + (RFC 1929) username/password auth + CONNECT, then the
  // egress round-trip over the tunneled socket.
  private async runSocks5RoundTrip(
    socket: Socket,
    proxy: ProbeProxyDescriptor,
    targetHost: string,
    targetPort: number,
    useTls: boolean,
    deadlineState: { expired: boolean; deadlineAt: number },
  ): Promise<ProxyProbeResult> {
    const reader = new SocketReader(socket);
    const hasAuth = proxy.username !== undefined && proxy.password !== undefined;

    // Greeting: VER=5, advertise NO-AUTH (0x00) and, when we have creds,
    // USERNAME/PASSWORD (0x02).
    const methods = hasAuth ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));
    const methodSel = await reader.read(2);
    if (methodSel[0] !== 0x05) {
      return { ok: false, reason: 'unreachable', detail: 'not a SOCKS5 proxy (bad version byte)' };
    }
    const chosen = methodSel[1] ?? 0xff;
    if (chosen === 0xff) {
      // No acceptable method — the proxy wants auth we didn't (or couldn't) offer.
      return {
        ok: false,
        reason: 'auth_failed',
        detail: 'proxy requires authentication that was not supplied',
      };
    }
    if (chosen === 0x02) {
      if (!hasAuth) {
        return {
          ok: false,
          reason: 'auth_failed',
          detail: 'proxy demanded username/password auth but none was configured',
        };
      }
      const user = Buffer.from(proxy.username as string, 'utf8');
      const pass = Buffer.from(proxy.password as string, 'utf8');
      socket.write(Buffer.from([0x01, user.length, ...user, pass.length, ...pass]));
      const authResp = await reader.read(2);
      // RFC 1929: STATUS 0x00 = success; anything else = bad credentials.
      if ((authResp[1] ?? 0xff) !== 0x00) {
        return { ok: false, reason: 'auth_failed', detail: 'proxy rejected the credentials' };
      }
    } else if (chosen !== 0x00) {
      return {
        ok: false,
        reason: 'unreachable',
        detail: `proxy selected an unsupported auth method (0x${chosen.toString(16)})`,
      };
    }

    // CONNECT to the target by DOMAINNAME (ATYP 0x03) so DNS resolves at the
    // proxy's exit — matches the dispatch's require_remote_dns posture (no local
    // resolver leak) and probes the proxy's own egress resolver.
    const hostBytes = Buffer.from(targetHost, 'utf8');
    const req = Buffer.from([
      0x05, // VER
      0x01, // CMD = CONNECT
      0x00, // RSV
      0x03, // ATYP = DOMAINNAME
      hostBytes.length,
      ...hostBytes,
      (targetPort >> 8) & 0xff,
      targetPort & 0xff,
    ]);
    socket.write(req);
    // Reply: VER REP RSV ATYP + BND.ADDR + BND.PORT. Read the fixed head then the
    // variable address by ATYP.
    const replyHead = await reader.read(4);
    const rep = replyHead[1] ?? 0xff;
    if (rep !== 0x00) {
      // REP != succeeded. 0x05 = connection refused by host, etc. — the proxy
      // reached the upstream attempt but egress failed.
      return {
        ok: false,
        reason: 'egress_blocked',
        detail: `proxy CONNECT failed (SOCKS5 reply 0x${rep.toString(16)})`,
      };
    }
    const atyp = replyHead[3];
    const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : ((await reader.read(1))[0] ?? 0);
    await reader.read(addrLen + 2); // BND.ADDR + BND.PORT, discarded

    return this.egressRoundTrip(socket, reader, targetHost, targetPort, useTls, deadlineState);
  }

  // ── HTTP CONNECT ────────────────────────────────────────────────────────────
  // For an HTTP proxy: issue an HTTP CONNECT to tunnel to the target, then the
  // egress round-trip over the tunnel.
  private async runHttpRoundTrip(
    socket: Socket,
    proxy: ProbeProxyDescriptor,
    targetHost: string,
    targetPort: number,
    useTls: boolean,
    deadlineState: { expired: boolean; deadlineAt: number },
  ): Promise<ProxyProbeResult> {
    const reader = new SocketReader(socket);
    const authority = `${targetHost}:${targetPort}`;
    let connectReq = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`;
    if (proxy.username !== undefined && proxy.password !== undefined) {
      const creds = Buffer.from(`${proxy.username}:${proxy.password}`, 'utf8').toString('base64');
      connectReq += `Proxy-Authorization: Basic ${creds}\r\n`;
    }
    connectReq += '\r\n';
    socket.write(connectReq);

    const head = await reader.readUntil('\r\n\r\n');
    const statusLine = head.split('\r\n')[0] ?? '';
    const statusMatch = /\s(\d{3})\s/.exec(` ${statusLine} `);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    if (status === 407 || status === 401) {
      return { ok: false, reason: 'auth_failed', detail: 'proxy rejected the credentials (407)' };
    }
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        reason: status === 0 ? 'unreachable' : 'egress_blocked',
        detail: `proxy CONNECT returned "${statusLine.trim()}"`,
      };
    }

    return this.egressRoundTrip(socket, reader, targetHost, targetPort, useTls, deadlineState);
  }

  // ── egress round-trip ─────────────────────────────────────────────────────
  // Over the now-tunneled socket, do a real HTTP request to the neutral target.
  // We validate PROXY CONNECTIVITY, not the target endpoint's HTTP status: if ANY
  // HTTP response status line comes back (2xx/3xx OR 4xx/5xx — incl. 429/403/503),
  // the proxy demonstrably tunneled to the internet, completed the request and
  // returned the upstream's bytes → egress WORKS → PASS.
  //
  // The CONNECT/tunnel succeeding (REP 0x00 / HTTP 2xx, asserted by the callers
  // before reaching here) ALREADY proves the proxy reached the target host:port
  // over the internet. So a target-side connection RESET or a NON-HTTP body during
  // the GET — the Cloudflare-fronted-echo hard-drop case, where CF silently drops a
  // flagged/blocklisted exit IP instead of returning a status — is NOT an egress
  // failure: it's tunnel-proven reachability, so we PASS rather than false-block a
  // working proxy. The ONLY post-tunnel failure surfaced is the probe's OWN deadline
  // expiring (a genuinely hung proxy → `timeout`), which the `deadlineState` guard
  // distinguishes from a target-side drop.
  //
  // Why not require 2xx/3xx: the default target (api.driftstack.dev/v1/egress/echo)
  // is rate-limited per exit IP AND Cloudflare-fronted, so a healthy proxy on a
  // shared/datacenter/flagged exit legitimately receives a 429 (rate limit) or a
  // 403/503 (CF challenge) — and that response STILL proves the round-trip
  // completed. Requiring 2xx/3xx coupled every proxied launch to Cloudflare's bot
  // scoring of the customer's proxy and false-blocked working proxies.
  //
  // We send a bare HTTP/1.1 GET; for an https target this would need a TLS
  // handshake over the tunnel, which a raw socket can't do alone — so we upgrade
  // with node:tls when useTls. Tests inject a paired socket that answers the GET
  // directly (the dial stub), so the TLS upgrade only runs against a real https
  // target.
  private async egressRoundTrip(
    socket: Socket,
    reader: SocketReader,
    targetHost: string,
    _targetPort: number,
    useTls: boolean,
    deadlineState: { expired: boolean; deadlineAt: number },
  ): Promise<ProxyProbeResult> {
    let stream: Socket = socket;
    let streamReader: SocketReader = reader;
    if (useTls) {
      // Upgrade the tunneled socket to TLS (SNI = target host). Lazy-import so the
      // unit tests (which use a plaintext paired socket + useTls=false) don't pull
      // node:tls. Any handshake failure = the proxy's egress can't complete TLS.
      const tls = await import('node:tls');
      stream = await new Promise<Socket>((resolve, reject) => {
        const tlsSocket = tls.connect({ socket, servername: targetHost }, () => resolve(tlsSocket));
        tlsSocket.on('error', (err: Error) =>
          reject(new ProbeDialError('egress_blocked', err.message)),
        );
      });
      streamReader = new SocketReader(stream);
    }

    const reqPath = this.target.pathname + this.target.search;
    stream.write(
      `GET ${reqPath} HTTP/1.1\r\nHost: ${targetHost}\r\nUser-Agent: driftstack-proxy-probe\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
    );
    // Read the response status line. A connection CLOSE/RESET before the response
    // arrives (SocketReader throws a ProbeDialError) is the Cloudflare-fronted-
    // echo-target hard-drop case: a perfectly working proxy whose exit IP is on a
    // CF-challenged/blocklisted range gets its connection silently dropped (TCP
    // reset) instead of an HTTP status — even though the proxy reaches the rest of
    // the internet fine. By the time we get here the CONNECT/tunnel ALREADY
    // succeeded (SOCKS5 REP 0x00 / HTTP 2xx), which itself proves the proxy reached
    // the target host:port over the internet, so a CF drop during the GET must NOT
    // hard-block the launch. Treat it as PASS (tunnel-proven reachability) rather
    // than a false egress_blocked. (A TLS handshake failure is a DIFFERENT,
    // genuine egress failure — it rejects above, before this read, and is unaffected.)
    let head: string;
    try {
      head = await streamReader.readUntil('\r\n');
    } catch (err) {
      // Distinguish a deadline-triggered socket close (the probe's own timer
      // destroyed the socket → honest `timeout`, do NOT mask a genuinely slow/hung
      // proxy) from a target-side connection RESET before the deadline (CF hard-drop
      // → tunnel-proven PASS).
      if (deadlineState.expired) {
        return {
          ok: false,
          reason: 'timeout',
          detail: 'proxy did not complete the round-trip in time',
        };
      }
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: true,
        detail: `tunnel established; egress target dropped the GET (${detail}) — treated as reachable`,
      };
    }
    const statusMatch = /HTTP\/1\.[01]\s(\d{3})/.exec(head);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    // ANY parseable HTTP status back = the proxy tunneled to the internet and the
    // round-trip completed → egress works → PASS. A 4xx/5xx (incl. 429 rate-limit,
    // 403/503 CF challenge) from the target endpoint proves connectivity just as
    // much as a 2xx does; the proxy is fine even if our echo endpoint throttled or
    // challenged this exit IP.
    if (status === 200) {
      // #128 — best-effort capture of the exit identity from the echo body.
      //
      // ⛔ This used to peek `snapshot()` with no await, on the assumption that "a
      // tiny Connection:close response arrives in one TCP segment". Through a real
      // remote proxy with a TLS upgrade that does not hold: the body frequently had
      // not arrived when the status line parsed, the parse returned undefined,
      // nothing was cached, and — because the identity is baked into the box fork's
      // environment ONCE at launch — every new tab in that session then showed
      // "No exit IP" and an empty panel for the life of the session.
      //
      // So wait for it, but briefly and never fatally. `awaitTail` cannot throw —
      // but the wait itself CAN lose the outer `Promise.race` in `probe()`: when
      // the probe deadline fires mid-wait, the race settles with the deadline's
      // REJECTION and the PASS decided above never leaves this function. So the
      // cap is clamped below whatever deadline budget remains (a non-positive
      // clamp makes `awaitTail` an immediate peek), keeping the verdict's
      // invariant true instead of asserted.
      const tailCapMs = Math.min(
        EXIT_IDENTITY_TAIL_CAP_MS,
        deadlineState.deadlineAt - Date.now() - EXIT_IDENTITY_DEADLINE_MARGIN_MS,
      );
      const tail = await streamReader.awaitTail(isResponseTailComplete, tailCapMs);
      const exitIdentity = parseExitIdentityFromResponseTail(tail);
      // A 200 that yields no identity is the exact silent failure above. Name it in
      // `detail` so a miss is diagnosable server-side instead of only surfacing as an
      // empty panel on the device.
      if (exitIdentity) return { ok: true, exitIdentity };
      // Name the miss ONLY when the response never completed — that is the silent
      // failure this fix exists for. A complete body carrying no `ip` is the echo
      // endpoint's own answer, with a different cause (visitor-location headers),
      // and must not be dressed up as a capture failure.
      return isResponseTailComplete(tail)
        ? { ok: true }
        : { ok: true, detail: exitIdentityMissDetail(tail) };
    }
    if (status > 0) {
      return { ok: true };
    }
    // No parseable status line — the proxy returned garbage (non-HTTP) bytes for the
    // GET. The CONNECT/tunnel already proved the proxy reached the target host:port
    // over the internet, so (like the connection-drop case above) this must not
    // hard-block a working proxy whose CF-fronted egress target returned a non-HTTP
    // body. PASS on tunnel-proven reachability rather than a false egress_blocked.
    return {
      ok: true,
      detail:
        'tunnel established; egress target returned a non-HTTP response — treated as reachable',
    };
  }
}

/**
 * Buffered reader over a node Socket. The probe needs to read EXACT byte counts
 * (SOCKS5 framing) and read-until-delimiter (HTTP head) off a stream that delivers
 * arbitrary chunks. This collects incoming data and resolves reads as enough
 * arrives; a socket close/error before a read completes rejects it (mapped to a
 * probe failure by the caller).
 */
class SocketReader {
  /** Hard cap on the in-memory read buffer. The probe only ever needs a SOCKS5
   *  handshake (tens of bytes) + one tiny HTTP response (status line + headers +
   *  a ≤4096-byte echo body) — a few KB total. 256 KiB is a very generous ceiling.
   *  A proxy the customer wired to the CP is attacker-influenceable (or MITM-able),
   *  and without a cap a malicious/abusive proxy can stream unbounded bytes into CP
   *  memory for the whole ~6s deadline window (and concurrent creates amplify it).
   *  On overflow we fail the read CLOSED (the probe returns a failure → the launch
   *  is BLOCKED), which is the correct verdict: a proxy that floods isn't usable. */
  private static readonly MAX_BUFFER_BYTES = 256 * 1024;

  private buf: Buffer = Buffer.alloc(0);
  private waiter: (() => void) | null = null;
  private closed = false;
  private errored: Error | null = null;

  constructor(socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      if (this.buf.length + chunk.length > SocketReader.MAX_BUFFER_BYTES) {
        // Abusive volume with no valid framing → stop buffering, tear down, and mark
        // errored so pending + future reads reject cleanly (mapped to a probe failure
        // by the caller). Idempotent: keep the first error if one already latched.
        this.errored ??= new Error(
          `proxy response exceeded probe buffer cap (${SocketReader.MAX_BUFFER_BYTES} bytes)`,
        );
        socket.destroy();
        this.wake();
        return;
      }
      this.buf = Buffer.concat([this.buf, chunk]);
      this.wake();
    });
    socket.on('end', () => {
      this.closed = true;
      this.wake();
    });
    socket.on('close', () => {
      this.closed = true;
      this.wake();
    });
    socket.on('error', (err: Error) => {
      this.errored = err;
      this.wake();
    });
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  /** #128 — non-consuming peek of the currently-buffered bytes (no await). Lets the
   *  exit-identity capture read the already-arrived echo body without extending the
   *  deadline-raced path, so it can never delay/flip the connectivity verdict. */
  snapshot(): Buffer {
    return this.buf;
  }

  /**
   * Wait — bounded — until `done(buf)` holds, the peer closes, or `capMs` elapses,
   * then return the buffer as it stands. NEVER throws and never consumes.
   *
   * ⛔ Why: the exit identity used to be read with `snapshot()` alone, a peek of
   * whatever bytes happened to be buffered the instant the STATUS LINE parsed. The
   * parser needs the whole header block, a content-length, AND the entire body.
   * Through a real remote proxy with a TLS upgrade, headers and body routinely land
   * in separate records, so the peek saw a partial response and the identity came
   * back undefined. That miss is not recoverable: the identity is baked into the box
   * fork's environment ONCE at launch, so one miss leaves every new tab in the
   * session reading "No exit IP" for the session's whole life.
   *
   * The connectivity verdict is ALREADY decided when this runs, and that is the
   * invariant it protects: a slow, truncated or absent tail degrades to "no
   * identity", never to a failed probe. This function's half is the no-throwing
   * path and honoring `capMs` (non-positive = immediate peek); the CALLER's half
   * is clamping `capMs` below the probe deadline, without which the outer race
   * rejects mid-wait and the decided PASS is lost.
   */
  async awaitTail(done: (buf: Buffer) => boolean, capMs: number): Promise<Buffer> {
    const deadline = Date.now() + capMs;
    for (;;) {
      if (done(this.buf)) return this.buf;
      if (this.errored !== null || this.closed) return this.buf;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return this.buf;
      let timer: NodeJS.Timeout | undefined;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        timer = setTimeout(resolve, remaining);
      });
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Read EXACTLY n bytes (consuming them from the buffer). */
  async read(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (this.errored !== null) throw new ProbeDialError('egress_blocked', this.errored.message);
      if (this.closed)
        throw new ProbeDialError('egress_blocked', 'proxy closed the connection mid-handshake');
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Read until `delimiter` appears, returning everything up to AND including it. */
  async readUntil(delimiter: string): Promise<string> {
    const delim = Buffer.from(delimiter, 'utf8');
    for (;;) {
      const idx = this.buf.indexOf(delim);
      if (idx !== -1) {
        const end = idx + delim.length;
        const out = this.buf.subarray(0, end).toString('utf8');
        this.buf = this.buf.subarray(end);
        return out;
      }
      if (this.errored !== null) throw new ProbeDialError('egress_blocked', this.errored.message);
      if (this.closed)
        throw new ProbeDialError('egress_blocked', 'proxy closed the connection before a response');
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}
