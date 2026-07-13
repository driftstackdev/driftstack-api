// W395.A — drift guard for apps/server/src/middleware/ip-rate-limit.ts.
// V-251 / V-246-P1-004 IP-keyed pre-auth abuse mitigation. The auth-
// flow endpoints (signup / login / verify-email / password-reset /
// resend-verification / V-295c3 status-subscribe) take requests
// without an account+key yet, so account-keyed limiting is impossible.
// Founder direction 2026-05-07 overrode the original P1-004 deferral —
// brute-force protection is launch-blocking. Drift here either deletes
// the gate or, worse, leaks the resolved IP through response headers.
//
//   • V-251 + V-246-P1-004 framing pinned + 2026-05-07 founder override.
//   • IP null → allow (defense-in-depth, never lock out legitimate
//     customers — auth-flow has account-keyed protections too).
//   • W200 RateLimit-* headers (mirrors W199): bucket = prefix only
//     (NOT the full key — avoid leaking IP into response).
//   • Token-bucket via shared RateLimitStore primitive (memory in
//     tests / Redis in prod).
//   • Limit hit: log + retry-after header + RateLimitedError.
//   • AUTH_IP_LIMITS: 6 endpoints with founder-locked caps
//     (login 10/min, signup 5/min, verifyEmail 10/min, passwordReset
//     3/min, resendVerification 3/min, statusSubscribe 3/min).
//   • V-295c3 status-subscribe: tighter than signup (no paying
//     account, no captcha layer, anonymous form).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const MW = resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W395.A apps/server/src/middleware/ip-rate-limit.ts content parity', () => {
  const body = read(MW);

  it('V-251 + V-246-P1-004 framing pinned + distinct-from-account-keyed posture', () => {
    expect(body).toMatch(
      /V-251 \/ V-246-P1-004 — IP-based rate limiting on unauthenticated\s*\n?\s*\/\/\s*auth endpoints\. Distinct from `app\.rateLimit\(bucketKey\)` which is\s*\n?\s*\/\/\s*account-keyed \(post-auth\)/,
    );
    expect(body).toMatch(
      /The four auth-flow endpoints\s*\n?\s*\/\/\s*\(signup \/ login \/ verify-email \/ password-reset\) take requests\s*\n?\s*\/\/\s*where the customer doesn't have an account\+key yet, so account-key\s*\n?\s*\/\/\s*rate limiting is impossible/,
    );
  });

  it('2026-05-07 founder override pinned: P1-004 deferral OVERRIDDEN, brute-force protection launch-blocking', () => {
    expect(body).toMatch(
      /Per founder direction 2026-05-07 \(P1-004 deferral OVERRIDDEN\):\s*\n?\s*\/\/\s*brute-force protection is launch-blocking\. Wire in basic IP gates;\s*\n?\s*\/\/\s*fancier \(CAPTCHA on threshold breach, exponential backoff per IP\)\s*\n?\s*\/\/\s*is post-launch/,
    );
  });

  it('shared-primitive framing: RateLimitStore reuse — memory in tests, Redis in production', () => {
    expect(body).toMatch(
      /Implementation reuses the existing `RateLimitStore` \(token bucket\s*\n?\s*\/\/\s*with capacity \+ refillPerSecond\) — same primitive the account-keyed\s*\n?\s*\/\/\s*limiter uses, just with an IP-derived bucket key\. Memory store in\s*\n?\s*\/\/\s*tests; Redis store in production/,
    );
  });

  it('IpRateLimitConfig: bucketPrefix + capacity + refillPerSecond (3 fields)', () => {
    expect(body).toMatch(/export interface IpRateLimitConfig \{/);
    expect(body).toMatch(/Bucket-key prefix; final key is `\$\{prefix\}:\$\{ip\}`\./);
    expect(body).toMatch(/bucketPrefix: string;/);
    expect(body).toMatch(/Max tokens in the bucket; first `capacity` requests pass freely\./);
    expect(body).toMatch(/capacity: number;/);
    expect(body).toMatch(/Tokens refilled per second; sustained throughput floor\./);
    expect(body).toMatch(/refillPerSecond: number;/);
  });

  it('ipRateLimit factory: preHandler returning (req, reply) => Promise<void> (3rd optional metrics arg for the fallback counter)', () => {
    expect(body).toMatch(
      /export function ipRateLimit\(\s*\n?\s*store: RateLimitStore,\s*\n?\s*cfg: IpRateLimitConfig,\s*\n?\s*[\s\S]*?metrics\?: MetricsRegistry,\s*\n?\s*\): \(req: FastifyRequest, reply: FastifyReply\) => Promise<void>/,
    );
  });

  it('IP null → allowed framing: defense-in-depth on top of account-keyed protections', () => {
    expect(body).toMatch(
      /When `req\.ip` is null\/empty \(unusual: only happens on Unix-socket\s*\n?\s*\*\s*setups in some Fastify configs\), the request is \*\*allowed\*\*\.\s*\n?\s*\*\s*Rationale: the IP gate is defense-in-depth on top of the\s*\n?\s*\*\s*auth-flow's existing account-keyed protections \(V-049 etc\.\); a\s*\n?\s*\*\s*missing IP shouldn't lock out legitimate customers/,
    );
    expect(body).toMatch(
      /const ip = typeof req\.ip === 'string' && req\.ip\.length > 0 \? req\.ip : null;/,
    );
    expect(body).toMatch(/if \(ip === null\) \{[\s\S]+?return;\s*\n?\s*\}/);
  });

  it('store.consume: bucketKey = `${prefix}:${ip}`, cost=1, now=Date.now() (hoisted into consumeArgs so the same args feed the bounded fallback on a store error)', () => {
    expect(body).toMatch(
      /const consumeArgs = \{\s*\n?\s*key: `\$\{cfg\.bucketPrefix\}:\$\{ip\}`,\s*\n?\s*capacity: cfg\.capacity,\s*\n?\s*refillPerSecond: cfg\.refillPerSecond,\s*\n?\s*cost: 1,\s*\n?\s*now: Date\.now\(\),\s*\n?\s*\};/,
    );
    expect(body).toContain('result = await store.consume(consumeArgs);');
  });

  it('W384 store-error degrade: consume wrapped in try/catch; on error → warn + fallback-metric + serve from the bounded module-level memory store (NOT a blanket allow, NOT a 500)', () => {
    expect(body).toContain('const ipFallbackStore = new BoundedMemoryRateLimitStore();');
    expect(body).toMatch(
      /\} catch \(err\) \{[\s\S]*?'ip rate-limit store error — degrading to bounded in-process fallback',/,
    );
    expect(body).toContain('result = await ipFallbackStore.consume(consumeArgs);');
    expect(body).toContain("METRIC_NAMES.rateLimitStoreFallbackTotal, { limiter: 'ip' }");
  });

  it('W200 framing pinned: mirrors W199 + bucket=prefix only (avoid leaking IP through response)', () => {
    expect(body).toMatch(
      /W200 — full RateLimit-header set documented at \/docs\/rate-limits\.\s*\n?\s*\/\/\s*Mirrors the account-keyed middleware \(W199\)\. `bucket` here is the\s*\n?\s*\/\/\s*configured prefix; consumers shouldn't depend on the IP suffix\s*\n?\s*\/\/\s*being visible in the header \(we expose only the prefix to avoid\s*\n?\s*\/\/\s*leaking the resolved IP through the response\)/,
    );
  });

  it('4 W200 headers: bucket=prefix / limit=capacity / remaining-floored / reset=nowSec+secondsToFull', () => {
    expect(body).toMatch(/reply\.header\('x-ratelimit-bucket', cfg\.bucketPrefix\);/);
    expect(body).toMatch(/reply\.header\('x-ratelimit-limit', cfg\.capacity\.toString\(\)\);/);
    expect(body).toMatch(
      /reply\.header\('x-ratelimit-remaining', Math\.floor\(result\.remaining\)\.toString\(\)\);/,
    );
    expect(body).toMatch(
      /reply\.header\('x-ratelimit-reset', \(nowSec \+ secondsToFull\)\.toString\(\)\);/,
    );
  });

  it('W561 IETF draft names mirrored here too; ratelimit-reset stays RELATIVE (secondsToFull)', () => {
    expect(body).toMatch(/reply\.header\('ratelimit-limit', cfg\.capacity\.toString\(\)\);/);
    expect(body).toMatch(
      /reply\.header\('ratelimit-remaining', Math\.floor\(result\.remaining\)\.toString\(\)\);/,
    );
    expect(body).toMatch(/reply\.header\('ratelimit-reset', secondsToFull\.toString\(\)\);/);
    expect(body).not.toMatch(/reply\.header\('ratelimit-reset', \(nowSec/);
  });

  it('Denied: retry-after header (max(1, ceil(retryAfterMs/1000))) + ip-rate-limit warn log + RateLimitedError', () => {
    expect(body).toMatch(
      /if \(!result\.allowed\) \{\s*\n?\s*const retryAfterSec = Math\.max\(1, Math\.ceil\(result\.retryAfterMs \/ 1000\)\);\s*\n?\s*reply\.header\('retry-after', retryAfterSec\.toString\(\)\);/,
    );
    expect(body).toMatch(
      /req\.log\.warn\(\s*\n?\s*\{\s*\n?\s*component: 'ip-rate-limit',\s*\n?\s*bucket_prefix: cfg\.bucketPrefix,\s*\n?\s*ip,\s*\n?\s*tokens_remaining: Math\.floor\(result\.remaining\),\s*\n?\s*retry_after_ms: result\.retryAfterMs,\s*\n?\s*\},\s*\n?\s*'ip rate-limit exceeded on auth endpoint',\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      /throw new RateLimitedError\(\s*\n?\s*retryAfterSec,\s*\n?\s*`Too many requests from this IP\. Retry in \$\{retryAfterSec\.toString\(\)\}s\.`,\s*\n?\s*\);/,
    );
  });

  it('AUTH_IP_LIMITS framing: founder-locked caps with rationale per endpoint', () => {
    expect(body).toMatch(/V-251 — locked rate limits per auth endpoint per founder direction\./);
    expect(body).toMatch(
      /Sized for "legitimate customer can complete the flow without hitting\s*\n?\s*\*\s*the gate; abuser hits it within seconds":/,
    );
  });

  it('AUTH_IP_LIMITS: 7 entries (login 10 / signup 5 / verifyEmail 10 / passwordResetRequest 3 / resendVerification 3 / magicLink 3 / statusSubscribe 3) with refill = cap/60; magicLink added 2026-05-15 (#190 follow-up)', () => {
    expect(body).toMatch(/export const AUTH_IP_LIMITS = \{/);
    expect(body).toMatch(/login: \{ capacity: 10, refillPerSecond: 10 \/ 60 \},/);
    expect(body).toMatch(/signup: \{ capacity: 5, refillPerSecond: 5 \/ 60 \},/);
    expect(body).toMatch(/verifyEmail: \{ capacity: 10, refillPerSecond: 10 \/ 60 \},/);
    expect(body).toMatch(/passwordResetRequest: \{ capacity: 3, refillPerSecond: 3 \/ 60 \},/);
    expect(body).toMatch(/resendVerification: \{ capacity: 3, refillPerSecond: 3 \/ 60 \},/);
    expect(body).toMatch(/magicLink: \{ capacity: 3, refillPerSecond: 3 \/ 60 \},/);
    expect(body).toMatch(/statusSubscribe: \{ capacity: 3, refillPerSecond: 3 \/ 60 \},/);
    expect(body).toMatch(/\} as const;/);
  });

  it('V-295c3 statusSubscribe rationale: tighter than signup (anonymous, no captcha, no paying account)', () => {
    expect(body).toMatch(
      /V-295c3 — public status-page email subscribe\. Tighter than\s*\n?\s*\/\/\s*signup because we don't create a paying account, and the form is\s*\n?\s*\/\/\s*explicitly anonymous \(no captcha layer\); easier abuse vector/,
    );
  });

  it('2026-06-01 oauthProvider entry: V-667 OAuth-provider public dance (authorize/token/introspect/revoke unauth); 60/min/IP — brute-force friction on /token + oracle throttling on /introspect, generous for a client server; dormant until V-667.C wires a store', () => {
    expect(body).toMatch(/oauthProvider: \{ capacity: 60, refillPerSecond: 60 \/ 60 \},/);
    expect(body).toMatch(/OAuth-PROVIDER public dance \(V-667; Driftstack issuing/);
    expect(body).toMatch(/an unauthenticated token-validity oracle/);
  });

  it('imports: RateLimitedError + RateLimitStore type', () => {
    expect(body).toMatch(/import \{ RateLimitedError \} from '\.\.\/lib\/errors\.js';/);
    expect(body).toMatch(/ConsumeResult,/);
    expect(body).toMatch(/RateLimitStore,/);
    expect(body).toMatch(/SlidingWindowConsumeResult,/);
    expect(body).toMatch(/SlidingWindowRateLimitStore,/);
  });

  it('signup daily ceiling uses an exact sliding window and fails closed without the capability', () => {
    expect(body).toMatch(/const MILLISECONDS_PER_DAY = SECONDS_PER_DAY \* 1000;/);
    expect(body).toMatch(/interface DailyCeilingConfig \{/);
    expect(body).toMatch(/bucketPrefix: `\$\{bucketPrefix\}-daily-window`,/);
    expect(body).toMatch(/Reusing that key would make the ZSET script fail WRONGTYPE/);
    expect(body).toMatch(/windowMs: MILLISECONDS_PER_DAY,/);
    expect(body).toMatch(/function hasSlidingWindowCapability\(/);
    expect(body).toMatch(
      /throw new Error\('rate-limit store lacks exact sliding-window support'\);/,
    );
    expect(body).toMatch(/result = await store\.consumeSlidingWindow\(consumeArgs\);/);
    expect(body).toMatch(
      /reply\.header\('x-ratelimit-daily-reset', Math\.ceil\(result\.resetAtMs \/ 1000\)\.toString\(\)\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(MW)).toBe(true);
  });
});
