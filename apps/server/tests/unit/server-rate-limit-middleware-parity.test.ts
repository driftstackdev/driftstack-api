// W713 — server-side rate-limit middleware parity. Fortieth in the
// cross-SDK drift-guard series (W649 + W675-W713).
//
// Pins apps/server/src/middleware/rate-limit.ts as the canonical
// Fastify rate-limit gate:
//
//   - app.rateLimit(bucketKey, cost?) decorator factory
//   - Account-keyed bucket consumption via rateLimitConsume()
//   - Auth-required gate: throws UnauthorizedError when no
//     request.account (misconfiguration safety)
//   - 4-header W199 response set: x-ratelimit-bucket / -limit /
//     -remaining / -reset (unix seconds at full capacity)
//   - V-092 structured-log-on-every-consume (debug on allow, warn
//     on exceed) — observability without piecing together from
//     egress log
//   - retry-after header on 429
//   - rate-limit plugin depends on auth plugin (fp dependencies
//     ordering)
//
// CRITICAL invariants:
//   1. UnauthorizedError thrown when rate-limit fires on a route
//      WITHOUT auth — drift to skipping would let unauthenticated
//      routes hit the bucket consumer with an undefined account_id.
//   2. retry-after header carries SECONDS (not ms) per RFC 9110.
//   3. 4 x-ratelimit-* headers MUST match documented W199 contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const RATE_LIMIT_MIDDLEWARE = resolve(REPO_ROOT, 'apps/server/src/middleware/rate-limit.ts');

