// B2 — the cross-process Stop channel against a real Redis, through the SAME
// adapter bootstrap wires (`agentTurnStopRedisAdapter`), so the commands and the
// release Lua that run here are the ones production sends. A hand-written fake
// would prove only that the fake agrees with itself.
//
// Keys are per-test UUIDs, so this never flushes and cannot disturb another
// agent's keys.

import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_TURN_CLAIM_TTL_SECONDS,
  agentTurnStopRedisAdapter,
  RedisAgentTurnStopChannel,
} from '../../src/services/agent-turn-stop-channel.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

let redis: Redis | null = null;
let reachable = false;

beforeAll(async () => {
  const client = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await client.connect();
    await client.ping();
    redis = client;
    reachable = true;
  } catch {
    await client.quit().catch(() => {});
  }
});

afterAll(async () => {
  if (redis) await redis.quit().catch(() => {});
});

describe.skipIf(!process.env.CI && !process.env.REDIS_URL)(
  'redis agent-turn stop channel (production adapter, real Lua)',
  () => {
    const channel = (): RedisAgentTurnStopChannel => {
      if (!redis) throw new Error('no redis');
      return new RedisAgentTurnStopChannel(agentTurnStopRedisAdapter(redis));
    };
    const session = (): string => `zz-test-stop-${randomUUID()}`;

    it('CRITICAL redis is reachable, so the arms below cannot pass vacuously', () => {
      expect(reachable, `redis unreachable at ${REDIS_URL}`).toBe(true);
    });

    it('no claim → "nothing running"; a claim → the stop is recorded against THAT turn only', async () => {
      const c = channel();
      const s = session();
      await expect(c.requestStop(s)).resolves.toBe(false);
      await c.claim(s, 'turn-a');
      await expect(c.requestStop(s)).resolves.toBe(true);
      await expect(c.stopRequested(s, 'turn-a')).resolves.toBe(true);
      // A later turn on the same session is never stopped by an earlier stop.
      await expect(c.stopRequested(s, 'turn-b')).resolves.toBe(false);
      await c.release(s, 'turn-a');
    });

    it('CRITICAL release is compare-and-delete: a late release of an OLD turn leaves the new turn’s claim alone', async () => {
      const c = channel();
      const s = session();
      await c.claim(s, 'turn-old');
      // A new turn claims the session (another process, say) …
      await c.claim(s, 'turn-new');
      // … and the old turn's release lands late.
      await c.release(s, 'turn-old');
      await expect(c.requestStop(s)).resolves.toBe(true);
      await expect(c.stopRequested(s, 'turn-new')).resolves.toBe(true);
      // Its own release clears both the claim and the stop.
      await c.release(s, 'turn-new');
      await expect(c.requestStop(s)).resolves.toBe(false);
      await expect(c.stopRequested(s, 'turn-new')).resolves.toBe(false);
    });

    it('claims EXPIRE, so a process that dies mid-turn cannot leave "a turn is running" behind forever', async () => {
      if (!redis) throw new Error('no redis');
      const c = channel();
      const s = session();
      await c.claim(s, 'turn-a');
      const ttl = await redis.ttl(`agent_turn:claim:${s}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(AGENT_TURN_CLAIM_TTL_SECONDS);
      await c.release(s, 'turn-a');
    });
  },
);
