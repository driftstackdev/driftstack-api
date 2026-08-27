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
import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import { DrizzleAgentSessionsRepo } from '../../src/db/agent-sessions-repo.js';
import type * as schema from '../../src/db/schema.js';
import type { TranscriptEntry } from '../../src/services/agent-decomposer.js';

// Runs against its OWN database: this file calls a GLOBAL envelope migration,
// which scans its whole table and therefore depends on rows owned by whatever
// else is running. See _helpers/isolated-database.ts for why fixture discipline
// cannot close that and isolation can.
const ISOLATED_DB_NAME = 'driftstack_iso_agent_conc';
let DB_URL = '';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const TRANSCRIPT_KEY = Buffer.alloc(32, 11).toString('base64');
const TEST_SCHEMA = `agent_sessions_concurrency_${randomUUID().replaceAll('-', '')}`;

let dbReachable = false;
let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
// accountIds seeded — cleaned in FK order: agent_sessions → accounts.
const seeded: string[] = [];

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null) return;
  DB_URL = isolated;
  if (!RUN_DB_TESTS) return;
  admin = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await admin`SELECT 1`;
  } catch (error) {
    await admin.end({ timeout: 1 }).catch(() => {});
    admin = null;
    throw error;
  }
  await admin.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  await admin.unsafe(`CREATE TABLE "${TEST_SCHEMA}".accounts (LIKE public.accounts INCLUDING ALL)`);
  await admin.unsafe(
    `CREATE TABLE "${TEST_SCHEMA}".agent_sessions (LIKE public.agent_sessions INCLUDING ALL)`,
  );
  // LIKE INCLUDING ALL does not copy triggers. Install the exact 0107 trigger
  // in this isolated schema so the real-Postgres tests exercise the production
  // authority epoch rather than a test-only repository approximation. The
  // IF-NOT-EXISTS column keeps this runnable against a pre-migration local DB;
  // CI's migrated public template already contributes the same column.
  await admin.unsafe(`
    ALTER TABLE "${TEST_SCHEMA}".agent_sessions
      ADD COLUMN IF NOT EXISTS authority_revision bigint NOT NULL DEFAULT 0
  `);
  await admin.unsafe(`
    CREATE FUNCTION "${TEST_SCHEMA}".agent_sessions_bump_authority_revision()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.status IS DISTINCT FROM NEW.status
         OR OLD.mode IS DISTINCT FROM NEW.mode
         OR OLD.pair_mode_state IS DISTINCT FROM NEW.pair_mode_state THEN
        NEW.authority_revision := OLD.authority_revision + 1;
      ELSE
        NEW.authority_revision := OLD.authority_revision;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER agent_sessions_authority_revision_trigger
    BEFORE UPDATE ON "${TEST_SCHEMA}".agent_sessions
    FOR EACH ROW
    EXECUTE FUNCTION "${TEST_SCHEMA}".agent_sessions_bump_authority_revision();
  `);
  // max: 5 so concurrent transactions get distinct connections — the
  // FOR-UPDATE row lock, not connection serialisation, is what's exercised.
  client = postgres(DB_URL, {
    max: 5,
    connection: { options: `-c search_path=${TEST_SCHEMA}` },
  });
  const [current] = await client<Array<{ value: string }>>`SELECT current_schema() AS value`;
  expect(current?.value).toBe(TEST_SCHEMA);
  dbReachable = true;
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM agent_sessions WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
  if (admin) {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await admin.end({ timeout: 5 });
  }
});