describe('W713 server-side rate-limit middleware parity', () => {
  it('rate-limit.ts middleware file exists', () => {
    expect(existsSync(RATE_LIMIT_MIDDLEWARE), `missing ${RATE_LIMIT_MIDDLEWARE}`).toBe(true);
  });

  it("CRITICAL Fastify type augmentation pinned — declare module 'fastify' adds `rateLimit` decorator to FastifyInstance. The augmentation gives route handlers type-safe access to `app.rateLimit('sessions:create')`. Drift to dropping would let TypeScript reject route definitions or accept misnamed bucket keys.", () => {
    const src = read(RATE_LIMIT_MIDDLEWARE);

    expect(src).toMatch(/declare module 'fastify' \{/);
    expect(src).toMatch(
      /rateLimit: \(\s*bucketKey: string,\s*cost\?: number,\s*\) => \(request: FastifyRequest, reply: FastifyReply\) => Promise<void>/,
    );
  });

  it("CRITICAL rateLimit factory decorator pinned — `app.decorate('rateLimit', (bucketKey: string, cost = 1) => { ... })`. The factory shape is what lets routes compose `preHandler: [fastify.rateLimit('global')]` directly. Drift to a different signature would force per-route rewrites.", () => {
    const src = read(RATE_LIMIT_MIDDLEWARE);
    expect(src).toMatch(/app\.decorate\('rateLimit', \(bucketKey: string, cost = 1\) => \{/);
  });

  it('CRITICAL UnauthorizedError pinned when rate-limit fires on unauthenticated request. The misconfiguration-safety check is what prevents rate-limit consumption from hitting an undefined account_id (would corrupt the bucket store). The thrown 401 also signals to engineers that they put rate-limit on a public route.', () => {
    const src = read(RATE_LIMIT_MIDDLEWARE);
    expect(src).toMatch(
      /throw new UnauthorizedError\('Rate limit requires an authenticated request\.'\)/,
    );
    expect(src).toMatch(/Rate limit only applies to authenticated requests/);
  });

  it('CRITICAL rateLimitConsume 5-arg call shape pinned — accountId + tier + bucketKey + cost + overrides. The 5-field input is what threads the account-context + per-account override into the token-bucket consumer. Drift to dropping `overrides` would let admin-issued rate-limit overrides silently stop applying. the gui_control_key control-auth path (ctx absent) charges the session-owner account at that owners own live tier and overrides — a hardcoded free-tier floor wrote the SAME rl:accountId:bucketKey bucket at a smaller capacity, and the token bucket persists min(capacity, ...), so it truncated a paid owners live budget.', () => {
    const src = read(RATE_LIMIT_MIDDLEWARE);

    // DoS hardening hoisted the consume input into a shared `consumeInput` so
    // the SAME args feed the bounded fallback store on a primary-store error.
    expect(src).toContain('const consumeInput = {');
    expect(src).toContain('result = await rateLimitConsume(opts.store, consumeInput);');
    expect(src).toContain('accountId: ctx ? ctx.account.id : controlKeyAuthority!.account.id,');
    expect(src).toContain('tier: ctx ? ctx.account.tier : controlKeyAuthority!.account.tier,');
    expect(src).not.toContain("('free' as const)");
    expect(src).toContain('bucketKey,');
    expect(src).toContain('cost,');
    expect(src).toContain(
      'overrides: ctx ? ctx.rateLimitOverrides : controlKeyAuthority!.overrides,',
    );
    // The fallback path reuses the same consumeInput.
    expect(src).toContain('result = await rateLimitConsume(fallbackStore, consumeInput);');
  });

  it('CRITICAL W199 4-header response set pinned — x-ratelimit-bucket / -limit / -remaining / -reset. The 4-header contract is what dashboards + clients render against. Drift to dropping any header would silently change customer dashboard behavior.', () => {
    const src = read(RATE_LIMIT_MIDDLEWARE);

    expect(src).toMatch(/reply\.header\('x-ratelimit-bucket', bucketKey\)/);
    expect(src).toMatch(/reply\.header\('x-ratelimit-limit', result\.capacity\.toString\(\)\)/);
    expect(src).toMatch(
      /reply\.header\('x-ratelimit-remaining', Math\.floor\(result\.remaining\)\.toString\(\)\)/,
    );
    expect(src).toMatch(
      /reply\.header\('x-ratelimit-reset', \(nowSec \+ secondsToFull\)\.toString\(\)\)/,
    );
  });

  it('CRITICAL x-ratelimit-reset is UNIX SECONDS at which the bucket will be BACK AT CAPACITY (not just retry-after). The "back at capacity" semantic differs from retry-after (next-permitted) — drift to retry-after-semantics would silently change customer client behavior.', () => {
    const src = read(RATE_LIMIT_MIDDLEWARE);
    // Comment was reflowed when adding the 3rd bucket to the
    // limiter-list — "bucket will" ends one line, "be back at
    // capacity" starts the next.
    expect(src).toMatch(
      /`reset` is unix seconds at which the bucket will\s*\/\/\s*be back at capacity/,
    );
  });

  it('CRITICAL secondsToFull computation pinned — `Math.ceil(tokensNeededForFull / result.refillPerSecond)` ONLY when tokensNeededForFull > 0 AND refillPerSecond > 0. Drift to dropping the refillPerSecond > 0 guard would divide by zero on a bucket with no refill.', () => {
    const src = read(RATE_LIMIT_MIDDLEWARE);
    expect(src).toMatch(
      /tokensNeededForFull > 0 && result\.refillPerSecond > 0\s*\?\s*Math\.ceil\(tokensNeededForFull \/ result\.refillPerSecond\)\s*: 0/,
    );
  });

  it('CRITICAL V-092 structured-log on every rate-limit consume. The 8-field log shape (component + account_id + tier + bucket_key + cost + tokens_remaining + allowed + retry_after_ms) is what observability tooling consumes for capacity planning + abuse detection. Drift to dropping fields would break Sentry breadcrumbs / log-search.', () => {
    const src = read(RATE_LIMIT_MIDDLEWARE);
    expect(src).toMatch(/V-092: structured log line on every consume/);

    // 8-field log shape.
    expect(src).toMatch(/component: 'rate-limit'/);
    expect(src).toMatch(/account_id: effectiveAccountId/);
    expect(src).toMatch(/tier: effectiveTier/);
    expect(src).toMatch(/bucket_key: bucketKey/);
    expect(src).toMatch(/cost,/);
    expect(src).toMatch(/tokens_remaining: Math\.floor\(result\.remaining\)/);
    expect(src).toMatch(/allowed: result\.allowed/);
    expect(src).toMatch(/retry_after_ms: result\.retryAfterMs/);
  });

  it('CRITICAL log-level differentiation pinned — debug on allowed (high-volume; avoid noise at default info-level), warn on exceeded (operational signal for capacity planning + abuse detection). Drift to logging at info on allowed would 10× log volume.', () => {
    const src = read(RATE_LIMIT_MIDDLEWARE);

    expect(src).toMatch(/Allowed → debug level/);
    expect(src).toMatch(/avoid noise at default\s*\/\/\s*info-level production logs/);
    expect(src).toMatch(/Exceeded → warn level/);

    // Implementation matches the framing.
    expect(src).toMatch(/request\.log\.warn\(logFields, 'rate-limit exceeded'\)/);
    expect(src).toMatch(/request\.log\.debug\(logFields, 'rate-limit consumed'\)/);
  });

  it('CRITICAL retry-after header in SECONDS (not ms) — `Math.max(1, Math.ceil(result.retryAfterMs / 1000))`. RFC 9110 mandates the seconds unit; drift to passing ms would mislead clients into too-short retry waits. The Math.max(1, ...) prevents 0-second retry-after which some browsers ignore.', () => {
    const src = read(RATE_LIMIT_MIDDLEWARE);
    expect(src).toMatch(/Math\.max\(1, Math\.ceil\(result\.retryAfterMs \/ 1000\)\)/);
    expect(src).toMatch(/reply\.header\('retry-after', retryAfterSec\.toString\(\)\)/);
  });

  it('CRITICAL RateLimitedError thrown with 2-arg shape — retryAfterSec + detail message. The 2-arg shape feeds W710 RateLimitedError constructor; drift to dropping retryAfterSec would lose the Retry-After-header propagation chain.', () => {
    const src = read(RATE_LIMIT_MIDDLEWARE);
    expect(src).toContain('throw new RateLimitedError(');
    expect(src).toContain('retryAfterSec,');
    expect(src).toContain('`Rate limit for "${bucketKey}" exceeded for tier "${effectiveTier}".`,');
  });

  it("CRITICAL fastify-plugin dependencies pinned — `fp(rateLimitPlugin, { name: 'rate-limit', dependencies: ['auth'] })`. The `dependencies: ['auth']` is what guarantees the auth plugin loads first (so request.account is populated before rate-limit consumes it). Drift to dropping would let route registration succeed but fail at request time with undefined account.", () => {
    const src = read(RATE_LIMIT_MIDDLEWARE);
    expect(src).toMatch(
      /export default fp\(rateLimitPlugin, \{ name: 'rate-limit', dependencies: \['auth'\] \}\)/,
    );
  });

  it("CRITICAL imports pinned — ForbiddenError + RateLimitedError + UnauthorizedError from ../lib/errors.js (canonical taxonomy). Drift to importing from elsewhere would let the middleware diverge from W710's canonical roster.", () => {
    const src = read(RATE_LIMIT_MIDDLEWARE);
    expect(src).toMatch(
      /import \{ ForbiddenError, RateLimitedError, UnauthorizedError \} from '\.\.\/lib\/errors\.js'/,
    );
  });

  it('CRITICAL `bucket` framing pinned — the roster must name ALL enforced buckets. V-754: this pin\'s own title warned that "drift to a 4th bucket without updating the roster would surface as unknown bucket-keys to clients", and that is precisely what happened — agent_sessions:input_event became a live preHandler gate AND is published by GET /v1/account/rate-limits while this roster still said three. Pinning the 3-name text froze the stale list instead of catching the drift, so the assertion now requires the 4th name too.', () => {
    const src = read(RATE_LIMIT_MIDDLEWARE);
    expect(src).toMatch(
      /`bucket` lets clients distinguish which\s*\/\/\s*limiter fired \(`global` \/ `sessions:create` \/\s*\/\/\s*`agent_sessions:message` \/ `agent_sessions:input_event` today/,
    );
  });

  it('CRITICAL plugin signature pinned with `done: (err?: Error) => void` callback. The Fastify-plugin sync callback shape is what lets registration complete synchronously; drift to async-only would force route registration to await across the plugin tree.', () => {
    const src = read(RATE_LIMIT_MIDDLEWARE);
    expect(src).toMatch(
      /function rateLimitPlugin\(\s*app: FastifyInstance,\s*opts: RateLimitPluginOptions,\s*done: \(err\?: Error\) => void,\s*\): void/,
    );
    expect(src).toMatch(/^\s*done\(\);/m);
  });

  it('Server rate-limit-middleware 6-invariant cluster — rateLimit factory + 4 x-ratelimit-* headers + retry-after seconds + V-092 8-field log + UnauthorizedError gate + auth dependency. Drift on any would fragment the canonical rate-limit middleware.', () => {
    const src = read(RATE_LIMIT_MIDDLEWARE);

    expect(src).toMatch(/app\.decorate\('rateLimit',/);
    expect(src).toMatch(/x-ratelimit-bucket/);
    expect(src).toMatch(/x-ratelimit-limit/);
    expect(src).toMatch(/x-ratelimit-remaining/);
    expect(src).toMatch(/x-ratelimit-reset/);
    expect(src).toMatch(/retry-after/);
    expect(src).toMatch(/V-092/);
    expect(src).toMatch(/UnauthorizedError/);
    expect(src).toMatch(/dependencies: \['auth'\]/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/server-rate-limit-middleware-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
