// `CliAuthorizeService` over its PRODUCTION Redis store, including both Lua
// scripts, driven through the public initiate → bind → exchange flow.
//
// The service's private `RedisStore` runs two EVAL scripts: a compare-and-set
// that guards the bind transition, and a get-and-delete that makes the
// authorization code one-shot. Measured before writing this, with the signature
// technique that found the pair-mode gap:
//
//   CAS always succeeds (any transition allowed)  → 1 red
//   CAS script is syntactically INVALID           → 1 red   ← the SAME test
//
// Identical signatures for semantically different mutations means the red is
// about the source TEXT changing, not about what the script does — and the test
// in question is `services-cli-authorize-content-parity`, a regex. Every other
// test drives `InMemoryCliAuthorizeStore`, so neither script had ever been
// executed by Redis.
//
// What that protects: the code is a bearer credential that mints an API key. If
// `getDel` stopped consuming, a captured code could be exchanged repeatedly; if
// the CAS stopped guarding, a bind could land on a record that had already moved
// on.
//
// Keys are namespaced by the random code the service generates, so this never
// flushes and cannot disturb another agent's index.

import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CliAuthorizeService } from '../../src/services/cli-authorize.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

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
  'cli-authorize over the production Redis store (real Lua)',
  () => {
    const service = (): CliAuthorizeService => {
      if (!redis) throw new Error('no redis');
      return new CliAuthorizeService({
        redis,
        dashboardOrigin: 'https://app.example.test',
        secretEncryptionKeyBase64: ENCRYPTION_KEY,
      });
    };

    /** initiate + bind, returning what the CLI needs to exchange. */
    async function approved(): Promise<{ code: string; state: string }> {
      const s = service();
      const state = randomBytes(12).toString('hex');
      const started = await s.initiate({ state, client_label: 'zz-test' });
      const bound = await s.bind({
        code: started.code,
        state,
        user_code: started.user_code,
        account_id: `acc-${randomBytes(6).toString('hex')}`,
        api_key_plaintext: `dsk_${randomBytes(16).toString('hex')}`,
      });
      expect(
        bound.account_id,
        'precondition: the bind must succeed, or the arms below prove nothing',
      ).toBeTruthy();
      return { code: started.code, state };
    }

    it('CRITICAL redis is reachable, so the arms below cannot pass vacuously', () => {
      if (!process.env.CI && !process.env.REDIS_URL) return;
      expect(reachable, `redis unreachable at ${REDIS_URL}`).toBe(true);
    });

    it('an approved code exchanges once and returns the minted key', async () => {
      if (!reachable) return;
      const { code, state } = await approved();
      const result = await service().exchange({ code, state });
      expect(result.status, 'the happy path still works').toBe('bound');
    });

    it('CRITICAL the code is ONE-SHOT — a second exchange gets nothing', async () => {
      if (!reachable) return;
      // The code is a bearer credential that yields an API key. Without the
      // atomic get-and-delete, a captured code could be exchanged repeatedly.
      const { code, state } = await approved();
      expect((await service().exchange({ code, state })).status).toBe('bound');
      // After the atomic claim the record is gone, so a replay cannot resolve
      // to a key by any route — whatever status it reports, it must not be
      // `bound`, which is the only status carrying an api_key.
      const replay = await service()
        .exchange({ code, state })
        .catch(() => ({ status: 'threw' as const }));
      expect(replay.status, 'a replayed code must not mint a second key').not.toBe('bound');
    });

    it('CRITICAL two concurrent exchanges: exactly one gets the key', async () => {
      if (!reachable) return;
      // This is what the Lua get-and-delete buys over GET-then-DEL: under the
      // split version both callers read the record before either deletes.
      const { code, state } = await approved();
      const s = service();
      const [a, b] = await Promise.all([
        s.exchange({ code, state }).catch(() => ({ status: 'threw' as const })),
        s.exchange({ code, state }).catch(() => ({ status: 'threw' as const })),
      ]);
      expect(
        [a.status, b.status].filter((st) => st === 'bound'),
        'exactly one exchange may mint the key',
      ).toHaveLength(1);
    });

    it('CRITICAL two CONCURRENT binds: exactly one wins, and the CAS is what separates them', async () => {
      if (!reachable) return;
      // A SEQUENTIAL second bind does not reach the CAS at all — an earlier
      // status check sees the record is no longer pending and throws
      // `already_bound` first. Measured: with the CAS mutated to always
      // succeed, a sequential-double-bind arm stayed GREEN, because it was
      // being answered by that earlier guard rather than by the script under
      // test.
      //
      // Concurrency is what reaches it. Both callers read the record while it
      // is still `pending`, both pass the status check, and only the
      // compare-and-set can decide between them.
      const s2 = service();
      const state = randomBytes(12).toString('hex');
      const started = await s2.initiate({ state, client_label: 'zz-test' });
      const attempt = (accountId: string): Promise<'ok' | 'refused'> =>
        s2
          .bind({
            code: started.code,
            state,
            user_code: started.user_code,
            account_id: accountId,
            api_key_plaintext: `dsk_${randomBytes(16).toString('hex')}`,
          })
          .then(() => 'ok' as const)
          .catch(() => 'refused' as const);

      const results = await Promise.all([attempt('acc-first'), attempt('acc-second')]);
      expect(
        results.filter((r) => r === 'ok'),
        'exactly one concurrent bind may claim the code',
      ).toHaveLength(1);
    });

    it('an unknown code exchanges to nothing rather than erroring', async () => {
      if (!reachable) return;
      const result = await service().exchange({
        code: randomBytes(32).toString('base64url'),
        state: 'nope',
      });
      expect(result.status).not.toBe('bound');
    });
  },
);