describe.skipIf(!RUN_DB_TESTS)(
  'agent_sessions debitTokens/appendTranscript atomicity under concurrency (Drizzle path, real Postgres)',
  () => {
    it('CRITICAL the dependency was reachable, so a green here is not "no service". V-793 — this arm previously sat inside beforeAll, where vitest registers nothing: the assertion existed as text, never ran, and the hole it was written to close stayed open.', () => {
      // Every arm below early-returns when the handle is absent. Without this
      // one, a run against a dead service reports PASSED — a green meaning
      // "nothing was tested", indistinguishable from "the service agreed".
      expect(dbReachable, 'the integration dependency was unreachable').toBeTruthy();
    });

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
      await client`UPDATE agent_sessions SET transcript = ${JSON.stringify(legacy)}::text::jsonb WHERE id = ${session.id}`;

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

    it('authority epoch closes real PostgreSQL value-ABA, guarded-publication, and stale-close races', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAgentSessionsRepo(
        { client, db, close: async () => {} },
        { transcriptEncryptionKeyBase64: TRANSCRIPT_KEY },
      );

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`agt-authority-${accountId}@test.local`})`;
      const session = await repo.create({ accountId, tokenBudgetTotal: 1000 });
      expect(await repo.getAuthoritySnapshot(session.id)).toEqual({
        status: 'active',
        mode: 'ai',
        pairModeState: null,
        revision: 0,
      });

      let releaseTransition!: () => void;
      const transitionBlocker = new Promise<void>((resolve) => {
        releaseTransition = resolve;
      });
      let markTransitionLocked!: () => void;
      const transitionLocked = new Promise<void>((resolve) => {
        markTransitionLocked = resolve;
      });
      const transition = client.begin(async (tx) => {
        await tx`
          UPDATE agent_sessions
             SET mode = 'manual', pair_mode_state = NULL, updated_at = now()
           WHERE id = ${session.id}
        `;
        markTransitionLocked();
        await transitionBlocker;
      });

      await transitionLocked;
      const staleAppend = repo.appendTranscriptIfAuthorityRevision(session.id, 0, {
        at: 'stale',
        role: 'agent',
        body: 'must lose after the transition lock commits',
      });
      releaseTransition();
      await transition;
      await expect(staleAppend).resolves.toBeNull();
      expect((await repo.getAuthoritySnapshot(session.id))?.revision).toBe(1);

      // Return the visible tuple to its original value. The old revision still
      // cannot append or close: this is the concrete A→B→A regression.
      await client`
        UPDATE agent_sessions
           SET mode = 'ai', pair_mode_state = NULL, updated_at = now()
         WHERE id = ${session.id}
      `;
      expect(await repo.getAuthoritySnapshot(session.id)).toEqual({
        status: 'active',
        mode: 'ai',
        pairModeState: null,
        revision: 2,
      });
      await expect(
        repo.appendTranscriptIfAuthorityRevision(session.id, 0, {
          at: 'aba-stale',
          role: 'agent',
          body: 'must not land',
        }),
      ).resolves.toBeNull();
      await expect(
        repo.closeWithReasonIfAuthorityRevision(session.id, 0, 'stale-close'),
      ).resolves.toBeNull();

      // Unrelated and semantic no-op writes preserve the epoch; even a direct
      // attempt to forge the internal revision is overwritten by the trigger.
      await repo.debitTokensIfActive(session.id, 10);
      await repo.setNodeId(session.id, 'node-a');
      await repo.setMode(session.id, 'ai', null);
      await client`
        UPDATE agent_sessions SET authority_revision = 999 WHERE id = ${session.id}
      `;
      expect((await repo.getAuthoritySnapshot(session.id))?.revision).toBe(2);

      const appended = await repo.appendTranscriptIfAuthorityRevision(session.id, 2, {
        at: 'current',
        role: 'agent',
        body: 'current owner lands',
      });
      expect(appended?.transcript.map((entry) => entry.body)).toEqual(['current owner lands']);
      const closed = await repo.closeWithReasonIfAuthorityRevision(
        session.id,
        2,
        'current-owner-close',
      );
      expect(closed).toMatchObject({ status: 'closed', closedReason: 'current-owner-close' });
      expect((await repo.getAuthoritySnapshot(session.id))?.revision).toBe(3);
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

    it('a close transaction that wins the row lock makes every waiting active-only session mutation return null', async () => {
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
      const lateGuiKey = repo.setGuiControlKeyIfActive({
        id: session.id,
        ciphertext: Buffer.from('must-not-land'),
        expiresAt: new Date('2026-07-16T00:00:00.000Z'),
      });
      const lateMode = repo.setModeIfActive(session.id, 'pair', { kind: 'ai-driving' });
      releaseClose();
      await closeTransaction;

      await expect(lateAppend).resolves.toBeNull();
      await expect(lateDebit).resolves.toBeNull();
      await expect(lateGuiKey).resolves.toBeNull();
      await expect(lateMode).resolves.toBeNull();
      expect(await repo.get(session.id)).toMatchObject({
        status: 'closed',
        closedReason: 'customer-closed',
        tokenBudgetRemaining: 1000,
        transcript: [],
        guiControlKeyCiphertext: null,
        guiControlKeyExpiresAt: null,
        mode: 'ai',
        pairModeState: null,
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

    it('CRITICAL recordErrorEvent refuses a session owned by a DIFFERENT fleet node, and writes nothing. The second parameter is the reporting node, and `eq(node_id, reportingNodeId)` is the entire authorisation on this write: without it any registered Mac could stamp its own error frame onto another node’s session, which is what the customer is shown as the reason their run failed.', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAgentSessionsRepo(
        { client, db, close: async () => {} },
        { transcriptEncryptionKeyBase64: TRANSCRIPT_KEY },
      );

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`agt-err-owner-${accountId}@test.local`})`;
      const session = await repo.create({ accountId, tokenBudgetTotal: 1000 });
      expect(await repo.setNodeId(session.id, 'node-err-owner')).toMatchObject({
        nodeId: 'node-err-owner',
      });

      const mine = {
        timestamp: '2026-08-26T12:00:00.000Z',
        code: 'driver_crashed',
        severity: 'error',
        summary: 'the owning node reported this',
        detail: null,
        customerActionable: false,
        retryable: true,
      } as const;

      // Positive control: the owning node CAN write, so the refusal below is a
      // boundary rather than a method that never records anything.
      expect(
        (await repo.recordErrorEvent(session.id, 'node-err-owner', mine))?.lastErrorEvent?.code,
        'the OWNING node could not record its own error event',
      ).toBe('driver_crashed');

      const theirs = { ...mine, code: 'stranger_wrote_this', summary: 'a stranger node' } as const;
      expect(
        await repo.recordErrorEvent(session.id, 'node-err-stranger', theirs),
        'a stranger fleet node recorded an error event on a session it does not own',
      ).toBeNull();

      // Returning null is not enough — the row must be untouched. A write that
      // lands and then reports null is the same defect wearing a different face.
      expect(
        (await repo.get(session.id))?.lastErrorEvent?.code,
        "a stranger node's error event overwrote the owning node's",
      ).toBe('driver_crashed');
    });
  },
);
