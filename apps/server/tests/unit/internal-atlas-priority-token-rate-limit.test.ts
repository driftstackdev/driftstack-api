/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// The /v1/internal/atlas-priority/* surface carries a per-token rate limit
// added 2026-05-20 as defence in depth (rate-limit audit item 6): even behind
// a strong bearer gate, a LEAKED token could otherwise drive unbounded calls.
//
// Before this file, no test referenced that limit at all — not the bucket key,
// not the capacity constant, not the 429. The preHandler ran on every internal
// request and its refusal branch had never once fired, so a regression that
// silently stopped enforcing (wrong capacity, cost 0, result ignored) would
// have been invisible to the suite.
//
// Capacity is 1000, so exhausting the bucket by volume is not a practical
// test. These arms inject the store instead, which also makes the two things
// worth pinning observable: the Retry-After arithmetic, and the property the
// source comment claims — the plaintext token never becomes the bucket key.

import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InternalFleetAuth } from '../../src/lib/internal-fleet-auth.js';
import { registerInternalAtlasPriorityRoutes } from '../../src/routes/internal-atlas-priority.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import type { DrizzleAtlasPriorityEventsRepo } from '../../src/db/atlas-priority-events-repo.js';
import type { ConsumeOpts, ConsumeResult, RateLimitStore } from '../../src/services/rate-limit.js';

const TOKEN = 'internal-fleet-token-for-the-rate-limit-arms';
const AUTH = `Bearer ${TOKEN}`;
const QUEUE = '/v1/internal/atlas-priority/queue';

class RecordingStore implements RateLimitStore {
  readonly calls: ConsumeOpts[] = [];
  constructor(private readonly result: ConsumeResult) {}
  consume(opts: ConsumeOpts): Promise<ConsumeResult> {
    this.calls.push(opts);
    return Promise.resolve(this.result);
  }
}

// Any repo access at all means the request got PAST the rate-limit gate.
// A refusal arm that only asserts 429 cannot tell "the gate refused" from
// "something later refused it anyway"; this makes reaching the handler
// observable, and gives the positive control something to assert.
function makeRepo(): { repo: DrizzleAtlasPriorityEventsRepo; reached: () => boolean } {
  let touched = false;
  const repo = new Proxy(
    {},
    {
      get() {
        touched = true;
        return () => {
          throw new Error('repo reached');
        };
      },
    },
  );
  return { repo: repo as DrizzleAtlasPriorityEventsRepo, reached: () => touched };
}

async function build(
  result: ConsumeResult,
): Promise<{ app: FastifyInstance; store: RecordingStore; reached: () => boolean }> {
  const store = new RecordingStore(result);
  const { repo, reached } = makeRepo();
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerInternalAtlasPriorityRoutes(app, {
    repo,
    auth: new InternalFleetAuth({ internalToken: TOKEN }),
    rateLimitStore: store,
  });
  await app.ready();
  return { app, store, reached };
}

const refused = (retryAfterMs: number): ConsumeResult => ({
  allowed: false,
  remaining: 0,
  retryAfterMs,
});

describe('internal atlas-priority per-token rate limit', () => {
  it('CRITICAL refuses an authenticated request with 429 before the handler touches the repo', async () => {
    const { app, store, reached } = await build(refused(5000));
    const res = await app.inject({ method: 'GET', url: QUEUE, headers: { authorization: AUTH } });
    await app.close();

    expect(res.statusCode).toBe(429);
    expect(store.calls, 'the preHandler must consume exactly one token per request').toHaveLength(
      1,
    );
    expect(
      reached(),
      'a refused request must never reach the repo — otherwise the limit is not a limit',
    ).toBe(false);
    expect(res.json().detail).toContain('internal token');
  });

  it('rounds Retry-After UP so a client never retries before the bucket has refilled', async () => {
    // 2500ms is 2.5s. Rounding down (or truncating) would tell the caller to
    // retry at 2s, half a second before the bucket can satisfy the cost.
    const { app } = await build(refused(2500));
    const res = await app.inject({ method: 'GET', url: QUEUE, headers: { authorization: AUTH } });
    await app.close();

    expect(res.statusCode).toBe(429);
    expect(res.json().retry_after_seconds).toBe(3);
    expect(res.headers['retry-after']).toBe('3');
  });

  it('floors Retry-After at one second, so a sub-second wait never advertises 0', async () => {
    // ceil(10/1000) is 1 here, but the floor is what keeps a 0ms retryAfterMs
    // from advertising "retry immediately" and inviting a hot loop.
    const { app } = await build(refused(0));
    const res = await app.inject({ method: 'GET', url: QUEUE, headers: { authorization: AUTH } });
    await app.close();

    expect(res.statusCode).toBe(429);
    expect(res.json().retry_after_seconds).toBe(1);
  });

  it('CRITICAL buckets on a hash of the token, never on the token itself', async () => {
    // The source comment states the plaintext must not land in the bucket-map
    // key namespace, Redis keyspace, or Prometheus labels. A bucket key is a
    // low-cardinality string that gets logged and labelled freely, so the
    // plaintext leaking into it would spread the credential everywhere the
    // key travels.
    const { app, store } = await build({ allowed: true, remaining: 999, retryAfterMs: 0 });
    await app.inject({ method: 'GET', url: QUEUE, headers: { authorization: AUTH } });
    await app.close();

    const key = store.calls[0]?.key ?? '';
    expect(key).not.toContain(TOKEN);
    expect(key).toBe(
      `atlas_priority_token:${createHash('sha256').update(TOKEN).digest('hex').slice(0, 16)}`,
    );
  });

  it('lets an allowed request through to the handler (positive control)', async () => {
    // Without this, every arm above would still pass if the route refused
    // unconditionally — the refusal arms would be proving nothing.
    const { app, store, reached } = await build({
      allowed: true,
      remaining: 999,
      retryAfterMs: 0,
    });
    const res = await app.inject({ method: 'GET', url: QUEUE, headers: { authorization: AUTH } });
    await app.close();

    expect(res.statusCode).not.toBe(429);
    expect(store.calls).toHaveLength(1);
    expect(reached(), 'an allowed request must reach the handler').toBe(true);
  });

  it('rejects an unauthenticated caller without spending a token from any bucket', async () => {
    // Ordering matters: validate() runs first, so an anonymous flood cannot
    // consume the budget of a token it does not possess.
    const { app, store } = await build(refused(5000));
    const res = await app.inject({ method: 'GET', url: QUEUE });
    await app.close();

    expect(res.statusCode).toBe(401);
    expect(store.calls, 'auth must refuse before any bucket is touched').toHaveLength(0);
  });
});
