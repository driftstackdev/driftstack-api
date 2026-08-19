// V-1046 — a member acting as an owner charges their OWN bucket at their OWN capacity.
//
// `middleware/rate-limit.ts` carries a long note about a real, destructive bug on
// the control-key path. The store key is `rl:<accountId>:<bucketKey>` with no tier
// in it, so two writers can land on the SAME Redis key; the token-bucket script
// persists `math.min(capacity, …)`, and a writer arriving with a lower capacity
// permanently truncates the other's bucket. A control key charging a conservative
// `free` floor collapsed a paying `api_scale` owner's 6,000-token bucket to about
// 59, for as long as the desktop Simulator was polling. The note states the
// invariant that came out of it:
//
//     Two writers sharing one key MUST agree on its capacity.
//
// The team acting-as path is the other place two identities can touch one account's
// traffic, so it is worth knowing which side of that invariant it sits on. Measured:
// a `solo_manual` member acting as an `api_scale` owner is charged 120 — their own
// tier — and the Redis key written is `rl:<memberId>:global`, not the owner's.
//
// That is coherent and safe: the member spends their own budget at their own
// capacity, so there is no shared key and no truncation to be had. It is NOT the
// only design that would have looked reasonable — charging the owner's bucket at
// the owner's capacity is defensible too — but it is the one that ships, and the
// combination is what matters. Charging the OWNER's key at the MEMBER's capacity is
// the exact shape that destroyed a customer's bucket once already.
//
// So this pins the pair together rather than either half alone. A future change
// that routes team traffic onto the owner's key without also adopting the owner's
// capacity fails here.

import { createHash, randomUUID } from 'node:crypto';
import { TIER_RATE_LIMIT_DEFAULTS } from '@driftstack/api-types';
import { expect, test } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { authHeader, seedAccount } from './helpers/seed.js';

const OWNER_TIER = 'api_scale';
const MEMBER_TIER = 'solo_manual';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test('the two tiers differ, or this file proves nothing', () => {
  const ownerCap = TIER_RATE_LIMIT_DEFAULTS[OWNER_TIER].global.capacity;
  const memberCap = TIER_RATE_LIMIT_DEFAULTS[MEMBER_TIER].global.capacity;
  expect(
    ownerCap,
    'owner and member tiers must have different capacities for the assertions below to distinguish ' +
      'anything',
  ).not.toBe(memberCap);
});

test('acting as an owner does not write the owner bucket, and applies the member capacity', async ({
  request,
}) => {
  const owner = await seedAccount(server.client, {
    email: `own-${randomUUID().slice(0, 8)}@driftstack.test`,
    tier: OWNER_TIER,
  });
  const email = `mem-${randomUUID().slice(0, 8)}@driftstack.test`;
  const member = await seedAccount(server.client, { email, tier: MEMBER_TIER });
  const token = `inv-${randomUUID()}`;
  const hash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  await server.client`
    INSERT INTO team_invites
      (id, owner_account_id, invited_by_account_id, invitee_email,
       role, invite_token_hash, invite_expires_at)
    VALUES (${randomUUID()}, ${owner.accountId}, ${owner.accountId}, ${email},
            'admin', ${hash}, ${expiresAt}::timestamptz)
  `;
  const accepted = await request.post(`${server.baseUrl}/v1/team/invites/accept`, {
    headers: authHeader(member.plaintext),
    data: { token },
  });
  expect(accepted.status(), 'the membership was created').toBe(200);

  await server.redis.del(`rl:${owner.accountId}:global`, `rl:${member.accountId}:global`);

  const res = await request.get(`${server.baseUrl}/v1/account/me`, {
    headers: {
      ...authHeader(member.plaintext),
      'x-driftstack-account': `acc_${owner.accountId}`,
    },
  });
  expect(res.status(), 'the member may act as the owner').toBe(200);

  const applied = Number(res.headers()['x-ratelimit-limit']);
  const memberCap = TIER_RATE_LIMIT_DEFAULTS[MEMBER_TIER].global.capacity;
  const ownerCap = TIER_RATE_LIMIT_DEFAULTS[OWNER_TIER].global.capacity;
  expect(
    applied,
    `acting as an ${OWNER_TIER} owner charged ${applied}; the member is ${MEMBER_TIER} (${memberCap})`,
  ).toBe(memberCap);

  // The load-bearing half. If team traffic ever moves onto the OWNER's key while
  // still carrying the member's capacity, the Lua min() truncates a paying
  // customer's bucket — the failure the note in rate-limit.ts documents.
  const ownerKey = await server.redis.exists(`rl:${owner.accountId}:global`);
  const memberKeyExists = await server.redis.exists(`rl:${member.accountId}:global`);
  expect(memberKeyExists, "the member's own bucket was charged").toBe(1);
  expect(
    ownerKey,
    `the owner's bucket was written by a ${MEMBER_TIER} caller applying capacity ${applied}; the ` +
      `owner is ${OWNER_TIER} (${ownerCap}), and the token-bucket script persists min(capacity, …)`,
  ).toBe(0);
});
