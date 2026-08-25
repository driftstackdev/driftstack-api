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
//   • Missing IP → one shared unresolved-client bucket (bounded
//     availability without an identity-bypass lane).
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
      /V-251 \/ V-246-P1-004 — IP-based rate limiting on unauthenticated\s*\/\/\s*auth endpoints\. Distinct from `app\.rateLimit\(bucketKey\)` which is\s*\/\/\s*account-keyed \(post-auth\)/,
    );
    expect(body).toMatch(
      /The four auth-flow endpoints\s*\/\/\s*\(signup \/ login \/ verify-email \/ password-reset\) take requests\s*\/\/\s*where the customer doesn't have an account\+key yet, so account-key\s*\/\/\s*rate limiting is impossible/,
    );
  });

  it('2026-05-07 founder override pinned: P1-004 deferral OVERRIDDEN, brute-force protection launch-blocking', () => {
    expect(body).toMatch(
      /Per founder direction 2026-05-07 \(P1-004 deferral OVERRIDDEN\):\s*\/\/\s*brute-force protection is launch-blocking\. Wire in basic IP gates;\s*\/\/\s*fancier \(CAPTCHA on threshold breach, exponential backoff per IP\)\s*\/\/\s*is post-launch/,
    );
  });

  it('shared-primitive framing: RateLimitStore reuse — memory in tests, Redis in production', () => {
    expect(body).toMatch(
      /Implementation reuses the existing `RateLimitStore` \(token bucket\s*\/\/\s*with capacity \+ refillPerSecond\) — same primitive the account-keyed\s*\/\/\s*limiter uses, just with an IP-derived bucket key\. Memory store in\s*\/\/\s*tests; Redis store in production/,
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
      /export function ipRateLimit\(\s*store: RateLimitStore,\s*cfg: IpRateLimitConfig,[\s\S]*?metrics\?: MetricsRegistry,\s*\): \(req: FastifyRequest, reply: FastifyReply\) => Promise<void>/,
    );
  });

  it('Missing IP → shared unresolved-client identity instead of bypass', () => {
    expect(body).toMatch(
      /When `req\.ip` is empty[\s\S]{0,240}`unresolved-client` identity[\s\S]{0,180}without letting a missing identity bypass the gate/,
    );
    expect(body).toMatch(
      /const ip =\s*typeof req\.ip === 'string' && req\.ip\.trim\(\)\.length > 0 \? req\.ip : 'unresolved-client';/,
    );
    expect(body).not.toMatch(/if \(ip === null\)/);
  });

  it('store.consume: bucketKey = `${prefix}:${ip}`, cost=1, now=Date.now() (hoisted into consumeArgs so the same args feed the bounded fallback on a store error)', () => {
    expect(body).toMatch(
      /const consumeArgs = \{\s*key: `\$\{cfg\.bucketPrefix\}:\$\{ip\}`,\s*capacity: cfg\.capacity,\s*refillPerSecond: cfg\.refillPerSecond,\s*cost: 1,\s*now: Date\.now\(\),\s*\};/,
    );
    expect(body).toContain('result = await store.consume(consumeArgs);');
  });

  it('W384 store-error degrade: primary failure uses bounded memory; dual failure denies with a retryable 429 instead of admitting unmetered work', () => {
    expect(body).toContain('const ipFallbackStore = new BoundedMemoryRateLimitStore();');
    expect(body).toMatch(
      /\} catch \(err\) \{[\s\S]*?'ip rate-limit store error — degrading to bounded in-process fallback',/,
    );
    expect(body).toContain('result = await ipFallbackStore.consume(consumeArgs);');
    expect(body).toContain("METRIC_NAMES.rateLimitStoreFallbackTotal, { limiter: 'ip' }");
    expect(body).toContain("'ip rate-limit fallback store error — failing CLOSED'");
    expect(body).toContain("'Request rate limiting is temporarily unavailable. Retry shortly.'");
    expect(body).not.toMatch(
      /ipFallbackStore\.consume\(consumeArgs\);[\s\S]{0,240}catch \{[\s\S]{0,240}return;/,
    );
  });

  it('W200 framing pinned: mirrors W199 + bucket=prefix only (avoid leaking IP through response)', () => {
    expect(body).toMatch(
      /W200 — full RateLimit-header set documented at \/docs\/rate-limits\.\s*\/\/\s*Mirrors the account-keyed middleware \(W199\)\. `bucket` here is the\s*\/\/\s*configured prefix; consumers shouldn't depend on the IP suffix\s*\/\/\s*being visible in the header \(we expose only the prefix to avoid\s*\/\/\s*leaking the resolved IP through the response\)/,
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
      /if \(!result\.allowed\) \{\s*const retryAfterSec = Math\.max\(1, Math\.ceil\(result\.retryAfterMs \/ 1000\)\);\s*reply\.header\('retry-after', retryAfterSec\.toString\(\)\);/,
    );
    expect(body).toMatch(
      /req\.log\.warn\(\s*\{\s*component: 'ip-rate-limit',\s*bucket_prefix: cfg\.bucketPrefix,\s*ip,\s*tokens_remaining: Math\.floor\(result\.remaining\),\s*retry_after_ms: result\.retryAfterMs,\s*\},\s*'ip rate-limit exceeded on auth endpoint',\s*\);/,
    );
    expect(body).toMatch(
      /throw new RateLimitedError\(\s*retryAfterSec,\s*`Too many requests from this IP\. Retry in \$\{retryAfterSec\.toString\(\)\}s\.`,\s*\);/,
    );
  });

  it('AUTH_IP_LIMITS framing: founder-locked caps with rationale per endpoint', () => {
    expect(body).toMatch(/V-251 — locked rate limits per auth endpoint per founder direction\./);
    expect(body).toMatch(
      /Sized for "legitimate customer can complete the flow without hitting\s*\*\s*the gate; abuser hits it within seconds":/,
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
      /V-295c3 — public status-page email subscribe\. Tighter than\s*\/\/\s*signup because we don't create a paying account, and the form is\s*\/\/\s*explicitly anonymous \(no captcha layer\); easier abuse vector/,
    );
  });

  it('public SLA aggregate has the adjacent status-read budget (60/min/IP)', () => {
    expect(body).toContain('statusSla: { capacity: 60, refillPerSecond: 60 / 60 },');
    expect(body).toContain('Public rolling SLA aggregation reads roughly 43k probe rows');
    expect(body).toContain('independently of the global IP gate');
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

  it('CRITICAL the oauthProvider bucket is not described as dormant. It was documented as inert pending a Drizzle OAuthStore that bootstrap.ts already constructs, while routes/oauth.ts applies this very bucket per-route — so the comment invited someone tuning limits to drop a brute-force and token-oracle limiter that is carrying live traffic.', () => {
    expect(body, 'the oauthProvider bucket disappeared').toMatch(/oauthProvider: \{ capacity: 60/);
    // V-1017 — the retracted wording called the provider dormant pending a store.
    expect(body, 'the dormant-provider framing is back').not.toMatch(/provider is dormant/i);
    const routes = readFileSync(resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts'), 'utf8');
    expect(routes, 'routes/oauth.ts no longer applies the oauthProvider bucket').toMatch(
      /AUTH_IP_LIMITS\.oauthProvider/,
    );
  });
});
