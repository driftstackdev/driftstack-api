// W714 — server-side request-id + V-251 IP rate-limit middleware
// parity. Forty-first in the cross-SDK drift-guard series (W649 +
// W675-W714).
//
// Pins two pre-auth-layer middleware files as authoritative:
//
//   apps/server/src/middleware/request-id.ts — onSend hook setting
//     `x-request-id` response header from request.id (correlation
//     with the `instance` field on RFC 7807 problem responses).
//
//   apps/server/src/middleware/ip-rate-limit.ts — V-251 / V-246-P1-
//     004 IP-keyed gate on the 6 unauthenticated auth endpoints
//     (login / signup / verify-email / password-reset-request /
//     resend-verification / status-subscribe). Distinct from
//     account-keyed app.rateLimit. AUTH_IP_LIMITS roster pins the
//     per-endpoint capacity + refillPerSecond.
//
// CRITICAL invariants:
//   1. Request-id flows out on EVERY response (success + error) so
//      customers can correlate logs.
//   2. Missing req.ip shares one bounded unresolved-client bucket —
//      no identity means less precision, never no enforcement.
//   3. AUTH_IP_LIMITS 6 entries match documented capacities:
//      login 10/min, signup 5/min, verifyEmail 10/min,
//      passwordResetRequest 3/min, resendVerification 3/min,
//      statusSubscribe 3/min.
//   4. IP-rate-limit emits the same W199/W200 4-header set as the
//      account-keyed limiter (consistent client surface).
//   5. IP NOT leaked in response headers — only the prefix is set.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const REQUEST_ID = resolve(REPO_ROOT, 'apps/server/src/middleware/request-id.ts');
const IP_RATE_LIMIT = resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts');

