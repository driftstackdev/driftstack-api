// ITEM 4 — the freshness CLAIM, against a real Postgres.
//
// The unit file (`a-background-proxy-refresh-never-condemns-on-one-failure`)
// proves the SERVICE claims rather than lists, driven through the in-memory
// double. It cannot prove what the double stands in for, and every load-bearing
// part of this query lives exactly there:
//
//   * `FOR UPDATE SKIP LOCKED` — without it a second worker BLOCKS on the row the
//     first is holding and then claims it too, which for this sweep means a second
//     connection dialled through a customer's proxy for one scheduled refresh;
//   * `JOIN accounts a … a.status = 'active'` — deletion is SOFT and the
//     retention purge keeps the proxy rows, so without it the sweep dials an
//     erased customer's provider forever, without their credentials;
//   * the claim's `freshness_consecutive_failures = CASE …` reset, which is the
//     only place "somebody observed this exit since we last dialled" can be
//     asked, because the statement's own SET overwrites the value it compares;
//   * the condemn CASE's `exit_observed_at <= probeStartedAt` disjunct, so a
//     customer's mid-sweep Test is not condemned by our older failure;
//   * the literal `scheme IN ('socks5','http')` predicate — a VPN row needs a
//     fleet node to bring its tunnel up and can never be refreshed from here;
//   * `NOT EXISTS (… agent_sessions … status <> 'closed')` — a proxy a live
//     session is browsing through is left alone;
//   * the linear failure backoff, so a proxy that is simply switched off is
//     dialled once a day rather than four times.
//
// Each of those is a clause that type-checks whether or not it is there. Only a
// database can say whether it is.
//
// Runs on its OWN database (migrated by the helper, so migration 0123 is applied
// by construction) — this file writes `accounts`, `account_proxies` and
// `agent_sessions` rows and reads a GLOBAL, cross-account query, so on a shared
// database its results would depend on whatever else was running.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleAccountProxiesRepo } from '../../src/db/account-proxies-repo.js';
import { assertIsolatedDatabase, ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import type * as schema from '../../src/db/schema.js';

const ISOLATED_DB_NAME = 'driftstack_iso_proxy_freshness';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const NOW = new Date('2026-09-16T12:00:00.000Z');

let client: ReturnType<typeof postgres> | null = null;
let other: ReturnType<typeof postgres> | null = null;
let accountId = '';

function repoFor(sqlClient: ReturnType<typeof postgres>): DrizzleAccountProxiesRepo {
  return new DrizzleAccountProxiesRepo({
    client: sqlClient,
    db: drizzle(sqlClient) as unknown as ReturnType<typeof drizzle<typeof schema>>,
    close: async () => {},
  });
}

const claimOn = (sqlClient: ReturnType<typeof postgres>, now: Date = NOW) =>
  repoFor(sqlClient).claimDueForFreshnessRefresh({
    now,
    refreshIntervalMs: SIX_HOURS_MS,
    maxBackoffSteps: 4,
  });

async function insertProxy(args: {
  id: string;
  scheme?: string;
  attemptedAt?: Date | null;
  failures?: number;
  exitObserved?: Record<string, unknown> | null;
  exitObservedAt?: Date | null;
  /** Defaults to the active account seeded in `beforeEach`. */
  owner?: string;
}): Promise<void> {
  await client!`
    INSERT INTO account_proxies (
      id, account_id, label, scheme, host, port,
      freshness_attempted_at, freshness_consecutive_failures,
      exit_observed, exit_observed_at, updated_at
    ) VALUES (
      ${args.id}::uuid, ${args.owner ?? accountId}::uuid, 'p', ${args.scheme ?? 'socks5'},
      'proxy.example.com', 1080,
      ${args.attemptedAt === undefined || args.attemptedAt === null ? null : args.attemptedAt.toISOString()}::timestamptz,
      ${args.failures ?? 0},
      ${args.exitObserved === undefined || args.exitObserved === null ? null : JSON.stringify(args.exitObserved)}::jsonb,
      ${args.exitObservedAt === undefined || args.exitObservedAt === null ? null : args.exitObservedAt.toISOString()}::timestamptz,
      ${new Date('2026-01-01T00:00:00.000Z').toISOString()}::timestamptz
    )`;
}

async function insertSession(proxyId: string, status: string): Promise<void> {
  await client!`
    INSERT INTO agent_sessions (
      id, account_id, status, token_budget_total, token_budget_remaining, proxy_id
    ) VALUES (
      ${randomUUID()}::uuid, ${accountId}::uuid, ${status}, 100, 100, ${proxyId}::uuid
    )`;
}

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null || !RUN_DB_TESTS) return;
  const candidate = postgres(isolated, { max: 3 });
  try {
    await candidate`SELECT 1`;
  } catch {
    await candidate.end({ timeout: 1 }).catch(() => {});
    return;
  }
  // This file DELETEs whole tables; prove the connection before that runs.
  await assertIsolatedDatabase(candidate, ISOLATED_DB_NAME);
  client = candidate;
  // A SECOND connection, because `FOR UPDATE SKIP LOCKED` is only observable
  // between two sessions — one holding a row lock while the other claims.
  other = postgres(isolated, { max: 3 });
});

