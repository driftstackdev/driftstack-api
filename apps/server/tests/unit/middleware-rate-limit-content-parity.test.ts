// W394.C — drift guard for apps/server/src/middleware/rate-limit.ts.
// Per-bucket rate-limit factory: `app.rateLimit(bucketKey, cost?)`
// returns a preHandler that consumes from the named bucket (account-
// keyed) + emits W199 RateLimit-* response headers + V-092 structured
// log line on every consume. Drift either breaks the SDK's
// rate-limit handling code (header names / values change) or removes
// the observability signal V-092 added (capacity-planning queries).
//
//   • Bucket factory: app.rateLimit(bucketKey, cost = 1) — default
//     cost = 1.
//   • Unauthenticated route guard: throws UnauthorizedError ("Rate
//     limit requires an authenticated request.") — misconfiguration
//     signal.
//   • rateLimitConsume args: accountId + tier + bucketKey + cost +
//     overrides=ctx.rateLimitOverrides.
//   • W199 response headers (4): x-ratelimit-bucket / x-ratelimit-limit
//     / x-ratelimit-remaining / x-ratelimit-reset.
//   • Reset = nowSec + ceil(tokensNeededForFull / refillPerSecond);
//     0 when bucket already full (defends against div-by-zero rate=0).
//   • V-092 structured log: component='rate-limit' + 7 fields + 2
//     levels (allowed=debug, denied=warn).
//   • Denied: retry-after header (max 1, ceil retryAfterMs/1000) +
//     throw RateLimitedError(retryAfterSec, "Rate limit for bucket
//     exceeded for tier").
//   • Plugin name='rate-limit' + dependencies=['auth'].

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const MW = resolve(REPO_ROOT, 'apps/server/src/middleware/rate-limit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W394.C apps/server/src/middleware/rate-limit.ts content parity', () => {
  const body = read(MW);

  it('Module framing pinned: per-bucket factory app.rateLimit(bucketKey, costFn?) returns preHandler', () => {
    expect(body).toMatch(
      /Rate-limit middleware\. Decorates `request` with no state and exposes a\s*\n?\s*\/\/\s*per-bucket factory: `app\.rateLimit\(bucketKey, costFn\?\)` returns a Fastify\s*\n?\s*\/\/\s*preHandler that consumes from the named bucket \(account-keyed\) and either\s*\n?\s*\/\/\s*allows the request or throws `RateLimitedError` with retry hint/,
    );
  });

  it('FastifyInstance augmentation: rateLimit(bucketKey, cost?) factory', () => {
    expect(body).toMatch(
      /interface FastifyInstance \{\s*\n?\s*rateLimit: \(\s*\n?\s*bucketKey: string,\s*\n?\s*cost\?: number,\s*\n?\s*\) => \(request: FastifyRequest, reply: FastifyReply\) => Promise<void>;/,
    );
  });

  it('Factory signature: app.rateLimit(bucketKey, cost = 1) — default cost=1', () => {
    expect(body).toMatch(/app\.decorate\('rateLimit', \(bucketKey: string, cost = 1\) => \{/);
  });

  it('Unauthenticated route guard: throws UnauthorizedError with misconfiguration signal text', () => {
    expect(body).toMatch(
      /\/\/ Rate limit only applies to authenticated requests\. If we ever wire\s*\n?\s*\/\/\s*this on a public route, that's a misconfiguration — return 401\./,
    );
    expect(body).toMatch(
      /throw new UnauthorizedError\('Rate limit requires an authenticated request\.'\);/,
    );
  });

  it('rateLimitConsume args: accountId + tier + bucketKey + cost + overrides=ctx.rateLimitOverrides (W384 — wrapped in try/catch, fails open on store error)', () => {
    expect(body).toMatch(
      /result = await rateLimitConsume\(opts\.store, \{\s*\n?\s*accountId: ctx\.account\.id,\s*\n?\s*tier: ctx\.account\.tier,\s*\n?\s*bucketKey,\s*\n?\s*cost,\s*\n?\s*overrides: ctx\.rateLimitOverrides,\s*\n?\s*\}\);/,
    );
  });

  it('W384 store-error fail-open: rateLimitConsume wrapped in try/catch; on error → warn log + return (request allowed, not a 500 that takes down the whole API). Only the store call is wrapped so a legit limit-hit RateLimitedError still propagates', () => {
    expect(body).toMatch(
      /\} catch \(err\) \{[\s\S]*?'rate-limit store error — failing open \(request allowed\)',\s*\n?\s*\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it('W199 framing pinned: full RateLimit-header set documented at /docs/rate-limits', () => {
    expect(body).toMatch(
      /W199 — full RateLimit-header set as documented at\s*\n?\s*\/\/\s*`\/docs\/rate-limits`\. `bucket` lets clients distinguish which\s*\n?\s*\/\/\s*limiter fired \(`global` \/ `sessions:create` \/\s*\n?\s*\/\/\s*`agent_sessions:message` today\); `limit` is the bucket\s*\n?\s*\/\/\s*capacity; `reset` is unix seconds at which the bucket will\s*\n?\s*\/\/\s*be back at capacity/,
    );
  });

  it('Reset computation: nowSec + ceil(tokensNeededForFull / refillPerSecond); 0 when full or rate=0', () => {
    expect(body).toMatch(/const nowSec = Math\.floor\(Date\.now\(\) \/ 1000\);/);
    expect(body).toMatch(/const tokensNeededForFull = result\.capacity - result\.remaining;/);
    expect(body).toMatch(
      /const secondsToFull =\s*\n?\s*tokensNeededForFull > 0 && result\.refillPerSecond > 0\s*\n?\s*\?\s*Math\.ceil\(tokensNeededForFull \/ result\.refillPerSecond\)\s*\n?\s*:\s*0;/,
    );
  });

  it('4 W199 headers: x-ratelimit-bucket / -limit / -remaining (floored) / -reset (nowSec + secondsToFull)', () => {
    expect(body).toMatch(/reply\.header\('x-ratelimit-bucket', bucketKey\);/);
    expect(body).toMatch(/reply\.header\('x-ratelimit-limit', result\.capacity\.toString\(\)\);/);
    expect(body).toMatch(
      /reply\.header\('x-ratelimit-remaining', Math\.floor\(result\.remaining\)\.toString\(\)\);/,
    );
    expect(body).toMatch(
      /reply\.header\('x-ratelimit-reset', \(nowSec \+ secondsToFull\)\.toString\(\)\);/,
    );
  });

  it('V-092 structured log framing: 2 levels (debug=allowed → high-volume / warn=denied → operational signal)', () => {
    expect(body).toMatch(
      /V-092: structured log line on every consume so observability\s*\n?\s*\/\/\s*tooling \(Sentry breadcrumbs, log search\) can answer "is account\s*\n?\s*\/\/\s*X near its rate-limit budget right now\?" without piecing it\s*\n?\s*\/\/\s*together from the egress log/,
    );
    expect(body).toMatch(
      /Allowed → debug level \(high-volume; avoid noise at default\s*\n?\s*\/\/\s*info-level production logs\)\. Exceeded → warn level \(carries the\s*\n?\s*\/\/\s*operational signal for capacity planning \+ abuse detection\)/,
    );
  });

  it('V-092 log fields: component / account_id / tier / bucket_key / cost / tokens_remaining (floored) / allowed / retry_after_ms', () => {
    expect(body).toMatch(
      /const logFields = \{\s*\n?\s*component: 'rate-limit',\s*\n?\s*account_id: ctx\.account\.id,\s*\n?\s*tier: ctx\.account\.tier,\s*\n?\s*bucket_key: bucketKey,\s*\n?\s*cost,\s*\n?\s*tokens_remaining: Math\.floor\(result\.remaining\),\s*\n?\s*allowed: result\.allowed,\s*\n?\s*retry_after_ms: result\.retryAfterMs,\s*\n?\s*\};/,
    );
  });

  it('Denied: warn-log + retry-after header (max(1, ceil(retryAfterMs/1000))) + RateLimitedError("for bucket exceeded for tier")', () => {
    expect(body).toMatch(
      /if \(!result\.allowed\) \{\s*\n?\s*request\.log\.warn\(logFields, 'rate-limit exceeded'\);\s*\n?\s*const retryAfterSec = Math\.max\(1, Math\.ceil\(result\.retryAfterMs \/ 1000\)\);\s*\n?\s*reply\.header\('retry-after', retryAfterSec\.toString\(\)\);\s*\n?\s*throw new RateLimitedError\(\s*\n?\s*retryAfterSec,\s*\n?\s*`Rate limit for "\$\{bucketKey\}" exceeded for tier "\$\{ctx\.account\.tier\}"\.`,\s*\n?\s*\);/,
    );
  });

  it('Allowed: request.log.debug(logFields, "rate-limit consumed")', () => {
    expect(body).toMatch(/request\.log\.debug\(logFields, 'rate-limit consumed'\);/);
  });

  it('Plugin export: fp(rateLimitPlugin, { name: "rate-limit", dependencies: ["auth"] })', () => {
    expect(body).toMatch(
      /export default fp\(rateLimitPlugin, \{ name: 'rate-limit', dependencies: \['auth'\] \}\);/,
    );
  });

  it('imports: rateLimitConsume + RateLimitStore type + RateLimitedError + UnauthorizedError', () => {
    expect(body).toMatch(/import \{[\s\S]*?rateLimitConsume,/);
    expect(body).toMatch(/type ConsumeResultWithBucket,/);
    expect(body).toMatch(/type RateLimitStore,?\s*\n?\s*\} from '\.\.\/services\/rate-limit\.js';/);
    expect(body).toMatch(
      /import \{ RateLimitedError, UnauthorizedError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(MW)).toBe(true);
  });
});
