// W981 — rate-limit middleware W199 + V-092 cross-source invariant.
// Three-hundred-seventh in the drift-guard series. Pins the apps/
// server/src/middleware/rate-limit.ts per-bucket factory primitive:
//
//   Header framing — 'Rate-limit middleware. Decorates request with
//   no state and exposes a per-bucket factory: app.rateLimit(
//   bucketKey, costFn?) returns a Fastify preHandler that consumes
//   from the named bucket (account-keyed) and either allows the
//   request or throws RateLimitedError with retry hint'.
//
//   FastifyInstance decoration — rateLimit(bucketKey, cost?) returns
//     preHandler.
//
//   RateLimitPluginOptions — single field store: RateLimitStore.
//
//   No-account-401 framing — 'Rate limit only applies to
//   authenticated requests. If we ever wire this on a public route,
//   that's a misconfiguration — return 401'.
//
//   rateLimitConsume call — opts.store, {accountId, tier, bucketKey,
//     cost, overrides}.
//
//   W199 4-header set framing — 'full RateLimit-header set as
//   documented at /docs/rate-limits. bucket lets clients distinguish
//   which limiter fired (global / sessions:create /
//   agent_sessions:message today); limit is the bucket capacity;
//   reset is unix seconds at which the bucket will be back at capacity':
//     - x-ratelimit-bucket: bucketKey.
//     - x-ratelimit-limit: capacity.
//     - x-ratelimit-remaining: floor(remaining).
//     - x-ratelimit-reset: unix seconds when bucket back to full.
//
//   secondsToFull = ceil(tokensNeededForFull / refillPerSecond) when
//     both > 0 else 0.
//
//   V-092 structured log framing — 'V-092: structured log line on
//   every consume so observability tooling (Sentry breadcrumbs, log
//   search) can answer is account X near its rate-limit budget right
//   now? without piecing it together from the egress log. Fastify's
//   per-request logger is already account-tagged from the auth
//   middleware; we add the bucket-specific fields here'.
//
//   Log levels — 'Allowed → debug level (high-volume; avoid noise at
//   default info-level production logs). Exceeded → warn level
//   (carries the operational signal for capacity planning + abuse
//   detection)'.
//
//   8-field log payload — component:'rate-limit' + account_id + tier
//     + bucket_key + cost + tokens_remaining + allowed +
//     retry_after_ms.
//
//   RateLimitedError throw + retry-after header. retryAfterSec =
//     max(1, ceil(retryAfterMs / 1000)).
//
//   Plugin name 'rate-limit' + dependencies: ['auth'].
//
// stays in lockstep across apps/server/src/middleware/rate-limit.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W981 rate-limit middleware W199 + V-092 cross-source invariant', () => {
  // ─── Header framing ──────────────────────────────────────────

  it("CRITICAL apps/server/src/middleware/rate-limit.ts header pins surface — 'Rate-limit middleware. Decorates request with no state and exposes a per-bucket factory: app.rateLimit(bucketKey, costFn?) returns a Fastify preHandler that consumes from the named bucket (account-keyed) and either allows the request or throws RateLimitedError with retry hint'. The factory + bucket-named + account-keyed + RateLimitedError-throw design is the V-216 rate-limit-middleware contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/rate-limit.ts'));
    expect(p).toMatch(/Rate-limit middleware\. Decorates `request` with no state and exposes a/);
    expect(p).toMatch(
      /per-bucket factory: `app\.rateLimit\(bucketKey, costFn\?\)` returns a Fastify/,
    );
    expect(p).toMatch(
      /preHandler that consumes from the named bucket \(account-keyed\) and either/,
    );
    expect(p).toMatch(/allows the request or throws `RateLimitedError` with retry hint\./);
  });

  // ─── FastifyInstance decoration ──────────────────────────────

  it("CRITICAL FastifyInstance decoration — 'rateLimit: (bucketKey: string, cost?: number) => preHandler'. The 2-arg factory shape is what route definitions consume.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/rate-limit.ts'));
    expect(p).toMatch(/rateLimit: \(/);
    expect(p).toMatch(/bucketKey: string,/);
    expect(p).toMatch(/cost\?: number,/);
    expect(p).toMatch(/\) => \(request: FastifyRequest, reply: FastifyReply\) => Promise<void>;/);
  });

  // ─── RateLimitPluginOptions ──────────────────────────────────

  it('CRITICAL RateLimitPluginOptions has 1 field — store: RateLimitStore. The single-store-DI lets the plugin be store-implementation-agnostic (Redis prod, in-memory test).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/rate-limit.ts'));
    expect(p).toMatch(/export interface RateLimitPluginOptions \{/);
    expect(p).toMatch(/store: RateLimitStore;/);
  });

  // ─── No-account-401 framing ──────────────────────────────────

  it("CRITICAL no-account 401 framing — 'Rate limit only applies to authenticated requests. If we ever wire this on a public route, that's a misconfiguration — return 401'. The throw-401-on-no-account design surfaces config bugs at request time.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/rate-limit.ts'));
    expect(p).toMatch(/\/\/ Rate limit only applies to authenticated requests\. If we ever wire/);
    expect(p).toMatch(/\/\/ this on a public route, that's a misconfiguration — return 401\./);
    expect(p).toMatch(
      /throw new UnauthorizedError\('Rate limit requires an authenticated request\.'\);/,
    );
  });

  // ─── rateLimitConsume call ───────────────────────────────────

  it('CRITICAL rateLimitConsume invocation — passes 5 fields: accountId + tier + bucketKey + cost + overrides. The 5-field input is the V-216 rate-limit-service contract. The account-path values come from ctx; the gui_control_key control-auth path (ctx absent) charges the session-owner account at that owners own live tier and overrides — a hardcoded free-tier floor wrote the SAME rl:accountId:bucketKey bucket at a smaller capacity, and the token bucket persists min(capacity, ...), so it truncated a paid owners live budget. DoS hardening hoisted the fields into a shared `consumeInput` so the same args feed the bounded fallback store on a primary-store error.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/rate-limit.ts'));
    expect(p).toMatch(/const consumeInput = \{/);
    expect(p).toMatch(/result = await rateLimitConsume\(opts\.store, consumeInput\);/);
    expect(p).toMatch(/accountId: ctx \? ctx\.account\.id : controlKeyAuthority!\.account\.id,/);
    expect(p).toMatch(/tier: ctx \? ctx\.account\.tier : controlKeyAuthority!\.account\.tier,/);
    expect(p).not.toMatch(/\('free' as const\)/);
    expect(p).toMatch(/bucketKey,/);
    expect(p).toMatch(/cost,/);
    expect(p).toMatch(
      /overrides: ctx \? ctx\.rateLimitOverrides : controlKeyAuthority!\.overrides,/,
    );
    expect(p).toMatch(/result = await rateLimitConsume\(fallbackStore, consumeInput\);/);
  });

  // ─── W199 4-header set framing ───────────────────────────────

  it("CRITICAL W199 4-header set framing — 'full RateLimit-header set as documented at /docs/rate-limits. bucket lets clients distinguish which limiter fired (global / sessions:create / agent_sessions:message today); limit is the bucket capacity; reset is unix seconds at which the bucket will be back at capacity'. The 4-header-with-bucket-id-on-which-limiter design is the W199 customer-facing contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/rate-limit.ts'));
    expect(p).toMatch(/W199 — full RateLimit-header set as documented at/);
    expect(p).toMatch(/`\/docs\/rate-limits`\. `bucket` lets clients distinguish which/);
    expect(p).toMatch(
      /limiter fired \(`global` \/ `sessions:create` \/\s*\n?\s*\/\/\s*`agent_sessions:message` today\); `limit` is the bucket/,
    );
    expect(p).toMatch(/capacity; `reset` is unix seconds at which the bucket will/);
    expect(p).toMatch(/be back at capacity\./);
  });

  it('CRITICAL W199 4 headers emitted — x-ratelimit-bucket + x-ratelimit-limit + x-ratelimit-remaining + x-ratelimit-reset. The 4-header set is what client SDKs parse for back-off scheduling.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/rate-limit.ts'));
    expect(p).toMatch(/reply\.header\('x-ratelimit-bucket', bucketKey\);/);
    expect(p).toMatch(/reply\.header\('x-ratelimit-limit', result\.capacity\.toString\(\)\);/);
    expect(p).toMatch(
      /reply\.header\('x-ratelimit-remaining', Math\.floor\(result\.remaining\)\.toString\(\)\);/,
    );
    expect(p).toMatch(
      /reply\.header\('x-ratelimit-reset', \(nowSec \+ secondsToFull\)\.toString\(\)\);/,
    );
  });

  // ─── secondsToFull formula ───────────────────────────────────

  it('CRITICAL secondsToFull = ceil(tokensNeededForFull / refillPerSecond) when both > 0 else 0. The conditional-zero design correctly returns 0 when bucket is already at capacity.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/rate-limit.ts'));
    expect(p).toMatch(/const nowSec = Math\.floor\(Date\.now\(\) \/ 1000\);/);
    expect(p).toMatch(/const tokensNeededForFull = result\.capacity - result\.remaining;/);
    expect(p).toMatch(/const secondsToFull =/);
    expect(p).toMatch(/tokensNeededForFull > 0 && result\.refillPerSecond > 0/);
    expect(p).toMatch(/\? Math\.ceil\(tokensNeededForFull \/ result\.refillPerSecond\)/);
    expect(p).toMatch(/: 0;/);
  });

  // ─── V-092 structured log framing ────────────────────────────

  it("CRITICAL V-092 structured log framing — 'V-092: structured log line on every consume so observability tooling (Sentry breadcrumbs, log search) can answer is account X near its rate-limit budget right now? without piecing it together from the egress log. Fastify's per-request logger is already account-tagged from the auth middleware; we add the bucket-specific fields here'. The per-consume + observability + budget-query design is the V-092 contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/rate-limit.ts'));
    expect(p).toMatch(/V-092: structured log line on every consume so observability/);
    expect(p).toMatch(/tooling \(Sentry breadcrumbs, log search\) can answer "is account/);
    expect(p).toMatch(/X near its rate-limit budget right now\?" without piecing it/);
    expect(p).toMatch(/together from the egress log\. Fastify's per-request logger is/);
    expect(p).toMatch(/already account-tagged from the auth middleware; we add the/);
    expect(p).toMatch(/bucket-specific fields here\./);
  });

  it("CRITICAL log-level framing — 'Allowed → debug level (high-volume; avoid noise at default info-level production logs). Exceeded → warn level (carries the operational signal for capacity planning + abuse detection)'. The debug-vs-warn split is the V-092 noise-vs-signal contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/rate-limit.ts'));
    expect(p).toMatch(/\/\/ Allowed → debug level \(high-volume; avoid noise at default/);
    expect(p).toMatch(/\/\/ info-level production logs\)\. Exceeded → warn level \(carries the/);
    expect(p).toMatch(/\/\/ operational signal for capacity planning \+ abuse detection\)\./);
  });

  // ─── 8-field log payload ─────────────────────────────────────

  it("CRITICAL log payload has 8 fields — component:'rate-limit' + account_id + tier + bucket_key + cost + tokens_remaining + allowed + retry_after_ms. The 8-field structured payload is what observability dashboards filter on.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/rate-limit.ts'));
    expect(p).toMatch(/component: 'rate-limit',/);
    expect(p).toMatch(/account_id: effectiveAccountId,/);
    expect(p).toMatch(/tier: effectiveTier,/);
    expect(p).toMatch(/bucket_key: bucketKey,/);
    expect(p).toMatch(/cost,/);
    expect(p).toMatch(/tokens_remaining: Math\.floor\(result\.remaining\),/);
    expect(p).toMatch(/allowed: result\.allowed,/);
    expect(p).toMatch(/retry_after_ms: result\.retryAfterMs,/);
  });

  // ─── 2 log emissions ─────────────────────────────────────────

  it("CRITICAL allowed → request.log.debug('rate-limit consumed'). Exceeded → request.log.warn('rate-limit exceeded'). The 2-message taxonomy lets queries split on event-type.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/rate-limit.ts'));
    expect(p).toMatch(/request\.log\.debug\(logFields, 'rate-limit consumed'\);/);
    expect(p).toMatch(/request\.log\.warn\(logFields, 'rate-limit exceeded'\);/);
  });

  // ─── Exceeded path ───────────────────────────────────────────

  it('CRITICAL retryAfterSec = max(1, ceil(retryAfterMs/1000)). The max(1,...) floor prevents 0-second retry headers (which clients interpret as zero-back-off).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/rate-limit.ts'));
    expect(p).toMatch(
      /const retryAfterSec = Math\.max\(1, Math\.ceil\(result\.retryAfterMs \/ 1000\)\);/,
    );
    expect(p).toMatch(/reply\.header\('retry-after', retryAfterSec\.toString\(\)\);/);
  });

  it('CRITICAL throws RateLimitedError(retryAfterSec, message-with-bucket-and-tier). The bucketKey + tier in the message helps clients show meaningful errors.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/rate-limit.ts'));
    expect(p).toMatch(/throw new RateLimitedError\(/);
    expect(p).toMatch(/retryAfterSec,/);
    expect(p).toMatch(
      /`Rate limit for "\$\{bucketKey\}" exceeded for tier "\$\{effectiveTier\}"\.`,/,
    );
  });

  // ─── Plugin name + dependencies ──────────────────────────────

  it("CRITICAL plugin name 'rate-limit' + dependencies: ['auth']. The auth-dependency is what ensures request.account is populated before rate-limit consumes.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/rate-limit.ts'));
    expect(p).toMatch(
      /export default fp\(rateLimitPlugin, \{ name: 'rate-limit', dependencies: \['auth'\] \}\);/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/rate-limit-middleware-w199-v092-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