beforeEach(async () => {
  if (!client) return;
  await client`DELETE FROM agent_sessions`;
  await client`DELETE FROM account_proxies`;
  await client`DELETE FROM accounts`;
  accountId = randomUUID();
  await client`INSERT INTO accounts (id, email) VALUES (${accountId}::uuid, ${`freshness-${accountId}@example.test`})`;
});

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await other?.end({ timeout: 5 }).catch(() => {});
});

describe.skipIf(!RUN_DB_TESTS)('the freshness claim, on real Postgres', () => {
  it('CRITICAL the database is reachable and migrated, so nothing below can pass vacuously. Every arm returns early when the connection is null, which is right when there is no Postgres — but a green that means "the database was missing" is indistinguishable from one that means "the database agreed".', () => {
    expect(client, 'postgres unreachable or unmigrated — the arms below never ran').not.toBeNull();
  });

  it('CRITICAL a row another session is holding is SKIPPED, not waited for. Without SKIP LOCKED this call blocks until the holder commits and then claims the very same proxy — two dials through one customer proxy for one scheduled refresh, and a tick that spends its whole budget waiting.', async () => {
    if (!client || !other) return;
    const held = '00000000-0000-4000-8000-0000000000a1';
    const free = '00000000-0000-4000-8000-0000000000a2';
    await insertProxy({ id: held });
    await insertProxy({ id: free });

    // Hold a real row lock on `held` in another session, then claim.
    await other.begin(async (tx) => {
      await tx`SELECT id FROM account_proxies WHERE id = ${held}::uuid FOR UPDATE`;
      const claimed = await Promise.race([
        claimOn(client!),
        new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 3_000)),
      ]);
      expect(claimed, 'the claim must return rather than block on the held row').not.toBe(
        'blocked',
      );
      expect(
        claimed === 'blocked' ? null : claimed?.id,
        'and it takes the OTHER due proxy instead',
      ).toBe(free);
    });
  });

  it('CRITICAL two workers ticking at the same moment take different proxies, and once a row is claimed it is no longer due. The claim and the attempt stamp are ONE statement, so there is no window in which both see the same row as unclaimed.', async () => {
    if (!client || !other) return;
    const a = '00000000-0000-4000-8000-0000000000b1';
    const b = '00000000-0000-4000-8000-0000000000b2';
    await insertProxy({ id: a });
    await insertProxy({ id: b });

    const [first, second] = await Promise.all([claimOn(client), claimOn(other)]);
    // ⛔ THE MESSAGE CARRIES THE VALUES ON PURPOSE. This arm failed at the push
    // gate on 2026-09-16 (twice) and has never failed anywhere else: 20 runs of
    // this file alone and a full 413-file integration pass are all green, so it
    // reproduces only under whole-gate load. Two different defects produce the
    // same "expected [ …(2) ] to deeply equal [ …(2) ]" line, and they are not
    // equally serious — two workers taking the SAME proxy means SKIP LOCKED is not
    // doing its job and a customer's proxy gets dialled twice per window, while
    // one worker taking NOTHING is a starved tick and merely wasteful.
    //
    // The default diff prints neither, so both previous failures were unreadable
    // after the fact and I could only guess between them. Naming them here costs
    // nothing on the green path and makes the next failure answerable on sight
    // rather than inviting a third round of reasoning from a truncated log.
    expect(
      [first?.id, second?.id].sort(),
      `one each — first=${String(first?.id)} second=${String(second?.id)} (same id means SKIP LOCKED failed; an undefined means a worker claimed nothing)`,
    ).toEqual([a, b].sort());
    expect(first?.freshnessAttemptedAt?.toISOString(), 'the claim records the attempt').toBe(
      NOW.toISOString(),
    );

    const third = await claimOn(client);
    expect(third, 'both are now inside their cooldown').toBeNull();
  });

  it('CRITICAL a VPN row is never claimed. Bringing an OpenVPN/WireGuard tunnel up needs a fleet node — the control plane cannot dial one — so a VPN refresh is a different piece of work, not an oversight.', async () => {
    if (!client) return;
    await insertProxy({ id: '00000000-0000-4000-8000-0000000000c1', scheme: 'openvpn' });
    await insertProxy({ id: '00000000-0000-4000-8000-0000000000c2', scheme: 'wireguard' });
    const http = '00000000-0000-4000-8000-0000000000c3';
    await insertProxy({ id: http, scheme: 'http' });

    const claimed = await claimOn(client);
    expect(claimed?.id, 'the http row IS in scope; the two VPN rows are not').toBe(http);
    expect(await claimOn(client), 'and nothing else is claimable').toBeNull();
  });

  it("CRITICAL a proxy a LIVE agent session is using is never claimed, and becomes claimable again the moment that session closes. The session is already writing that row's exit through the relay, and a background dial would add a connection while the customer is browsing through it.", async () => {
    if (!client) return;
    const busy = '00000000-0000-4000-8000-0000000000d1';
    await insertProxy({ id: busy });
    await insertSession(busy, 'active');

    expect(await claimOn(client), 'held by a live session').toBeNull();

    await client`UPDATE agent_sessions SET status = 'closed' WHERE proxy_id = ${busy}::uuid`;
    expect((await claimOn(client))?.id, 'a closed session holds nothing').toBe(busy);
  });

  it("CRITICAL a proxy whose exit somebody ELSE already refreshed is not claimed. A live session's relay and the customer's own Test both write exit_observed_at, and a reading taken an hour ago is exactly as fresh as one this sweep would take — dialling for it spends the customer's bandwidth to learn nothing.", async () => {
    if (!client) return;
    const fresh = '00000000-0000-4000-8000-0000000000d7';
    await insertProxy({
      id: fresh,
      exitObserved: { ip: '203.0.113.9', country: 'NL', timezone: null, observed_via: 'session' },
      exitObservedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });
    expect(await claimOn(client), 'someone else made it current within the window').toBeNull();

    await client`UPDATE account_proxies SET exit_observed_at = ${new Date(
      NOW.getTime() - SIX_HOURS_MS - 1000,
    ).toISOString()}::timestamptz WHERE id = ${fresh}::uuid`;
    expect((await claimOn(client))?.id, 'and past the window it is ours to re-take').toBe(fresh);
  });

  it('CRITICAL a repeatedly failing proxy backs off instead of being dialled every interval. A proxy the customer switched off is not a reason to open a connection to it four times a day forever — and it must never fall out of the sweep entirely, because it has to be able to come back on its own.', async () => {
    if (!client) return;
    const id = '00000000-0000-4000-8000-0000000000e1';
    // Two prior failures → due only after interval × 3.
    await insertProxy({
      id,
      failures: 2,
      attemptedAt: new Date(NOW.getTime() - SIX_HOURS_MS * 2),
    });
    expect(await claimOn(client), 'twelve hours is not yet due at two failures').toBeNull();

    const later = new Date(NOW.getTime() + SIX_HOURS_MS * 2);
    expect((await claimOn(client, later))?.id, 'but a day later it is').toBe(id);
  });

  it('CRITICAL a proxy whose ACCOUNT is not active is never claimed. Deletion here is SOFT and the retention purge nulls the SECRETS, not the rows (`clearProxySecretsForAccount` — "Nulls the SECRETS, not the rows"), so without the accounts join an erased customer\'s proxies stay claimable forever: four dials a day at their provider, unauthenticated (post-purge `wrapped_password IS NULL` is indistinguishable from "no password configured"), writing NEW measurements onto the row of somebody who asked to be erased. MUTATION: delete the `JOIN accounts a … a.status = \'active\'` from the due CTE and this reds.', async () => {
    if (!client) return;
    const deletedAccount = randomUUID();
    const suspendedAccount = randomUUID();
    await client`INSERT INTO accounts (id, email, status, deleted_at)
                 VALUES (${deletedAccount}::uuid, ${`gone-${deletedAccount}@example.test`}, 'deleted', now())`;
    await client`INSERT INTO accounts (id, email, status)
                 VALUES (${suspendedAccount}::uuid, ${`paused-${suspendedAccount}@example.test`}, 'suspended')`;

    const erased = '00000000-0000-4000-8000-0000000000e7';
    const paused = '00000000-0000-4000-8000-0000000000e8';
    const live = '00000000-0000-4000-8000-0000000000e9';
    await insertProxy({ id: erased, owner: deletedAccount });
    await insertProxy({ id: paused, owner: suspendedAccount });
    await insertProxy({ id: live });

    expect(
      (await claimOn(client))?.id,
      'three identically-due proxies; only the active account’s is claimable',
    ).toBe(live);
    expect(await claimOn(client), 'and neither of the others is ever reached').toBeNull();

    const untouched = await client<Array<{ id: string; freshness_attempted_at: Date | null }>>`
      SELECT id, freshness_attempted_at FROM account_proxies
       WHERE id IN (${erased}::uuid, ${paused}::uuid)`;
    expect(untouched).toHaveLength(2);
    for (const row of untouched) {
      expect(row.freshness_attempted_at, `${row.id} was not even stamped as attempted`).toBeNull();
    }
  });

  it("CRITICAL the claim RESETS the failure counter when somebody else observed the exit since our last attempt. Without it the three failures the condemn threshold requires need not be consecutive in time or uncontradicted — two background misses months ago plus one blip today stamps `exit_superseded_at`, which account-me.ts and agent-sessions.ts then use to suppress the stored exit. MUTATION: delete the `freshness_consecutive_failures = CASE …` from the claim's SET list and this reds.", async () => {
    if (!client) return;
    const id = '00000000-0000-4000-8000-0000000000ea';
    // Two old failures, and then a LIVE SESSION relay observed the exit AFTER
    // that last attempt. The row is due again (the observation is past the
    // window), and the streak it carries has been contradicted.
    await insertProxy({
      id,
      failures: 2,
      attemptedAt: new Date(NOW.getTime() - SIX_HOURS_MS * 20),
      exitObserved: { ip: '203.0.113.9', country: 'NL', timezone: null, observed_via: 'session' },
      exitObservedAt: new Date(NOW.getTime() - SIX_HOURS_MS * 2),
    });

    const claimed = await claimOn(client);
    expect(claimed?.id, 'it is due').toBe(id);
    expect(
      claimed?.freshnessConsecutiveFailures,
      'and the streak restarted, because the exit was observed up since we last dialled',
    ).toBe(0);

    // CONTROL — an observation OLDER than our last attempt contradicts nothing.
    const kept = '00000000-0000-4000-8000-0000000000eb';
    await insertProxy({
      id: kept,
      failures: 2,
      attemptedAt: new Date(NOW.getTime() - SIX_HOURS_MS * 20),
      exitObserved: { ip: '203.0.113.9', country: 'NL', timezone: null, observed_via: 'session' },
      exitObservedAt: new Date(NOW.getTime() - SIX_HOURS_MS * 40),
    });
    expect((await claimOn(client))?.freshnessConsecutiveFailures, 'streak intact').toBe(2);
  });

  it('CRITICAL the CONDEMN stamp stands down for an exit observed after our dial began. The success path yields to a newer reading and the condemn path did not, so a customer pressing Test mid-sweep could have their own freshly-verified exit contradicted by our older, failed measurement. MUTATION: drop the `p.exit_observed_at <= probeStartedAt` disjunct from the condemn CASE and this reds.', async () => {
    if (!client) return;
    const id = '00000000-0000-4000-8000-0000000000ec';
    const probeStartedAt = new Date(NOW.getTime() - 30_000);
    await insertProxy({
      id,
      failures: 2,
      // Their Test landed five seconds after our dial began; ours failed at NOW.
      exitObserved: { ip: '198.51.100.200', country: 'DE', timezone: null, observed_via: 'probe' },
      exitObservedAt: new Date(probeStartedAt.getTime() + 5_000),
    });
    const repo = repoFor(client);

    const recorded = await repo.recordFreshnessFailure({
      id,
      accountId,
      at: NOW,
      condemnAfterFailures: 3,
      probeStartedAt,
    });
    expect(recorded?.consecutiveFailures, 'our failure really was recorded').toBe(3);
    expect(
      recorded?.exitSupersededAt,
      'but the reading the customer is watching is not condemned by evidence older than it',
    ).toBeNull();

    // CONTROL — the SAME row, with their observation moved to BEFORE our dial:
    // now nothing newer contradicts us and the threshold does stamp.
    await client`UPDATE account_proxies
                    SET exit_observed_at = ${new Date(probeStartedAt.getTime() - 5_000).toISOString()}::timestamptz,
                        freshness_consecutive_failures = 2
                  WHERE id = ${id}::uuid`;
    const control = await repo.recordFreshnessFailure({
      id,
      accountId,
      at: NOW,
      condemnAfterFailures: 3,
      probeStartedAt,
    });
    expect(control?.exitSupersededAt?.toISOString(), 'the guard is not simply off').toBe(
      NOW.toISOString(),
    );
  });

  it('CRITICAL recording a failure moves the counter and NOTHING else until the threshold. updated_at is on the customer-facing metadata view: a background probe that could not reach the proxy is not an edit of it, and one miss is not a verdict.', async () => {
    if (!client) return;
    const id = '00000000-0000-4000-8000-0000000000f1';
    await insertProxy({
      id,
      exitObserved: { ip: '203.0.113.5', country: 'NL', timezone: null, observed_via: 'session' },
    });
    const repo = repoFor(client);
    const before = await repo.findById({ id, accountId });
    const probeStartedAt = new Date(NOW.getTime() - 30_000);

    const first = await repo.recordFreshnessFailure({
      id,
      accountId,
      at: NOW,
      condemnAfterFailures: 3,
      probeStartedAt,
    });
    expect(first).toEqual({ consecutiveFailures: 1, exitSupersededAt: null });
    const afterOne = await repo.findById({ id, accountId });
    expect(afterOne?.updatedAt.toISOString(), 'updated_at untouched').toBe(
      before?.updatedAt.toISOString(),
    );
    expect(afterOne?.exitObserved, 'the stored exit untouched').toEqual(before?.exitObserved);

    await repo.recordFreshnessFailure({
      id,
      accountId,
      at: NOW,
      condemnAfterFailures: 3,
      probeStartedAt,
    });
    const third = await repo.recordFreshnessFailure({
      id,
      accountId,
      at: NOW,
      condemnAfterFailures: 3,
      probeStartedAt,
    });
    expect(third?.consecutiveFailures).toBe(3);
    expect(
      third?.exitSupersededAt?.toISOString(),
      'only the sustained run dates the contradiction',
    ).toBe(NOW.toISOString());
    expect(
      (await repo.findById({ id, accountId }))?.exitObserved,
      'and the exit is still KEPT — it is the last thing anyone observed',
    ).toEqual(before?.exitObserved);
  });

  it('a failure on a row with NO stored exit has nothing to contradict, so the stamp stays null however many times it fails', async () => {
    if (!client) return;
    const id = '00000000-0000-4000-8000-0000000000f2';
    await insertProxy({ id });
    const repo = repoFor(client);
    for (let i = 0; i < 4; i += 1) {
      await repo.recordFreshnessFailure({
        id,
        accountId,
        at: NOW,
        condemnAfterFailures: 3,
        probeStartedAt: new Date(NOW.getTime() - 30_000),
      });
    }
    const row = await repo.findById({ id, accountId });
    expect(row?.freshnessConsecutiveFailures).toBe(4);
    expect(row?.exitSupersededAt).toBeNull();
  });

  it('a failure recorded against the wrong account matches no row — the sweep reached this proxy through a cross-account claim, and every WRITE is still owner-scoped', async () => {
    if (!client) return;
    const id = '00000000-0000-4000-8000-0000000000f3';
    await insertProxy({ id });
    const result = await repoFor(client).recordFreshnessFailure({
      id,
      accountId: randomUUID(),
      at: NOW,
      condemnAfterFailures: 3,
      probeStartedAt: new Date(NOW.getTime() - 30_000),
    });
    expect(result).toBeNull();
    expect((await repoFor(client).findById({ id, accountId }))?.freshnessConsecutiveFailures).toBe(
      0,
    );
  });
});
