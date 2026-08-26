// Real-Postgres proof that a web-session revoke is an atomic claim across
// pooled API connections. This is the cross-process backstop for refresh-token
// rotation: only the transaction that flips revoked_at NULL→timestamp may mint.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAuthFlowsRepo } from '../../src/db/auth-flows-repo.js';
import { DrizzleAccountAuthRepo } from '../../src/db/auth-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
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
  client = postgres(DB_URL, { max: 5 });
  try {
    await client`SELECT 1 FROM web_sessions LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (!client) return;
  for (const accountId of seeded) {
    await client`DELETE FROM web_sessions WHERE account_id = ${accountId}`.catch(() => {});
    await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
  }
  await client.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'web-session revoke first-winner claim (Drizzle path, real Postgres)',
  () => {
    it('CRITICAL the database is reachable, so nothing below can pass vacuously', () => {
      // Every arm in this file returns early when `client` is null. That is right
      // when the suite runs without a database: the describe is skipped and
      // nothing claims to have tested anything. But when the describe DOES run and
      // Postgres is down or unmigrated, every arm returns early and the file
      // reports as PASSED. A green meaning "the database was missing" is
      // indistinguishable from one meaning "the database agreed", and that is the
      // worse of the two failure modes.
      expect(
        client,
        'postgres unreachable or unmigrated — the arms below never ran',
      ).not.toBeNull();
    });

    it('returns true to exactly one concurrent revoker', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAuthFlowsRepo({ client, db, close: async () => {} });
      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`refresh-claim-${accountId}@test.local`})`;
      const session = await repo.insertWebSession({
        accountId,
        tokenHash: `hash-${randomUUID()}`,
        authEpoch: 0,
        expiresAt: new Date(Date.now() + 60_000),
        issuedFromIp: null,
        userAgent: null,
      });
      expect(session).not.toBeNull();
      if (!session) throw new Error('expected live session insert');

      const results = await Promise.all([
        repo.revokeWebSession(session.id, new Date()),
        repo.revokeWebSession(session.id, new Date()),
      ]);
      expect(results.sort()).toEqual([false, true]);
    });

    it('CRITICAL a web session is only readable by the account that owns it', async () => {
      // `findWebSessionByIdForAccount` takes an id AND an accountId, and the
      // second parameter is the entire cross-account boundary on this read. It
      // had NO coverage of any kind: replacing `eq(accountId)` with a predicate
      // that always matches left all 22,440 tests green, so one account could
      // have read another's web-session row by id.
      if (!dbReachable || !client) return;
      const c = client;
      const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAuthFlowsRepo({ client: c, db, close: async () => {} });

      const owner = randomUUID();
      const stranger = randomUUID();
      seeded.push(owner, stranger);
      for (const id of [owner, stranger]) {
        await c`INSERT INTO accounts (id, email) VALUES (${id}, ${`scoped-${id}@test.local`})`;
      }
      const session = await repo.insertWebSession({
        accountId: owner,
        tokenHash: `hash-${randomUUID()}`,
        authEpoch: 0,
        expiresAt: new Date(Date.now() + 60_000),
        issuedFromIp: null,
        userAgent: null,
      });
      if (!session) throw new Error('expected live session insert');

      expect(
        (await repo.findWebSessionByIdForAccount(session.id, owner))?.id,
        'the owner reads their own session',
      ).toBe(session.id);
      expect(
        await repo.findWebSessionByIdForAccount(session.id, stranger),
        'another account gets nothing, even holding the exact session id',
      ).toBeNull();
    });

    it('CRITICAL an EXPIRED web session does not authenticate. `findActiveWebSession` is the lookup behind session auth, and its own interface doc promises it "returns null if not found, EXPIRED, or revoked" — the caller does not re-check, so this predicate is the entire expiry enforcement. Neutralising it left all 3,276 integration tests green.', async () => {
      if (!dbReachable || !client) return;
      const c = client;
      const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAuthFlowsRepo({ client: c, db, close: async () => {} });

      const accountId = randomUUID();
      seeded.push(accountId);
      await c`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`expiry-${accountId}@test.local`})`;

      const liveHash = `hash-${randomUUID()}`;
      const deadHash = `hash-${randomUUID()}`;
      await repo.insertWebSession({
        accountId,
        tokenHash: liveHash,
        authEpoch: 0,
        expiresAt: new Date(Date.now() + 60_000),
        issuedFromIp: null,
        userAgent: null,
      });
      await repo.insertWebSession({
        accountId,
        tokenHash: deadHash,
        authEpoch: 0,
        expiresAt: new Date(Date.now() - 60_000),
        issuedFromIp: null,
        userAgent: null,
      });

      // Positive control: without it, an always-null lookup would pass the real check below.
      expect(
        (await repo.findActiveWebSession({ tokenHash: liveHash, now: new Date() }))?.accountId,
        'a LIVE session did not authenticate — the check below would prove nothing',
      ).toBe(accountId);

      expect(
        await repo.findActiveWebSession({ tokenHash: deadHash, now: new Date() }),
        'an expired web session still authenticated',
      ).toBeNull();
    });

    // V-1831 — the arm above proves `DrizzleAuthFlowsRepo.findActiveWebSession`.
    // There is a SECOND implementation with its own predicates:
    // `DrizzleAccountAuthRepo.findActiveWebSession`, which `bootstrap.ts:463`
    // constructs and `services/auth.ts slowPathWebSession` calls on the
    // web-session branch of request auth.
    //
    // MEASURED (V-1830): removing BOTH of its conjuncts — `gt(expiresAt, now)`
    // AND `isNull(revokedAt)` — left the FULL suite green except two source-TEXT
    // pins. Neither property was executed on that lookup.
    //
    // It is the ONLY enforcement, not a backstop: the caller states directly
    // beneath the call that the query "already filters expired + revoked rows"
    // and that a null result cannot be distinguished, so the service delegates
    // rather than re-checking.
    it('CRITICAL the RUNTIME auth repo also refuses expired and revoked sessions — a second implementation with its own predicates', async () => {
      if (!dbReachable || !client) return;
      const c = client;
      const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAuthFlowsRepo({ client: c, db, close: async () => {} });
      const runtimeAuthRepo = new DrizzleAccountAuthRepo({ client: c, db, close: async () => {} });

      const accountId = randomUUID();
      seeded.push(accountId);
      await c`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`runtime-ws-${accountId}@test.local`})`;

      const liveHash = `rt-live-${randomUUID()}`;
      const deadHash = `rt-dead-${randomUUID()}`;
      const revokedHash = `rt-revoked-${randomUUID()}`;
      for (const [tokenHash, expiresAt] of [
        [liveHash, new Date(Date.now() + 60_000)],
        [deadHash, new Date(Date.now() - 60_000)],
        [revokedHash, new Date(Date.now() + 60_000)],
      ] as const) {
        await repo.insertWebSession({
          accountId,
          tokenHash,
          authEpoch: 0,
          expiresAt,
          issuedFromIp: null,
          userAgent: null,
        });
      }
      const toRevoke = await runtimeAuthRepo.findActiveWebSession({
        tokenHash: revokedHash,
        now: new Date(),
      });
      expect(toRevoke, 'the session to revoke must exist first').not.toBeNull();
      await repo.revokeWebSession(toRevoke!.id, new Date());

      // Positive control: without it, an always-null lookup would pass both checks below.
      expect(
        (await runtimeAuthRepo.findActiveWebSession({ tokenHash: liveHash, now: new Date() }))
          ?.accountId,
        'a LIVE session did not authenticate through the runtime repo — the checks below would prove nothing',
      ).toBe(accountId);

      expect(
        await runtimeAuthRepo.findActiveWebSession({ tokenHash: deadHash, now: new Date() }),
        'an expired web session still authenticated through the RUNTIME repo',
      ).toBeNull();

      expect(
        await runtimeAuthRepo.findActiveWebSession({ tokenHash: revokedHash, now: new Date() }),
        'a REVOKED web session still authenticated through the RUNTIME repo',
      ).toBeNull();
    });

    it('CRITICAL bulk revoke stops at the account boundary, spares the current session, and is idempotent', async () => {
      // `revokeAllWebSessionsExcept` is what "log out my other devices" runs. Its
      // three predicates are the whole security of that action:
      //   eq(accountId)      — the cross-account boundary
      //   ne(id, exceptId)   — the caller keeps their own session
      //   isNull(revokedAt)  — only live rows, so the count is honest
      //
      // Every reference to it in the test corpus is a REGEX OVER SOURCE TEXT: the
      // repo parity pin, the v079 invariant, the route pin and the service pin.
      // Measured by mutation at full unit scope — dropping the account scoping,
      // dropping the carve-out, and dropping the live-only filter each redded ONLY
      // those pins plus the typecheck guards (the dropped parameter goes unused).
      // Not one behavioural test anywhere drove this against two accounts, so a
      // rewrite that updated the text while dropping `eq(accountId)` would have
      // logged out every account on the platform behind a green suite.
      if (!dbReachable || !client) return;
      const c = client;
      const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAuthFlowsRepo({ client: c, db, close: async () => {} });

      const mkAccount = async (): Promise<string> => {
        const id = randomUUID();
        seeded.push(id);
        await c`INSERT INTO accounts (id, email) VALUES (${id}, ${`bulk-${id}@test.local`})`;
        return id;
      };
      const mkSession = async (accountId: string): Promise<string> => {
        const row = await repo.insertWebSession({
          accountId,
          tokenHash: `hash-${randomUUID()}`,
          authEpoch: 0,
          expiresAt: new Date(Date.now() + 60_000),
          issuedFromIp: null,
          userAgent: null,
        });
        if (!row) throw new Error('expected live session insert');
        return row.id;
      };
      const liveIds = async (accountId: string): Promise<string[]> => {
        const rows = await c<Array<{ id: string }>>`
          SELECT id FROM web_sessions
           WHERE account_id = ${accountId} AND revoked_at IS NULL ORDER BY id`;
        return rows.map((r) => r.id);
      };

      const victim = await mkAccount();
      const bystander = await mkAccount();
      const keep = await mkSession(victim);
      const dropA = await mkSession(victim);
      const dropB = await mkSession(victim);
      const otherA = await mkSession(bystander);
      const otherB = await mkSession(bystander);

      const revoked = await repo.revokeAllWebSessionsExcept(victim, keep, new Date());
      expect(revoked, 'exactly the two other sessions on THIS account').toBe(2);

      expect(await liveIds(victim), 'the caller keeps the session they are using').toEqual([keep]);
      expect(
        (await liveIds(bystander)).sort(),
        'another account loses nothing — this is the predicate a text pin cannot hold',
      ).toEqual([otherA, otherB].sort());

      // Idempotent: the live-only filter means a second sweep claims nothing, so a
      // retried request cannot report work it did not do.
      expect(await repo.revokeAllWebSessionsExcept(victim, keep, new Date())).toBe(0);
      expect([dropA, dropB].every((id) => id !== keep)).toBe(true);
    });

    it('waits for a password epoch bump and refuses the stale successor', async () => {
      if (!dbReachable || !client) return;
      const pg = client;
      const db = drizzle(pg) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAuthFlowsRepo({ client: pg, db, close: async () => {} });
      const accountId = randomUUID();
      seeded.push(accountId);
      await pg`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`refresh-epoch-${accountId}@test.local`})`;

      let passwordUpdated!: () => void;
      let releaseReset!: () => void;
      const updateVisible = new Promise<void>((resolve) => {
        passwordUpdated = resolve;
      });
      const holdReset = new Promise<void>((resolve) => {
        releaseReset = resolve;
      });
      const reset = pg.begin(async (tx) => {
        await tx`
          UPDATE accounts
          SET password_hash = 'reset-won', auth_epoch = auth_epoch + 1
          WHERE id = ${accountId}
        `;
        passwordUpdated();
        await holdReset;
      });
      await updateVisible;

      let insertSettled = false;
      const insert = repo
        .insertWebSession({
          accountId,
          tokenHash: `stale-hash-${randomUUID()}`,
          authEpoch: 0,
          expiresAt: new Date(Date.now() + 60_000),
          issuedFromIp: null,
          userAgent: 'stolen-browser',
        })
        .then((row) => {
          insertSettled = true;
          return row;
        });

      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(insertSettled).toBe(false);
      } finally {
        releaseReset();
      }
      await reset;
      await expect(insert).resolves.toBeNull();

      const rows = await pg`SELECT id FROM web_sessions WHERE account_id = ${accountId}`;
      expect(rows).toHaveLength(0);
    });

    it('makes an already-minted prior-epoch session inactive immediately after password change', async () => {
      if (!dbReachable || !client) return;
      const pg = client;
      const db = drizzle(pg) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAuthFlowsRepo({ client: pg, db, close: async () => {} });
      const runtimeAuthRepo = new DrizzleAccountAuthRepo({ client: pg, db, close: async () => {} });
      const accountId = randomUUID();
      seeded.push(accountId);
      await pg`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`refresh-epoch-read-${accountId}@test.local`})`;
      const tokenHash = `epoch-read-${randomUUID()}`;
      const session = await repo.insertWebSession({
        accountId,
        tokenHash,
        authEpoch: 0,
        expiresAt: new Date(Date.now() + 60_000),
        issuedFromIp: null,
        userAgent: null,
      });
      expect(session).not.toBeNull();
      expect(await repo.findActiveWebSession({ tokenHash, now: new Date() })).not.toBeNull();
      expect(
        await runtimeAuthRepo.findActiveWebSession({ tokenHash, now: new Date() }),
      ).not.toBeNull();

      const updated = await repo.setPassword(accountId, 'new-password-hash');
      expect(updated?.authEpoch).toBe(1);
      expect(await repo.findActiveWebSession({ tokenHash, now: new Date() })).toBeNull();
      expect(await runtimeAuthRepo.findActiveWebSession({ tokenHash, now: new Date() })).toBeNull();
    });
  },
);
