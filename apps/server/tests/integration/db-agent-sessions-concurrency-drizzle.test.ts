// Drizzle-backed integration test: DrizzleAgentSessionsRepo.debitTokens and
// .appendTranscript are ATOMIC under concurrency, against a REAL Postgres.
//
// Both methods do a read-modify-write. Before the fix they were a bare get()
// SELECT then a SEPARATE UPDATE, so two concurrent same-session calls both
// read the same value and the later UPDATE clobbered the earlier → a lost
// debit (under-billing / uncapped bundled-LLM spend) or a dropped transcript
// entry (data loss). The fix wraps each in a `db.transaction()` that SELECTs
// the row `FOR UPDATE` first: the second transaction blocks on the SELECT
// until the first commits, then operates on the up-to-date value.
//
// The in-memory twin is synchronous (no await gap → no race), so it can't
// exercise this — a real Postgres with a MULTI-connection pool is the only
// place the row lock is actually proven. With `max: 5` the two concurrent
// transactions get distinct connections, so the FOR-UPDATE lock (not
// connection serialisation) is what's under test. With the fix the results
// are deterministic; the pre-fix read-modify-write would yield 60/70 (lost
// debit) and length 1 (dropped entry).
//
// Run scope:
//   - CI: build-test job has postgres:17-alpine at localhost:5432 with the
//     `driftstack` schema migrated; this test always runs there.
//   - Local dev: skips if DATABASE_URL postgres is unreachable.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAgentSessionsRepo } from '../../src/db/agent-sessions-repo.js';
import type * as schema from '../../src/db/schema.js';
import type { TranscriptEntry } from '../../src/services/agent-decomposer.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const TRANSCRIPT_KEY = Buffer.alloc(32, 11).toString('base64');

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
// accountIds seeded — cleaned in FK order: agent_sessions → accounts.
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  // max: 5 so concurrent transactions get distinct connections — the
  // FOR-UPDATE row lock, not connection serialisation, is what's exercised.
  client = postgres(DB_URL, { max: 5 });
  try {
    await client`SELECT 1 FROM agent_sessions LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM agent_sessions WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'agent_sessions debitTokens/appendTranscript atomicity under concurrency (Drizzle path, real Postgres)',
  () => {
    it('concurrent debitTokens never lose an update (FOR UPDATE row lock serialises → 100-30-40=30)', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAgentSessionsRepo(
        { client, db, close: async () => {} },
        { transcriptEncryptionKeyBase64: TRANSCRIPT_KEY },
      );

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`agt-debit-${accountId}@test.local`})`;
      const session = await repo.create({ accountId, tokenBudgetTotal: 100 });

      // A bare read-modify-write would let both read 100 → clobber → 60 or 70
      // (one debit LOST). The FOR-UPDATE lock serialises → 30, deterministically.
      await Promise.all([repo.debitTokens(session.id, 30), repo.debitTokens(session.id, 40)]);

      const after = await repo.get(session.id);
      expect(after?.tokenBudgetRemaining).toBe(30);
    });

    it('concurrent appendTranscript never drop an entry (FOR UPDATE row lock serialises → length 2)', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAgentSessionsRepo(
        { client, db, close: async () => {} },
        { transcriptEncryptionKeyBase64: TRANSCRIPT_KEY },
      );

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`agt-append-${accountId}@test.local`})`;
      const session = await repo.create({ accountId, tokenBudgetTotal: 1000 });

      const a: TranscriptEntry = { at: 't0', role: 'user', body: 'msg-A' };
      const b: TranscriptEntry = { at: 't1', role: 'agent', body: 'msg-B' };
      // A bare read-modify-write would lose one → length 1. The FOR-UPDATE lock
      // serialises → both land → length 2.
      await Promise.all([
        repo.appendTranscript(session.id, a),
        repo.appendTranscript(session.id, b),
      ]);

      const after = await repo.get(session.id);
      expect(after?.transcript.length).toBe(2);
      const bodies = (after?.transcript ?? []).map((e) => e.body).sort();
      expect(bodies).toEqual(['msg-A', 'msg-B']);

      const [stored] =
        await client`SELECT transcript::text AS transcript FROM agent_sessions WHERE id = ${session.id}`;
      expect(stored?.transcript).not.toContain('msg-A');
      expect(stored?.transcript).not.toContain('msg-B');
      expect(stored?.transcript).toContain('driftstack.agent-session-transcript');
    });

    it('legacy plaintext arrays fail ordinary reads, then migrate before append', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAgentSessionsRepo(
        { client, db, close: async () => {} },
        { transcriptEncryptionKeyBase64: TRANSCRIPT_KEY },
      );

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`agt-legacy-${accountId}@test.local`})`;
      const session = await repo.create({ accountId, tokenBudgetTotal: 1000 });
      const legacy = [{ at: 't0', role: 'user', body: 'legacy-secret' }];
      await client`UPDATE agent_sessions SET transcript = ${JSON.stringify(legacy)}::jsonb WHERE id = ${session.id}`;

      await expect(repo.get(session.id)).rejects.toThrow(/not a v2/i);
      await expect(
        repo.appendTranscript(session.id, { at: 'blocked', role: 'agent', body: 'x' }),
      ).rejects.toThrow(/not a v2/i);

      const migrated = await repo.migrateTranscriptEnvelopes(500);
      expect(migrated).toMatchObject({ converted: 1, remaining: 0 });
      const before = await repo.get(session.id);
      expect(before?.transcript).toEqual(legacy);
      await repo.appendTranscript(session.id, { at: 't1', role: 'agent', body: 'new-secret' });
      const after = await repo.get(session.id);
      expect(after?.transcript.map((entry) => entry.body)).toEqual(['legacy-secret', 'new-secret']);
      const [stored] =
        await client`SELECT transcript::text AS transcript FROM agent_sessions WHERE id = ${session.id}`;
      expect(stored?.transcript).not.toContain('legacy-secret');
      expect(stored?.transcript).not.toContain('new-secret');
      expect(stored?.transcript).toContain('driftstack.agent-session-transcript');
    });

    it('pair-mode compare-and-set preserves the first state/mode winner (real Postgres)', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAgentSessionsRepo(
        { client, db, close: async () => {} },
        { transcriptEncryptionKeyBase64: TRANSCRIPT_KEY },
      );

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`agt-pair-cas-${accountId}@test.local`})`;
      const session = await repo.create({
        accountId,
        tokenBudgetTotal: 1000,
        mode: 'pair',
      });
      expect(session.pairModeState).toBeNull();

      const pending = {
        kind: 'takeover-pending',
        requestedByClientId: 'cli_a',
        requestedAt: '2026-07-13T12:00:00.000Z',
      };
      const first = await repo.compareAndSetPairModeState(session.id, null, pending);
      expect(first?.pairModeState).toEqual(pending);

      // A delayed sibling carrying the original SQL-NULL snapshot cannot
      // replace the first writer after its distributed lock has been released.
      await expect(
        repo.compareAndSetPairModeState(session.id, null, {
          ...pending,
          requestedByClientId: 'cli_b',
        }),
      ).resolves.toBeNull();

      // JSONB comparison is structural rather than dependent on JS object key
      // insertion order.
      const reorderedExpected = {
        requestedAt: pending.requestedAt,
        kind: pending.kind,
        requestedByClientId: pending.requestedByClientId,
      };
      const human = {
        kind: 'human-driving',
        clientId: 'cli_a',
        sinceAt: '2026-07-13T12:00:01.000Z',
      };
      const second = await repo.compareAndSetPairModeState(session.id, reorderedExpected, human);
      expect(second?.pairModeState).toEqual(human);

      await repo.setMode(session.id, 'manual', null);
      await expect(
        repo.compareAndSetPairModeState(session.id, human, { kind: 'ai-driving' }),
      ).resolves.toBeNull();
      expect(await repo.get(session.id)).toMatchObject({ mode: 'manual', pairModeState: null });
    });

    // Audit fix 2026-07-01 — closeWithReason TOCTOU race. Before the fix it was
    // a bare read-then-write (a get() for closedAt-preservation, then an
    // UNCONDITIONAL `UPDATE … WHERE id=$id`): two concurrent closeWithReason
    // calls for the SAME session (e.g. the worker-terminal-close service racing
    // this node's own bootId sweep, or a customer DELETE racing a
    // budget-exhausted close) would BOTH succeed, and whichever UPDATE
    // committed LAST always won — silently overwriting the earlier closer's
    // true closed_reason. The fix makes the UPDATE atomic + conditional
    // (`WHERE id=$id AND status!='closed'`), so only the FIRST of two
    // concurrent closers actually writes; the second's WHERE no longer
    // matches and it safely no-ops (returns the winner's row unchanged).
    it('concurrent closeWithReason calls never both win: exactly one reason is persisted, never overwritten by the loser (real Postgres, distinct connections)', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAgentSessionsRepo(
        { client, db, close: async () => {} },
        { transcriptEncryptionKeyBase64: TRANSCRIPT_KEY },
      );

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`agt-close-race-${accountId}@test.local`})`;
      const session = await repo.create({ accountId, tokenBudgetTotal: 1000 });

      // A pre-fix bare read-then-write would let BOTH calls read status='active'
      // and BOTH unconditionally UPDATE — the later commit clobbers the
      // earlier's closed_reason (a non-deterministic 'reason-A' or 'reason-B'
      // depending purely on commit order, with NO guarantee the row reflects
      // the call that "really" tore the session down first). The atomic
      // `WHERE status!='closed'` fix guarantees exactly ONE of the two writes
      // actually lands; the other's WHERE no longer matches once the first
      // commits, so it reads back and returns the winner's row untouched
      // rather than re-writing over it.
      const [a, b] = await Promise.all([
        repo.closeWithReason(session.id, 'reason-A'),
        repo.closeWithReason(session.id, 'reason-B'),
      ]);

      const after = await repo.get(session.id);
      expect(after?.status).toBe('closed');
      // Exactly one of the two reasons persisted — never both applied, never
      // some third/corrupted value.
      expect(['reason-A', 'reason-B']).toContain(after?.closedReason);
      // Both calls' return values agree with the row's ACTUAL persisted
      // reason (the loser's closeWithReason reads back the winner's row
      // rather than reporting its own attempted reason as if it won).
      expect(a.closedReason).toBe(after?.closedReason);
      expect(b.closedReason).toBe(after?.closedReason);
      // closedAt is set exactly once (the winner's close), not re-stamped by
      // the loser.
      expect(a.closedAt?.getTime()).toBe(after?.closedAt?.getTime());
      expect(b.closedAt?.getTime()).toBe(after?.closedAt?.getTime());
    });

    it('five concurrent close outcomes elect exactly one teardown owner (real Postgres, distinct connections)', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAgentSessionsRepo(
        { client, db, close: async () => {} },
        { transcriptEncryptionKeyBase64: TRANSCRIPT_KEY },
      );

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`agt-close-outcome-${accountId}@test.local`})`;
      const session = await repo.create({ accountId, tokenBudgetTotal: 1000 });

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          repo.closeWithReasonOutcome(session.id, `contender-${index}`),
        ),
      );
      const winner = outcomes.find((outcome) => outcome.kind === 'closed');

      expect(outcomes.filter((outcome) => outcome.kind === 'closed')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.kind === 'already_closed')).toHaveLength(4);
      expect(winner).toBeDefined();
      expect(
        outcomes.every((outcome) => outcome.session.closedReason === winner!.session.closedReason),
      ).toBe(true);
      expect(
        outcomes.every(
          (outcome) => outcome.session.closedAt?.getTime() === winner!.session.closedAt?.getTime(),
        ),
      ).toBe(true);
      expect(await repo.get(session.id)).toEqual(winner!.session);
    });

    it('a close transaction that wins the row lock makes waiting active-only append/debit mutations return null', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAgentSessionsRepo(
        { client, db, close: async () => {} },
        { transcriptEncryptionKeyBase64: TRANSCRIPT_KEY },
      );

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`agt-active-fence-${accountId}@test.local`})`;
      const session = await repo.create({ accountId, tokenBudgetTotal: 1000 });

      let releaseClose!: () => void;
      const closeBlocker = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      let markCloseLocked!: () => void;
      const closeLocked = new Promise<void>((resolve) => {
        markCloseLocked = resolve;
      });
      const closeTransaction = client.begin(async (tx) => {
        await tx`
          UPDATE agent_sessions
             SET status = 'closed',
                 closed_reason = 'customer-closed',
                 closed_at = now(),
                 updated_at = now()
           WHERE id = ${session.id}
             AND status = 'active'
        `;
        markCloseLocked();
        await closeBlocker;
      });

      await closeLocked;
      const lateAppend = repo.appendTranscriptIfActive(session.id, {
        at: 'late',
        role: 'agent',
        body: 'must not land',
      });
      const lateDebit = repo.debitTokensIfActive(session.id, 400);
      releaseClose();
      await closeTransaction;

      await expect(lateAppend).resolves.toBeNull();
      await expect(lateDebit).resolves.toBeNull();
      expect(await repo.get(session.id)).toMatchObject({
        status: 'closed',
        closedReason: 'customer-closed',
        tokenBudgetRemaining: 1000,
        transcript: [],
      });
    });

    it('close-before-claim refuses fleet ownership and preserves the complete terminal row', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAgentSessionsRepo(
        { client, db, close: async () => {} },
        { transcriptEncryptionKeyBase64: TRANSCRIPT_KEY },
      );

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`agt-claim-close-first-${accountId}@test.local`})`;
      const session = await repo.create({ accountId, tokenBudgetTotal: 1000 });
      const closed = await repo.closeWithReason(session.id, 'customer-closed');

      await expect(repo.setNodeId(session.id, 'node-too-late')).resolves.toBeNull();
      expect(await repo.get(session.id)).toEqual(closed);
      expect(await repo.get(session.id)).toMatchObject({
        status: 'closed',
        closedReason: 'customer-closed',
        nodeId: null,
      });
    });

    it('claim-before-close persists one owner, then every late ownership claim is inert', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAgentSessionsRepo(
        { client, db, close: async () => {} },
        { transcriptEncryptionKeyBase64: TRANSCRIPT_KEY },
      );

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`agt-claim-first-${accountId}@test.local`})`;
      const session = await repo.create({ accountId, tokenBudgetTotal: 1000 });
      const claimed = await repo.setNodeId(session.id, 'node-owner');
      expect(claimed).toMatchObject({ status: 'active', nodeId: 'node-owner' });

      const closed = await repo.closeWithReason(session.id, 'customer-closed');
      expect(closed).toMatchObject({
        status: 'closed',
        closedReason: 'customer-closed',
        nodeId: 'node-owner',
      });
      await expect(repo.setNodeId(session.id, 'node-too-late')).resolves.toBeNull();
      expect(await repo.get(session.id)).toEqual(closed);
    });
  },
);
