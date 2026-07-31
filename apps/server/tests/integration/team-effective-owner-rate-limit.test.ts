import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../../src/lib/api-keys.js';
import { BoundedMemoryRateLimitStore } from '../../src/lib/bounded-memory-rate-limit-store.js';
import type { AccountRow } from '../../src/services/auth.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const OWNER_ID = '00000000-0000-4000-8000-00000000d001';
const MEMBER_ID = '00000000-0000-4000-8000-00000000d003';
const SECOND_ACTOR_ID = '00000000-0000-4000-8000-00000000d004';
const SECOND_ACTOR_KEY_ID = '00000000-0000-4000-8000-00000000d005';
const SECOND_MEMBER_ID = '00000000-0000-4000-8000-00000000d006';
const TEAM_HEADER = { 'x-driftstack-account': `acc_${OWNER_ID}` };
const POLICY_HEADERS = [
  'x-ratelimit-bucket',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
] as const;

let fx: TestAppFixture | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (fx !== undefined) await fx.cleanup();
  fx = undefined;
});

function account(id: string, email: string, tier: AccountRow['tier']): AccountRow {
  return {
    id,
    email,
    name: null,
    tier,
    status: 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
    updatedAt: new Date('2026-07-30T00:00:00.000Z'),
  };
}

function seedOwner(tier: AccountRow['tier'] = 'free'): void {
  fx!.authRepo.upsertAccount(account(OWNER_ID, 'owner@dual-limit.test', tier));
}

function setPrimaryMembership(role: 'admin' | 'member'): void {
  fx!.authRepo.setTeamMemberships(fx!.accountId, [
    {
      membershipId: MEMBER_ID,
      ownerAccountId: OWNER_ID,
      role,
    },
  ]);
}

async function seedSecondAdmin(): Promise<string> {
  fx!.authRepo.upsertAccount(account(SECOND_ACTOR_ID, 'second-admin@dual-limit.test', 'api_scale'));
  const plaintext = generateApiKey('live');
  fx!.authRepo.upsertApiKey({
    id: SECOND_ACTOR_KEY_ID,
    accountId: SECOND_ACTOR_ID,
    name: 'second-admin',
    keyPrefix: keyPrefixFromPlaintext(plaintext),
    keyHash: await hashApiKey(plaintext),
    scopes: ['read', 'write'],
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
  });
  fx!.authRepo.setTeamMemberships(SECOND_ACTOR_ID, [
    {
      membershipId: SECOND_MEMBER_ID,
      ownerAccountId: OWNER_ID,
      role: 'admin',
    },
  ]);
  return plaintext;
}

