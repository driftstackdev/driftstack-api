// Paging a customer's agent sessions without losing rows or borrowing someone
// else's position.
//
// `db-repo-account-ownership-boundary` already proves the paged read enforces the
// tenant boundary — but it calls `listPageByAccount` with no cursor, so the whole
// cursor half of the method is unexecuted. v8 shows the branches at the regex
// guard, the anchor lookup, the keyset predicate and the hasMore/nextCursor
// arithmetic all cold.
//
// Three properties live in there, and the third is the one the no-cursor arm
// cannot reach:
//
//   composite keyset   the predicate is `createdAt < T OR (createdAt = T AND
//                      id < lastId)`. Agent sessions are created in bursts, so
//                      ties on createdAt are ordinary; a createdAt-only cursor
//                      drops every row sharing the boundary instant. The symptom
//                      is a session missing from the customer's list while every
//                      page looks well-formed — the same shape as the #125 DLQ
//                      bug.
//   malformed cursor   a cursor that does not match falls through to a first
//                      page. Stated precisely, because mutation corrected the
//                      first draft: the `AGENT_SESSION_ID_RE` guard is an
//                      OPTIMISATION here, not the thing that makes this safe.
//                      This PK is `agt_<uuid>` TEXT, so an unmatched cursor
//                      resolves to no anchor whether or not the regex runs —
//                      deleting the guard reds nothing. (The sibling repos whose
//                      PK is a uuid COLUMN are the ones where an unmatched
//                      cursor would raise; that is what `parseUuidCursor` is
//                      for.) The arm pins the OUTCOME a hand-crafted cursor
//                      must produce, not the guard.
//   cursor ownership   the anchor lookup is itself account-scoped. Without that,
//                      passing ANOTHER account's session id as a cursor would
//                      resolve a real anchor and page the caller's own list from
//                      a stranger's position — a small but genuine leak of when
//                      that stranger's session was created, and a listing that
//                      silently starts in the wrong place.
//
// Against a real Postgres: the anchor lookup and the keyset comparison are two
// statements whose agreement is the whole feature, and ordering of a text PK
// alongside a timestamptz is the database's decision.

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
  client = postgres(DB_URL, { max: 2 });
  try {
    await client`SELECT created_at FROM agent_sessions LIMIT 0`;
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
    VALUES (${id}, ${`agtpage-${id}@test.local`}, 'active')`;
  seeded.push(id);
  return id;
}

/**
 * Created through the real path, then stamped to a chosen instant so ordering
 * and boundary ties are controllable.
 */
async function seedSession(accountId: string, createdAt: Date): Promise<string> {
  const row = await repo!.createIfUnderActiveCap({ accountId, tokenBudgetTotal: 1000 }, 1000);
  expect(row, 'fixture precondition: the session was not created').not.toBeNull();
  await client!`
    UPDATE agent_sessions SET created_at = ${createdAt.toISOString()}::timestamptz
     WHERE id = ${row!.id}`;
  return row!.id;
}

/** Walks every page the way a paginating client would. */
async function pageThrough(accountId: string, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 25; guard++) {
    const page = await repo!.listPageByAccount(accountId, {
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    seen.push(...page.items.map((i) => i.id));
    if (page.nextCursor === null) return seen;
    cursor = page.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

describe('agent session page cursor', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL paging a burst that shares one instant loses nothing', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const sameInstant = new Date(Date.now() - 60 * 60 * 1000);
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add(await seedSession(accountId, sameInstant));

    const seen = await pageThrough(accountId, 2);
    expect(
      new Set(seen).size,
      'a session came back on more than one page — a client accumulating pages would show duplicates',
    ).toBe(seen.length);
    expect(
      new Set(seen),
      'paging dropped sessions that shared the boundary instant. Every page looks well-formed and ' +
        'the walk ends cleanly; the only symptom is a session missing from the customer’s list',
    ).toEqual(ids);
  });

  it('CRITICAL the last page reports no next cursor', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    await seedSession(accountId, new Date(Date.now() - 60_000));
    const page = await repo.listPageByAccount(accountId, { limit: 50 });
    expect(page.items).toHaveLength(1);
    expect(
      page.nextCursor,
      'a complete page still advertised more, so a client would loop asking for a page that never comes',
    ).toBeNull();
  });

  it('CRITICAL a full page advertises the next cursor', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const base = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < 3; i++) await seedSession(accountId, new Date(base + i * 1000));
    const page = await repo.listPageByAccount(accountId, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor, 'more rows existed but the page claimed to be the last').not.toBeNull();
  });

  it('CRITICAL newest sessions come first', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const base = Date.now() - 60 * 60 * 1000;
    const oldest = await seedSession(accountId, new Date(base));
    const middle = await seedSession(accountId, new Date(base + 60_000));
    const newest = await seedSession(accountId, new Date(base + 120_000));
    const page = await repo.listPageByAccount(accountId, { limit: 50 });
    expect(
      page.items.map((i) => i.id),
      'the list is not newest-first, so the session a customer just started is not at the top',
    ).toEqual([newest, middle, oldest]);
  });

  it('CRITICAL a malformed cursor yields a first page rather than an error', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const id = await seedSession(accountId, new Date(Date.now() - 60_000));
    for (const cursor of ['not-a-cursor', 'agt_nope', '../../etc/passwd', '']) {
      const page = await repo.listPageByAccount(accountId, { limit: 50, cursor });
      expect(
        page.items.map((i) => i.id),
        `a hand-crafted cursor (${JSON.stringify(cursor)}) did not fall through to the first page`,
      ).toEqual([id]);
    }
  });

  it('CRITICAL another account’s session id cannot be used as a cursor', async () => {
    if (!dbReachable || !repo) return;
    const mine = await seedAccount();
    const theirs = await seedAccount();
    const base = Date.now() - 60 * 60 * 1000;
    // Their session is OLDER than mine, deliberately. If their id resolved as an
    // anchor, the keyset would filter my list to rows older than THEIR session —
    // which excludes my only row, so the page comes back empty. With the anchor
    // lookup account-scoped, their id resolves to nothing and I get a first page.
    // (Ordered the other way round this arm passes either way, which is how the
    // first draft of it slipped through: the mutation did not red.)
    await seedSession(theirs, new Date(base));
    const myOnly = await seedSession(mine, new Date(base + 120_000));
    const theirId = (await repo.listPageByAccount(theirs, { limit: 1 })).items[0]?.id;
    expect(theirId, 'fixture precondition: the other account has a session').toBeDefined();

    const page = await repo.listPageByAccount(mine, { limit: 50, cursor: theirId! });
    expect(
      page.items.map((i) => i.id),
      'another account’s session id resolved as a page anchor. The anchor lookup must be ' +
        'account-scoped, or a caller pages their own list from a stranger’s position and learns ' +
        'when that stranger’s session was created',
    ).toEqual([myOnly]);
  });
});
