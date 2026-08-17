// The cap that decides whether a customer may start another agent session.
//
// `createIfUnderActiveCap` is well covered for its OTHER job. The
// single-active-session-per-profile guard in the same transaction has a whole
// file (`db-profile-in-use-concurrency-drizzle`) covering the cross-surface
// race, terminal sessions, cross-account isolation and the no-profile path. But
// every one of those arms passes `HIGH_CAP` — so the cap comparison itself, the
// reason the method is named what it is, has never been exercised. v8 confirms
// it: the branch at the `>= cap` line is unexecuted, and `agent-sessions-repo`
// sits at 62.8% branches.
//
// An agent session holds a real browser on a real fleet node, so this cap is
// both a tier entitlement and a resource guard. Each part of the count fails
// into a distinct, customer-visible outcome:
//
//   accountId filter   without it the count is every active session on the
//                      PLATFORM. Once total concurrency reaches any customer's
//                      cap, nobody can start a session — a full outage that
//                      presents as every customer being individually "at their
//                      limit".
//   status = 'active'  without it, closed sessions keep occupying slots
//                      forever. A customer is permanently locked out after
//                      their Nth session ever, and no amount of closing frees
//                      anything — the one failure a customer cannot work around.
//   >= rather than >   the boundary. Off by one hands out one session more than
//                      the tier sells, on every account, forever.
//
// The refusal is a `null` return rather than a throw, and that is asserted
// explicitly: the caller distinguishes "at cap" from a failure, and a method
// that threw here would surface as a 500 instead of a quota message.
//
// Against a real Postgres: the count and the insert share one transaction under
// a per-account advisory lock, which is what stops concurrent creates all
// passing a stale count. The concurrency arm below is meaningless without it.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAgentSessionsRepo } from '../../src/db/agent-sessions-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const TRANSCRIPT_KEY = Buffer.alloc(32, 11).toString('base64');

let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleAgentSessionsRepo | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  // max > 1 so the concurrent-create arm races real backends rather than
  // queueing on one pooled connection.
  client = postgres(DB_URL, { max: 4 });
  try {
    await client`SELECT status FROM agent_sessions LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  repo = new DrizzleAgentSessionsRepo(
    { client, db: drizzle(client), close: async () => {} } as unknown as never,
    { transcriptEncryptionKeyBase64: TRANSCRIPT_KEY },
  );
});

afterAll(async () => {
  if (client && seeded.length > 0) {
    await client`DELETE FROM accounts WHERE id = ANY(${client.array(seeded)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await client?.end({ timeout: 2 }).catch(() => undefined);
});

async function seedAccount(): Promise<string> {
  const id = randomUUID();
  await client!`
    INSERT INTO accounts (id, email, status)
    VALUES (${id}, ${`agentcap-${id}@test.local`}, 'active')`;
  seeded.push(id);
  return id;
}

const create = (accountId: string, cap: number) =>
  repo!.createIfUnderActiveCap({ accountId, tokenBudgetTotal: 1000 }, cap);

describe('agent session active cap', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL a create under the cap succeeds', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    expect(
      await create(accountId, 2),
      'a customer under their concurrency limit was refused a session',
    ).not.toBeNull();
  });

  it('CRITICAL the create AT the cap is refused, and refused with null', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    expect(await create(accountId, 2)).not.toBeNull();
    expect(await create(accountId, 2)).not.toBeNull();
    // Third against a cap of two. Null rather than a throw: the caller turns
    // this into a quota message, and an exception here becomes a 500.
    expect(
      await create(accountId, 2),
      'the concurrency cap did not refuse — a customer can hold more live browser sessions than ' +
        'their tier sells, on every account',
    ).toBeNull();
  });

  it('CRITICAL a cap of zero refuses the very first session', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    expect(
      await create(accountId, 0),
      'a zero cap still allowed a session — the >= comparison is what makes zero mean zero',
    ).toBeNull();
  });

  it('CRITICAL closing a session frees its slot', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const first = await create(accountId, 1);
    expect(await create(accountId, 1), 'precondition: the account is at its cap').toBeNull();
    await repo.closeWithReason(first!.id, 'test-teardown');
    expect(
      await create(accountId, 1),
      'a CLOSED session still occupied a slot. The count would include every session the account ' +
        'ever created, so the customer is permanently locked out after their Nth and no amount of ' +
        'closing frees anything',
    ).not.toBeNull();
  });

  it('CRITICAL another account’s sessions never consume this account’s cap', async () => {
    if (!dbReachable || !repo) return;
    const mine = await seedAccount();
    const theirs = await seedAccount();
    expect(await create(theirs, 1)).not.toBeNull();
    expect(
      await create(mine, 1),
      'another account’s active session consumed this account’s allowance — once total platform ' +
        'concurrency reached any one cap, nobody could start a session',
    ).not.toBeNull();
  });

  it('CRITICAL concurrent creates cannot overshoot the cap', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    // Four at once against a cap of two. Without the advisory lock all four
    // read the same stale count of zero and all four insert.
    const results = await Promise.all([
      create(accountId, 2),
      create(accountId, 2),
      create(accountId, 2),
      create(accountId, 2),
    ]);
    expect(
      results.filter((r) => r !== null).length,
      'concurrent creates overshot the cap — the count and insert must share one transaction under ' +
        'the per-account advisory lock, or every racer passes a stale count',
    ).toBe(2);
  });
});
