// W982 — ip-rate-limit V-251 + V-246-P1-004 cross-source invariant.
// Three-hundred-eighth in the drift-guard series. Pins the apps/
// server/src/middleware/ip-rate-limit.ts pre-auth IP gating primitive:
//
//   V-251 / V-246-P1-004 anchor — 'V-251 / V-246-P1-004 — IP-based
//   rate limiting on unauthenticated auth endpoints'.
//
//   Pre-auth-no-account framing — 'Distinct from app.rateLimit(
//   bucketKey) which is account-keyed (post-auth). The four auth-flow
//   endpoints (signup / login / verify-email / password-reset) take
//   requests where the customer doesn't have an account+key yet, so
//   account-key rate limiting is impossible. IP-keyed gating is the
//   standard pre-auth abuse-mitigation surface'.
//
//   Founder-override framing — 'Per founder direction 2026-05-07
//   (P1-004 deferral OVERRIDDEN): brute-force protection is launch-
//   blocking. Wire in basic IP gates; fancier (CAPTCHA on threshold
//   breach, exponential backoff per IP) is post-launch'.
//
//   Token-bucket-reuse framing — 'Implementation reuses the existing
//   RateLimitStore (token bucket with capacity + refillPerSecond) —
//   same primitive the account-keyed limiter uses, just with an IP-
//   derived bucket key. Memory store in tests; Redis store in
//   production'.
//
//   IpRateLimitConfig 3-field shape — bucketPrefix + capacity +
//     refillPerSecond.
//
//   Bucket-key shape — '${prefix}:${ip}'.
//
//   ipRateLimit factory signature — '(store: RateLimitStore, cfg:
//     IpRateLimitConfig) => preHandler'.
//
//   Unresolved-IP framing — 'req.ip extracted via Fastify's
//   resolution (honors trust-proxy when set; falls back to socket).
//   When req.ip is empty, requests share one non-sensitive sentinel
//   bucket so missing identity cannot bypass enforcement'.
//
//   W200 4-header set — x-ratelimit-bucket (prefix-only) +
//     x-ratelimit-limit + x-ratelimit-remaining + x-ratelimit-reset.
//     Mirrors W199 account-keyed middleware. Critical: 'bucket here
//     is the configured prefix; consumers shouldn't depend on the IP
//     suffix being visible in the header (we expose only the prefix
//     to avoid leaking the resolved IP through the response)'.
//
//   Exceeded path — retryAfterSec = max(1, ceil(retryAfterMs / 1000))
//     + retry-after header + warn log with 5 fields + throw
//     RateLimitedError.
//
//   5-field warn log — component:'ip-rate-limit' + bucket_prefix +
//     ip + tokens_remaining + retry_after_ms.
//
//   AUTH_IP_LIMITS 7-entry map per V-251 verdict + #190 follow-up:
//     - login: 10/min.
//     - signup: 5/min.
//     - verifyEmail: 10/min.
//     - passwordResetRequest: 3/min.
//     - resendVerification: 3/min.
//     - magicLink: 3/min (#190 — added 2026-05-15; closed the
//       gap where /v1/auth/magic-link/request was unprotected).
//     - V-295c3 statusSubscribe: 3/min.
//
// stays in lockstep across apps/server/src/middleware/ip-rate-limit.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_IP_LIMITS } from '../../src/middleware/ip-rate-limit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W982 ip-rate-limit V-251 cross-source invariant', () => {
  // ─── V-251 / V-246-P1-004 anchor ─────────────────────────────

  it("CRITICAL apps/server/src/middleware/ip-rate-limit.ts header pins V-251 / V-246-P1-004 anchor — 'V-251 / V-246-P1-004 — IP-based rate limiting on unauthenticated auth endpoints'. The dual-V-anchor is the cross-source policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts'));
    expect(p).toMatch(/V-251 \/ V-246-P1-004 — IP-based rate limiting on unauthenticated/);
    expect(p).toMatch(/auth endpoints\./);
  });

  // ─── Pre-auth-no-account framing ─────────────────────────────

  it("CRITICAL pre-auth-no-account framing — 'Distinct from app.rateLimit(bucketKey) which is account-keyed (post-auth). The four auth-flow endpoints (signup / login / verify-email / password-reset) take requests where the customer doesn't have an account+key yet, so account-key rate limiting is impossible. IP-keyed gating is the standard pre-auth abuse-mitigation surface'. The 4-pre-auth-endpoint + no-account-key + IP-keyed-gate design is the V-251 abuse-mitigation contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts'));
    expect(p).toMatch(/Distinct from `app\.rateLimit\(bucketKey\)` which is/);
    expect(p).toMatch(/account-keyed \(post-auth\)\. The four auth-flow endpoints/);
    expect(p).toMatch(/\(signup \/ login \/ verify-email \/ password-reset\) take requests/);
    expect(p).toMatch(/where the customer doesn't have an account\+key yet, so account-key/);
    expect(p).toMatch(/rate limiting is impossible\. IP-keyed gating is the standard/);
    expect(p).toMatch(/pre-auth abuse-mitigation surface\./);
  });

  // ─── Founder-override framing ────────────────────────────────

  it("CRITICAL founder-override framing — 'Per founder direction 2026-05-07 (P1-004 deferral OVERRIDDEN): brute-force protection is launch-blocking. Wire in basic IP gates; fancier (CAPTCHA on threshold breach, exponential backoff per IP) is post-launch'. The 2026-05-07-override + basic-now + fancy-post-launch design is the V-251 phased-mitigation timeline.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts'));
    expect(p).toMatch(/Per founder direction 2026-05-07 \(P1-004 deferral OVERRIDDEN\):/);
    expect(p).toMatch(/brute-force protection is launch-blocking\. Wire in basic IP gates;/);
    expect(p).toMatch(/fancier \(CAPTCHA on threshold breach, exponential backoff per IP\)/);
    expect(p).toMatch(/is post-launch\./);
  });

  // ─── Token-bucket reuse framing ──────────────────────────────

  it("CRITICAL token-bucket-reuse framing — 'Implementation reuses the existing RateLimitStore (token bucket with capacity + refillPerSecond) — same primitive the account-keyed limiter uses, just with an IP-derived bucket key. Memory store in tests; Redis store in production'. The shared-store + IP-keyed-bucket design avoids re-implementing the token-bucket primitive.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts'));
    expect(p).toMatch(/Implementation reuses the existing `RateLimitStore` \(token bucket/);
    expect(p).toMatch(/with capacity \+ refillPerSecond\) — same primitive the account-keyed/);
    expect(p).toMatch(/limiter uses, just with an IP-derived bucket key\. Memory store in/);
    expect(p).toMatch(/tests; Redis store in production\./);
  });

  // ─── IpRateLimitConfig 3-field shape ─────────────────────────

  it('CRITICAL IpRateLimitConfig has 3 fields — bucketPrefix + capacity + refillPerSecond. The 3-config-knob shape is what callers (per-endpoint factories) bind.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts'));
    expect(p).toMatch(/export interface IpRateLimitConfig \{/);
    expect(p).toMatch(/bucketPrefix: string;/);
    expect(p).toMatch(/capacity: number;/);
    expect(p).toMatch(/refillPerSecond: number;/);
  });

  // ─── Bucket-key shape ────────────────────────────────────────

  it("CRITICAL bucket-key shape — '${prefix}:${ip}'. The colon-delimited shape keeps prefix lookups in dashboards trivial.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts'));
    expect(p).toMatch(/Bucket-key prefix; final key is `\$\{prefix\}:\$\{ip\}`\./);
    expect(p).toMatch(/key: `\$\{cfg\.bucketPrefix\}:\$\{ip\}`,/);
  });

  // ─── Unresolved-IP framing ───────────────────────────────────

  it('CRITICAL unresolved-IP framing — missing identity shares one non-sensitive bucket, preserving a bounded availability budget without bypassing enforcement.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts'));
    expect(p).toMatch(/When `req\.ip` is empty/);
    expect(p).toMatch(/`unresolved-client` identity/);
    expect(p).toMatch(/without letting a missing identity bypass the gate\./);
  });

  it('CRITICAL unresolved-IP guard uses trimmed non-empty req.ip or the shared sentinel and has no early-return bypass.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts'));
    expect(p).toMatch(
      /const ip =\s*typeof req\.ip === 'string' && req\.ip\.trim\(\)\.length > 0 \? req\.ip : 'unresolved-client';/,
    );
    expect(p).not.toMatch(/if \(ip === null\)/);
  });

  // ─── W200 4-header set ───────────────────────────────────────

  it("CRITICAL W200 prefix-only-not-IP-in-header framing — 'W200 — full RateLimit-header set documented at /docs/rate-limits. Mirrors the account-keyed middleware (W199). bucket here is the configured prefix; consumers shouldn't depend on the IP suffix being visible in the header (we expose only the prefix to avoid leaking the resolved IP through the response)'. The IP-not-in-header design is the V-251 + V-494 privacy contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts'));
    expect(p).toMatch(/W200 — full RateLimit-header set documented at \/docs\/rate-limits\./);
    expect(p).toMatch(/Mirrors the account-keyed middleware \(W199\)\. `bucket` here is the/);
    expect(p).toMatch(/configured prefix; consumers shouldn't depend on the IP suffix/);
    expect(p).toMatch(/being visible in the header \(we expose only the prefix to avoid/);
    expect(p).toMatch(/leaking the resolved IP through the response\)\./);
  });

  it('CRITICAL W200 emits 4 headers — x-ratelimit-bucket (prefix-only) + x-ratelimit-limit + x-ratelimit-remaining + x-ratelimit-reset. The header set mirrors W199 for client-SDK parity.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts'));
    expect(p).toMatch(/reply\.header\('x-ratelimit-bucket', cfg\.bucketPrefix\);/);
    expect(p).toMatch(/reply\.header\('x-ratelimit-limit', cfg\.capacity\.toString\(\)\);/);
    expect(p).toMatch(
      /reply\.header\('x-ratelimit-remaining', Math\.floor\(result\.remaining\)\.toString\(\)\);/,
    );
    expect(p).toMatch(
      /reply\.header\('x-ratelimit-reset', \(nowSec \+ secondsToFull\)\.toString\(\)\);/,
    );
  });

  // ─── Exceeded path — retry-after + log + throw ───────────────

  it('CRITICAL exceeded path — retryAfterSec = max(1, ceil(retryAfterMs / 1000)). The max(1,...) floor prevents 0-second retry headers.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts'));
    expect(p).toMatch(
      /const retryAfterSec = Math\.max\(1, Math\.ceil\(result\.retryAfterMs \/ 1000\)\);/,
    );
    expect(p).toMatch(/reply\.header\('retry-after', retryAfterSec\.toString\(\)\);/);
  });

  it("CRITICAL warn log has 5 fields — component:'ip-rate-limit' + bucket_prefix + ip + tokens_remaining + retry_after_ms + 'ip rate-limit exceeded on auth endpoint' message. The 5-field log is what abuse-detection dashboards filter on.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts'));
    expect(p).toMatch(/component: 'ip-rate-limit',/);
    expect(p).toMatch(/bucket_prefix: cfg\.bucketPrefix,/);
    expect(p).toMatch(/ip,/);
    expect(p).toMatch(/tokens_remaining: Math\.floor\(result\.remaining\),/);
    expect(p).toMatch(/retry_after_ms: result\.retryAfterMs,/);
    expect(p).toMatch(/'ip rate-limit exceeded on auth endpoint',/);
  });

  it("CRITICAL exceeded path throws RateLimitedError(retryAfterSec, 'Too many requests from this IP. Retry in Ns.'). The IP-anonymous message keeps client copy simple without leaking the IP.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts'));
    expect(p).toMatch(/throw new RateLimitedError\(/);
    expect(p).toMatch(/retryAfterSec,/);
    expect(p).toMatch(
      /`Too many requests from this IP\. Retry in \$\{retryAfterSec\.toString\(\)\}s\.`,/,
    );
  });

  // ─── AUTH_IP_LIMITS 6-entry map ──────────────────────────────

  it("CRITICAL AUTH_IP_LIMITS framing — 'V-251 — locked rate limits per auth endpoint per founder direction. Sized for legitimate customer can complete the flow without hitting the gate; abuser hits it within seconds'. The legitimate-fits + abuser-trips design is the V-251 sizing rationale.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts'));
    expect(p).toMatch(/V-251 — locked rate limits per auth endpoint per founder direction\./);
    expect(p).toMatch(/Sized for "legitimate customer can complete the flow without hitting/);
    expect(p).toMatch(/the gate; abuser hits it within seconds":/);
  });

  it('CRITICAL AUTH_IP_LIMITS has 7 entries — login 10/min + signup 5/min + verifyEmail 10/min + passwordResetRequest 3/min + resendVerification 3/min + magicLink 3/min + V-295c3 statusSubscribe 3/min. The 7-entry map matches the V-251 per-endpoint policy plus the #190 magic-link gap closure.', () => {
    expect(AUTH_IP_LIMITS.login).toEqual({ capacity: 10, refillPerSecond: 10 / 60 });
    expect(AUTH_IP_LIMITS.signup).toEqual({ capacity: 5, refillPerSecond: 5 / 60 });
    expect(AUTH_IP_LIMITS.verifyEmail).toEqual({ capacity: 10, refillPerSecond: 10 / 60 });
    expect(AUTH_IP_LIMITS.passwordResetRequest).toEqual({ capacity: 3, refillPerSecond: 3 / 60 });
    expect(AUTH_IP_LIMITS.resendVerification).toEqual({ capacity: 3, refillPerSecond: 3 / 60 });
    expect(AUTH_IP_LIMITS.magicLink).toEqual({ capacity: 3, refillPerSecond: 3 / 60 });
    expect(AUTH_IP_LIMITS.statusSubscribe).toEqual({ capacity: 3, refillPerSecond: 3 / 60 });
  });

  it("CRITICAL per-endpoint sizing framing — 'login: 10/min — typo-budget + usual retry headroom. signup: 5/min — fewer because signup creates DB rows + emails. verify-email: 10/min — token paste retries are common. password-reset: 3/min — tightest because each fires an email. resend-verification: 3/min — same posture as password-reset (each request fires a Postmark send to the user's address)'. The per-endpoint rationale documents why each number is what it is.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts'));
    expect(p).toMatch(/- login: 10\/min — typo-budget \+ usual retry headroom\./);
    expect(p).toMatch(/- signup: 5\/min — fewer because signup creates DB rows \+ emails\./);
    expect(p).toMatch(/- verify-email: 10\/min — token paste retries are common\./);
    expect(p).toMatch(/- password-reset: 3\/min — tightest because each fires an email\./);
    expect(p).toMatch(/- resend-verification: 3\/min — same posture as password-reset/);
    expect(p).toMatch(/\(each request fires a Postmark send to the user's address\)\./);
  });

  it("CRITICAL V-295c3 statusSubscribe framing — 'public status-page email subscribe. Tighter than signup because we don't create a paying account, and the form is explicitly anonymous (no captcha layer); easier abuse vector'. The V-295c3 anon-form-easier-abuse design is the 3/min rationale.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts'));
    expect(p).toMatch(/V-295c3 — public status-page email subscribe\. Tighter than/);
    expect(p).toMatch(/signup because we don't create a paying account, and the form is/);
    expect(p).toMatch(/explicitly anonymous \(no captcha layer\); easier abuse vector\./);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/ip-rate-limit-v251-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