describe('W714 server-side request-id + V-251 IP rate-limit middleware parity', () => {
  it('both middleware files exist', () => {
    expect(existsSync(REQUEST_ID), `missing ${REQUEST_ID}`).toBe(true);
    expect(existsSync(IP_RATE_LIMIT), `missing ${IP_RATE_LIMIT}`).toBe(true);
  });

  // --- request-id middleware --------------------------------------

  it('CRITICAL request-id middleware applies onSend hook setting x-request-id from request.id. Drift to omitting would break correlation between server logs and client-facing problem.instance values (W711 RFC 7807 instance pinning).', () => {
    const src = read(REQUEST_ID);
    expect(src).toMatch(/app\.addHook\('onSend',/);
    expect(src).toMatch(/reply\.header\('x-request-id', request\.id\)/);
  });

  it('CRITICAL request-id middleware framing pinned — "trust an inbound x-request-id header if present, otherwise generate". The header-trust pattern is what lets upstream proxies (CDN, load-balancer) propagate trace IDs into our logs. Drift to never-trust would break distributed tracing.', () => {
    const src = read(REQUEST_ID);
    expect(src).toMatch(
      /Request ID propagation: trust an inbound `x-request-id` header if present,\s*\n?\/\/\s*otherwise generate one/,
    );
  });

  it("CRITICAL request-id wrapped with fastify-plugin (fp) and named 'request-id'. The plugin-name is what other plugins reference for dependency ordering. Drift to dropping `name` would break fp dependency resolution.", () => {
    const src = read(REQUEST_ID);
    expect(src).toMatch(/export default fp\(requestIdPlugin, \{ name: 'request-id' \}\)/);
  });

  // --- ip-rate-limit middleware -----------------------------------

  it('CRITICAL V-251 / V-246-P1-004 anchor pinned on ip-rate-limit header. The anchor threads the founder-direction-2026-05-07 override (P1-004 deferral OVERRIDDEN per launch-blocking) into the changelog. Drift to dropping would lose the override provenance.', () => {
    const src = read(IP_RATE_LIMIT);
    expect(src).toMatch(/V-251 \/ V-246-P1-004/);
    expect(src).toMatch(/founder direction 2026-05-07/);
    expect(src).toMatch(/P1-004 deferral OVERRIDDEN/);
    expect(src).toMatch(/brute-force protection is launch-blocking/);
  });

  it('CRITICAL distinct-from-account-rateLimit framing pinned. The framing tells engineers app.rateLimit is for POST-auth (account-keyed) while ipRateLimit is for PRE-auth (IP-keyed). Drift to merging would let unauthenticated endpoints hit the account-keyed limiter (which then 401s because no account).', () => {
    const src = read(IP_RATE_LIMIT);
    expect(src).toMatch(
      /Distinct from `app\.rateLimit\(bucketKey\)` which is\s*\n?\/\/\s*account-keyed/,
    );
  });

  it('CRITICAL unresolved-IP behavior pinned: missing identity shares a bounded sentinel bucket instead of bypassing enforcement.', () => {
    const src = read(IP_RATE_LIMIT);

    // Documented behavior comment.
    expect(src).toMatch(/When `req\.ip` is empty[\s\S]{0,240}`unresolved-client` identity/);

    // Implementation matches.
    expect(src).toMatch(
      /const ip =\s*typeof req\.ip === 'string' && req\.ip\.trim\(\)\.length > 0 \? req\.ip : 'unresolved-client';/,
    );
  });

  it('CRITICAL token-bucket store.consume() call shape pinned — 5 fields: key (prefix:ip) + capacity + refillPerSecond + cost=1 + now (hoisted into consumeArgs so the same args feed the bounded fallback on a store error). The shape mirrors the same primitive the account-keyed limiter uses (RateLimitStore); drift would force a second token-bucket implementation.', () => {
    const src = read(IP_RATE_LIMIT);

    expect(src).toMatch(
      /const consumeArgs = \{\s*key: `\$\{cfg\.bucketPrefix\}:\$\{ip\}`,\s*capacity: cfg\.capacity,\s*refillPerSecond: cfg\.refillPerSecond,\s*cost: 1,\s*now: Date\.now\(\),\s*\}/,
    );
    expect(src).toContain('result = await store.consume(consumeArgs);');
  });

  it('CRITICAL W200 4-header response set pinned — x-ratelimit-bucket / -limit / -remaining / -reset (same as W199 account-keyed limiter). Consistency across IP + account limiters is what lets dashboards render rate-limit state uniformly.', () => {
    const src = read(IP_RATE_LIMIT);

    expect(src).toMatch(/reply\.header\('x-ratelimit-bucket', cfg\.bucketPrefix\)/);
    expect(src).toMatch(/reply\.header\('x-ratelimit-limit', cfg\.capacity\.toString\(\)\)/);
    expect(src).toMatch(
      /reply\.header\('x-ratelimit-remaining', Math\.floor\(result\.remaining\)\.toString\(\)\)/,
    );
    expect(src).toMatch(
      /reply\.header\('x-ratelimit-reset', \(nowSec \+ secondsToFull\)\.toString\(\)\)/,
    );
  });

  it('CRITICAL IP-not-leaked invariant pinned — header carries the bucket PREFIX only, not the resolved IP. Drift to exposing `${prefix}:${ip}` in the response header would let attackers learn their own IP-as-seen-by-the-server (useful for reconnaissance behind NAT/CDN/proxy).', () => {
    const src = read(IP_RATE_LIMIT);
    expect(src).toMatch(
      /we expose only the prefix to avoid\s*\n?\/\/\s*leaking the resolved IP through the response/,
    );
    // The header uses cfg.bucketPrefix (NOT the IP-suffixed key).
    expect(src).toMatch(/reply\.header\('x-ratelimit-bucket', cfg\.bucketPrefix\)/);
  });

  it('CRITICAL retry-after seconds-not-ms with Math.max(1, ...) clamp pinned. Mirrors W713 account-keyed limiter; drift to ms would mislead clients about retry timing.', () => {
    const src = read(IP_RATE_LIMIT);
    expect(src).toMatch(/Math\.max\(1, Math\.ceil\(result\.retryAfterMs \/ 1000\)\)/);
    expect(src).toMatch(/reply\.header\('retry-after', retryAfterSec\.toString\(\)\)/);
  });

  it('CRITICAL 5-field warn log on rate-limit hit pinned — component + bucket_prefix + ip + tokens_remaining + retry_after_ms. The `ip` field IS in the log (not the response header) — server-side observability vs. client-side avoidance of leak. Drift to dropping `ip` would lose the abuse-detection signal.', () => {
    const src = read(IP_RATE_LIMIT);
    expect(src).toMatch(/component: 'ip-rate-limit'/);
    expect(src).toMatch(/bucket_prefix: cfg\.bucketPrefix/);
    expect(src).toMatch(/ip,/);
    expect(src).toMatch(/tokens_remaining: Math\.floor\(result\.remaining\)/);
    expect(src).toMatch(/retry_after_ms: result\.retryAfterMs/);
    expect(src).toMatch(/'ip rate-limit exceeded on auth endpoint'/);
  });

  it('CRITICAL RateLimitedError thrown with 2-arg shape — retryAfterSec + detail. Mirrors the W713 account-keyed limiter behavior; drift to dropping the retry-after seconds arg would lose the Retry-After-header propagation chain.', () => {
    const src = read(IP_RATE_LIMIT);
    expect(src).toMatch(
      /throw new RateLimitedError\(\s*retryAfterSec,\s*`Too many requests from this IP\. Retry in \$\{retryAfterSec\.toString\(\)\}s\.`/,
    );
  });

  it('CRITICAL AUTH_IP_LIMITS 20-endpoint roster pinned with capacity + refillPerSecond per endpoint, including a 60/min/IP budget for the public SLA aggregate.', () => {
    const src = read(IP_RATE_LIMIT);

    const limits: Array<[string, number]> = [
      ['login', 10],
      ['signup', 5],
      ['verifyEmail', 10],
      ['passwordResetRequest', 3],
      ['resendVerification', 3],
      ['magicLink', 3],
      ['statusSubscribe', 3],
      ['oauthClientStart', 5],
      ['oauthClientCallback', 5],
      ['oauthClientConfirmMerge', 5],
      ['statusIncidentsList', 60],
      ['statusIncidentDetail', 60],
      ['statusSla', 60],
      ['oauthProvider', 60],
      ['magicLinkConsume', 10],
      ['passwordResetConfirm', 10],
      ['refresh', 60],
      ['logout', 10],
      ['cliAuthorizeInitiate', 5],
      ['cliAuthorizeExchange', 60],
    ];

    for (const [name, capacity] of limits) {
      // capacity: N, refillPerSecond: N / 60
      const re = new RegExp(
        `${name}: \\{ capacity: ${capacity}, refillPerSecond: ${capacity} \\/ 60 \\}`,
      );
      expect(src, `AUTH_IP_LIMITS.${name} capacity=${capacity}`).toMatch(re);
    }
  });

  it('CRITICAL "1-minute window" sustained-rate framing pinned across all 21 AUTH_IP_LIMITS entries.', () => {
    const src = read(IP_RATE_LIMIT);

    // All 21 entries use the same `/ 60` divisor (statusSnapshot added with the
    // GET /v1/status gate).
    const refillEntries = src.match(/refillPerSecond: \d+ \/ 60/g) ?? [];
    expect(refillEntries.length, '/ 60 sustained-rate uses').toBe(21);
  });

  it('CRITICAL AUTH_IP_LIMITS object is `as const` for literal-type narrowing. The `as const` is what lets TypeScript treat each entry as a readonly literal record (vs. a mutable record). Drift to dropping would let callers accidentally mutate the const.', () => {
    const src = read(IP_RATE_LIMIT);
    expect(src).toMatch(/AUTH_IP_LIMITS = \{[\s\S]+?\} as const;/);
  });

  it('CRITICAL V-295c3 status-subscribe rationale pinned — "tighter than signup because we don\'t create a paying account, and the form is explicitly anonymous (no captcha layer); easier abuse vector". The V-295c3 anchor threads the rationale into the changelog.', () => {
    const src = read(IP_RATE_LIMIT);
    expect(src).toMatch(/V-295c3[\s\S]{0,500}status-page email subscribe/);
    expect(src).toMatch(/Tighter than\s*\n?\/\/\s*signup because we don't create a paying account/);
  });

  it("CRITICAL imports pinned — RateLimitedError from ../lib/errors.js (canonical taxonomy). Drift to importing from elsewhere would let ip-rate-limit diverge from W710's roster.", () => {
    const src = read(IP_RATE_LIMIT);
    expect(src).toMatch(/import \{ RateLimitedError \} from '\.\.\/lib\/errors\.js'/);
  });

  it('Server pre-auth middleware invariant cluster — request-id onSend + fp wrap + V-251 anchor + unresolved-IP bucket + AUTH_IP_LIMITS roster + ip-not-leaked + retry-after-seconds.', () => {
    const rid = read(REQUEST_ID);
    const ipRl = read(IP_RATE_LIMIT);

    expect(rid).toMatch(/onSend/);
    expect(rid).toMatch(/x-request-id/);
    expect(rid).toMatch(/fp\(requestIdPlugin/);

    expect(ipRl).toMatch(/V-251/);
    expect(ipRl).toMatch(/AUTH_IP_LIMITS = \{/);
    expect(ipRl).toMatch(/RateLimitedError/);
    expect(ipRl).toMatch(/leaking the resolved IP through the response/);
    expect(ipRl).toMatch(/Math\.max\(1, Math\.ceil/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/server-request-id-ip-rate-limit-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