function setOverride(accountId: string, bucketKey: string, capacity: number): void {
  fx!.authRepo.setRateLimitOverride(accountId, {
    bucketKey,
    capacity,
    refillPerSecond: 0.001,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
}

async function drain(accountId: string, bucketKey: string, capacity = 1): Promise<void> {
  await fx!.rateLimitStore.consume({
    key: `rl:${accountId}:${bucketKey}`,
    capacity,
    refillPerSecond: 0.001,
    cost: capacity,
    now: Date.now(),
  });
}

function expectGenericOwnerDenial(response: {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  json<T>(): T;
}): void {
  expect(response.statusCode).toBe(429);
  expect(response.headers['retry-after']).toBeDefined();
  for (const header of POLICY_HEADERS) expect(response.headers[header]).toBeUndefined();
  const body = response.json<{ detail: string; retry_after_seconds: number }>();
  expect(body.detail).toBe('Rate limit exceeded.');
  expect(body.retry_after_seconds).toBeGreaterThan(0);
  expect(JSON.stringify(body)).not.toContain('free');
  expect(JSON.stringify(body)).not.toContain('global');
  expect(JSON.stringify(body)).not.toContain('capacity');
}

describe('team-resource actor + effective-owner rate limiting', () => {
  it('rejects insufficient session-read scope before actor or selected-owner budget work', async () => {
    fx = await buildTestApp({ tier: 'api_scale', scopes: ['write:sessions'] });
    seedOwner();
    setPrimaryMembership('admin');
    const ownerGet = vi.spyOn(fx.authRepo, 'getAccount');
    const ownerOverrides = vi.spyOn(fx.authRepo, 'findActiveRateLimitOverrides');
    const consume = vi.spyOn(fx.rateLimitStore, 'consume');
    const list = vi.spyOn(fx.sessionsRepo, 'listSessions');

    const denied = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, ...TEAM_HEADER },
    });

    expect(denied.statusCode).toBe(403);
    expect(ownerGet.mock.calls.filter(([id]) => id === OWNER_ID)).toHaveLength(0);
    expect(ownerOverrides.mock.calls.filter(([id]) => id === OWNER_ID)).toHaveLength(0);
    expect(
      consume.mock.calls.filter(
        ([input]) =>
          input.key === `rl:${fx!.accountId}:global` || input.key === `rl:${OWNER_ID}:global`,
      ),
    ).toHaveLength(0);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects authorization before owner lookup, then charges actor first without refund and performs no create/driver/Fleet work', async () => {
    fx = await buildTestApp({ tier: 'api_scale', enableAgentRuntime: true });
    seedOwner();
    setPrimaryMembership('member');

    const ownerGet = vi.spyOn(fx.authRepo, 'getAccount');
    const ownerOverrides = vi.spyOn(fx.authRepo, 'findActiveRateLimitOverrides');
    const directInsert = vi.spyOn(fx.sessionsRepo, 'insertSessionIfUnderLimit');
    const driverCreate = vi.spyOn(fx.driver, 'createSession');
    const agentInsert = vi.spyOn(fx.agentSessionsRepo!, 'createIfUnderActiveCap');

    const malformed = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': 'not-an-account-id',
      },
      payload: {},
    });
    expect(malformed.statusCode).toBe(403);

    const member = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, ...TEAM_HEADER },
      payload: {},
    });
    expect(member.statusCode).toBe(403);
    expect(ownerGet.mock.calls.filter(([id]) => id === OWNER_ID)).toHaveLength(0);
    expect(ownerOverrides.mock.calls.filter(([id]) => id === OWNER_ID)).toHaveLength(0);
    expect(directInsert).not.toHaveBeenCalled();
    expect(driverCreate).not.toHaveBeenCalled();

    setPrimaryMembership('admin');
    setOverride(fx.accountId, 'sessions:create', 1);
    setOverride(fx.accountId, 'global', 1);
    setOverride(OWNER_ID, 'sessions:create', 1);
    setOverride(OWNER_ID, 'global', 1);
    await drain(OWNER_ID, 'sessions:create');
    await drain(OWNER_ID, 'global');

    const directDenied = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, ...TEAM_HEADER },
      payload: {},
    });
    expectGenericOwnerDenial(directDenied);

    const agentDenied = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, ...TEAM_HEADER },
      payload: {},
    });
    expectGenericOwnerDenial(agentDenied);

    // ONE read pair, not one per request: both denials fall inside the owner
    // authority window, so the second is served from the plugin-local cache.
    // The load-bearing claims either side are unchanged — zero owner reads
    // before authorization (asserted above), a real owner read once authorized.
    // Pinned exactly, so deleting the cache OR the lookup reds this.
    expect(ownerGet.mock.calls.filter(([id]) => id === OWNER_ID)).toHaveLength(1);
    expect(ownerOverrides.mock.calls.filter(([id]) => id === OWNER_ID)).toHaveLength(1);
    expect(directInsert).not.toHaveBeenCalled();
    expect(driverCreate).not.toHaveBeenCalled();
    expect(agentInsert).not.toHaveBeenCalled();
    expect(fx.sessionsRepo.getEvents()).toEqual([]);

    // The actor's global token was consumed even though the owner rejected. A
    // second global call dies at the actor bucket and performs no third owner
    // lookup; the sessions:create actor token was likewise never refunded.
    const actorDenied = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, ...TEAM_HEADER },
    });
    expect(actorDenied.statusCode).toBe(429);
    // Still no FURTHER owner lookup — the actor bucket refused before the owner
    // path was reached at all, which is the claim here (the count is unchanged
    // from above rather than incremented).
    expect(ownerGet.mock.calls.filter(([id]) => id === OWNER_ID)).toHaveLength(1);
    expect(ownerOverrides.mock.calls.filter(([id]) => id === OWNER_ID)).toHaveLength(1);
  });

  it('collapses a concurrent burst to ONE owner authority read instead of one per request', async () => {
    // The owner lookup is two uncached Postgres reads (account row + active
    // overrides) that run BEFORE the token check, so without coalescing the
    // limiter amplifies the database load it exists to cap. The actor bucket
    // bounds it, but a large team on a high tier still multiplies it by every
    // member's budget. A burst for one owner must cost one read pair.
    fx = await buildTestApp({ tier: 'api_scale' });
    seedOwner('api_scale');
    setPrimaryMembership('admin');
    const ownerGet = vi.spyOn(fx.authRepo, 'getAccount');
    const ownerOverrides = vi.spyOn(fx.authRepo, 'findActiveRateLimitOverrides');

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        fx!.app.inject({
          method: 'GET',
          url: '/v1/sessions',
          headers: { authorization: `Bearer ${fx!.plaintext}`, ...TEAM_HEADER },
        }),
      ),
    );

    // Every request still succeeded on its own merits — this is a read-cost
    // optimisation, never an admission shortcut.
    for (const response of responses) expect(response.statusCode).toBe(200);
    expect(ownerGet.mock.calls.filter(([id]) => id === OWNER_ID)).toHaveLength(1);
    expect(ownerOverrides.mock.calls.filter(([id]) => id === OWNER_ID)).toHaveLength(1);
  });

  it('aggregates two distinct admins into the selected owner capacity using the live owner override', async () => {
    fx = await buildTestApp({ tier: 'api_scale' });
    seedOwner('free');
    setPrimaryMembership('admin');
    const secondPlaintext = await seedSecondAdmin();
    setOverride(OWNER_ID, 'global', 1);

    const consume = vi.spyOn(fx.rateLimitStore, 'consume');
    const responses = await Promise.all([
      fx.app.inject({
        method: 'GET',
        url: '/v1/sessions',
        headers: { authorization: `Bearer ${fx.plaintext}`, ...TEAM_HEADER },
      }),
      fx.app.inject({
        method: 'GET',
        url: '/v1/sessions',
        headers: { authorization: `Bearer ${secondPlaintext}`, ...TEAM_HEADER },
      }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 429]);
    expectGenericOwnerDenial(responses.find((response) => response.statusCode === 429)!);
    const ownerConsumes = consume.mock.calls
      .map(([input]) => input)
      .filter((input) => input.key === `rl:${OWNER_ID}:global`);
    expect(ownerConsumes).toHaveLength(2);
    expect(ownerConsumes.every((input) => input.capacity === 1)).toBe(true);
    expect(
      ownerConsumes.map((input) => input.key).filter((key) => key.includes(fx!.accountId)),
    ).toEqual([]);
  });

  it('fails closed and performs no handler work when live owner authority or both stores fail', async () => {
    fx = await buildTestApp({ tier: 'api_scale' });
    seedOwner();
    setPrimaryMembership('admin');
    const list = vi.spyOn(fx.sessionsRepo, 'listSessions');
    const realGetAccount = fx.authRepo.getAccount.bind(fx.authRepo);
    const accountLookup = vi
      .spyOn(fx.authRepo, 'getAccount')
      .mockImplementation((id) =>
        id === OWNER_ID
          ? Promise.reject(new Error('owner authority unavailable'))
          : realGetAccount(id),
      );

    const authorityDenied = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, ...TEAM_HEADER },
    });
    expectGenericOwnerDenial(authorityDenied);
    expect(list).not.toHaveBeenCalled();

    accountLookup.mockRestore();
    const realConsume = fx.rateLimitStore.consume.bind(fx.rateLimitStore);
    vi.spyOn(fx.rateLimitStore, 'consume').mockImplementation((input) =>
      input.key === `rl:${OWNER_ID}:global`
        ? Promise.reject(new Error('primary store unavailable'))
        : realConsume(input),
    );
    vi.spyOn(BoundedMemoryRateLimitStore.prototype, 'consume').mockRejectedValue(
      new Error('fallback store unavailable'),
    );

    const storesDenied = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, ...TEAM_HEADER },
    });
    expectGenericOwnerDenial(storesDenied);
    expect(list).not.toHaveBeenCalled();
  });

  it('answers an owner suspended inside the cached-membership window with an exact 403, not a retryable 429', async () => {
    // db/auth-repo.ts findTeamMemberships already filters memberships to
    // active owners, so a steady-state suspended owner never reaches here at
    // all — that query's own comment names the residual: a member's CACHED
    // cross-account context. Inside that window ctx.teams still carries the
    // membership while the limiter's fresh getAccount sees the new status.
    // Owner availability is deterministic state, not capacity, so it must not
    // be published as a 429: the SDK retries 429 and no other 4xx
    // (packages/sdk-typescript/src/retry.ts), which would spin the caller for
    // the whole cache window instead of reporting the real, permanent reason.
    for (const [status, detail] of [
      ['suspended', 'Owner account is suspended.'],
      ['deleted', 'Owner account no longer exists.'],
    ] as const) {
      fx = await buildTestApp({ tier: 'api_scale' });
      seedOwner('api_scale');
      setPrimaryMembership('admin');
      const list = vi.spyOn(fx.sessionsRepo, 'listSessions');
      const realGetAccount = fx.authRepo.getAccount.bind(fx.authRepo);
      // The membership snapshot stays as loaded; only the live owner row moves.
      vi.spyOn(fx.authRepo, 'getAccount').mockImplementation((id) =>
        id === OWNER_ID
          ? Promise.resolve({ ...account(OWNER_ID, 'owner@dual-limit.test', 'api_scale'), status })
          : realGetAccount(id),
      );

      const denied = await fx.app.inject({
        method: 'GET',
        url: '/v1/sessions',
        headers: { authorization: `Bearer ${fx.plaintext}`, ...TEAM_HEADER },
      });

      expect(denied.statusCode).toBe(403);
      expect(denied.headers['retry-after']).toBeUndefined();
      const body = denied.json<{ detail: string }>();
      expect(body.detail).toBe(detail);
      // Availability is stated; owner capacity/tier/override still are not.
      expect(JSON.stringify(body)).not.toContain('capacity');
      expect(JSON.stringify(body)).not.toContain('api_scale');
      expect(list).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      await fx.cleanup();
      fx = undefined;
    }

    // An owner whose row has disappeared entirely is the same exact outcome.
    fx = await buildTestApp({ tier: 'api_scale' });
    seedOwner('api_scale');
    setPrimaryMembership('admin');
    const realGetAccount = fx.authRepo.getAccount.bind(fx.authRepo);
    vi.spyOn(fx.authRepo, 'getAccount').mockImplementation((id) =>
      id === OWNER_ID ? Promise.resolve(null) : realGetAccount(id),
    );
    const absent = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}`, ...TEAM_HEADER },
    });
    expect(absent.statusCode).toBe(403);
    expect(absent.json<{ detail: string }>().detail).toBe('Owner account no longer exists.');
    expect(absent.headers['retry-after']).toBeUndefined();
  });

  it('charges explicit self and a per-session control key exactly once', async () => {
    fx = await buildTestApp({ tier: 'api_scale', enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'manual' },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json<{ id: string }>().id;
    const minted = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}/gui-control-key`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(minted.statusCode).toBe(200);
    const controlKey = minted.json<{ gui_control_key: string }>().gui_control_key;

    fx.rateLimitStore.reset();
    const consume = vi.spyOn(fx.rateLimitStore, 'consume');
    const accountLookup = vi.spyOn(fx.authRepo, 'getAccount');
    const self = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'x-driftstack-account': `acc_${fx.accountId}`,
      },
    });
    expect(self.statusCode).toBe(200);
    expect(
      consume.mock.calls.filter(([input]) => input.key === `rl:${fx!.accountId}:global`),
    ).toHaveLength(1);
    expect(accountLookup.mock.calls.filter(([idValue]) => idValue === fx!.accountId)).toHaveLength(
      1,
    );

    fx.rateLimitStore.reset();
    consume.mockClear();
    accountLookup.mockClear();
    const control = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${id}`,
      headers: { 'x-driftstack-gui-control-key': controlKey },
    });
    expect(control.statusCode).toBe(200);
    expect(
      consume.mock.calls.filter(([input]) => input.key === `rl:${fx!.accountId}:global`),
    ).toHaveLength(1);
    expect(accountLookup.mock.calls.filter(([idValue]) => idValue === fx!.accountId)).toHaveLength(
      0,
    );
  });

  it('rejects owner-limited SSE messages before headers, transcript, LLM usage, tokens, or activity mutate', async () => {
    fx = await buildTestApp({
      tier: 'api_scale',
      enableAgentRuntime: true,
      captureAgentDecomposerUsage: true,
    });
    seedOwner();
    setPrimaryMembership('admin');
    const session = await fx.agentSessionsRepo!.create({
      accountId: OWNER_ID,
      tokenBudgetTotal: 50_000,
    });
    setOverride(OWNER_ID, 'agent_sessions:message', 1);
    await drain(OWNER_ID, 'agent_sessions:message');

    const append = vi.spyOn(fx.agentSessionsRepo!, 'appendTranscriptIfAuthorityRevision');
    const appendActive = vi.spyOn(fx.agentSessionsRepo!, 'appendTranscriptIfActive');
    const debit = vi.spyOn(fx.agentSessionsRepo!, 'debitTokensIfActive');
    const before = await fx.agentSessionsRepo!.get(session.id);

    const denied = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${session.id}/message`,
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        accept: 'text/event-stream',
        ...TEAM_HEADER,
      },
      payload: { user_message: 'click the primary button' },
    });

    expectGenericOwnerDenial(denied);
    expect(denied.headers['content-type']).toContain('application/problem+json');
    expect(denied.body).not.toContain(': stream open');
    expect(append).not.toHaveBeenCalled();
    expect(appendActive).not.toHaveBeenCalled();
    expect(debit).not.toHaveBeenCalled();
    expect(fx.agentDecomposerUsageRecords).toEqual([]);
    expect(await fx.agentSessionsRepo!.get(session.id)).toEqual(before);
  });
});
