// AI-A.c — Drizzle implementation of AgentSessionsRepo (migration 0042).
// Production wires this; tests/dev use InMemoryAgentSessionsRepo from
// services/agent-sessions.ts.
//
// Key shape rules (matching the in-memory variant + migration 0042):
//   - text PK `agt_<uuid>` minted at create.
//   - jsonb transcript stores a versioned application-encrypted envelope and
//     grows append-only via appendTranscript (full-row UPDATE rewrites the
//     encrypted jsonb; OK at the expected per-session volume — a transcript
//     with 100 messages is ~few KB jsonb). Ordinary reads accept only the
//     purpose/account/session-bound v2 envelope; bootstrap CAS-converts every
//     plaintext/v1 row to v2 before the app starts serving.
//   - debitTokens floors remaining at 0 (matches the in-memory
//     `Math.max(0, ...)`); the CHECK constraint `remaining <= total`
//     prevents the opposite drift.
//   - closeWithReason flips status to 'closed' + writes closed_reason
//     atomically.
//
// Concurrency note: debitTokens AND appendTranscript perform their
// read-modify-write inside a `db.transaction()` that SELECTs the row
// `FOR UPDATE` before mutating (mirrors stripe-webhooks-repo.setAccountTier).
// The row lock SERIALISES concurrent same-session debits/appends — a second
// transaction blocks on the SELECT until the first commits, then reads the
// post-update value. So no debit is lost (no under-billing → no uncapped
// bundled-LLM spend) and no transcript entry is dropped (no data loss).
// Earlier these were bare read-modify-writes (a get() SELECT then a SEPARATE
// UPDATE writing the JS-computed value) whose later UPDATE clobbered the
// earlier; that lost-update window is closed by the FOR-UPDATE transaction.
// debitTokens still floors remaining at 0 (the CHECK `remaining <= total`
// guards the opposite drift). Validated against real Postgres by
// db-agent-sessions-concurrency-drizzle.test.ts (CI; skips locally w/o DB).

import { verifyBootEncryptionKey } from '../lib/boot-key-verification.js';
import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, isNull, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { DEFAULT_AGENT_MODEL, type AgentModel } from '@driftstack/api-types';
import { ProfileInUseError } from '../lib/errors.js';
import type { Database } from './client.js';
import { agentSessions, sessions } from './schema.js';
import { profileSessionAdvisoryLockKey } from './profile-session-lock.js';
import type { TranscriptEntry } from '../services/agent-decomposer.js';
import {
  AGENT_TRANSCRIPT_ENVELOPE_KIND,
  readAgentTranscript,
} from '../services/agent-transcript-encryption.js';
import {
  AGENT_SESSION_TRANSCRIPT_ENVELOPE_KIND,
  convertLegacyAgentSessionTranscript,
  encryptAgentSessionTranscript,
  readAgentSessionTranscript,
} from '../services/agent-session-transcript-encryption.js';
import {
  AgentSessionErrorEventSchema,
  type AgentSessionAuthoritySnapshot,
  type CloseAgentSessionResult,
  type AgentSessionErrorEvent,
  type AgentSessionListPage,
  type AgentSessionRecord,
  type AgentSessionStatus,
  type AgentSessionsRepo,
  type CreateAgentSessionArgs,
} from '../services/agent-sessions.js';

// `agt_<uuid>` — the cursor we emit is the last row's id, so the keyset
// anchor lookup only runs for a well-formed id (guards a hand-crafted cursor;
// a non-matching value falls through to a first-page response).
const AGENT_SESSION_ID_RE = /^agt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TRANSCRIPT_MIGRATION_BATCH = 500;

function transcriptIsNotV2(): SQL {
  return sql`(
    (${agentSessions.transcript}->>'kind') IS DISTINCT FROM ${AGENT_SESSION_TRANSCRIPT_ENVELOPE_KIND}
    OR (${agentSessions.transcript}->>'version') IS DISTINCT FROM '2'
  )`;
}

function readLastErrorEvent(value: unknown): AgentSessionErrorEvent | null {
  const parsed = AgentSessionErrorEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function rowToRecord(
  row: typeof agentSessions.$inferSelect,
  transcriptEncryptionKeyBase64: string | undefined,
): AgentSessionRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    driftstackSessionId: row.driftstackSessionId,
    status: row.status as AgentSessionStatus,
    transcript: readAgentSessionTranscript(row.transcript, transcriptEncryptionKeyBase64, {
      accountId: row.accountId,
      sessionId: row.id,
    }),
    tokenBudgetTotal: row.tokenBudgetTotal,
    tokenBudgetRemaining: row.tokenBudgetRemaining,
    closedReason: row.closedReason,
    // v2-#9 + v2-#19 hardening columns — present on every row even
    // when migration 0047 left them NULL on legacy rows.
    idempotencyKey: row.idempotencyKey,
    createdByUserId: row.createdByUserId,
    closedAt: row.closedAt,
    // Arc 2 sub-slice 8.2 (v2-#8) — pair-mode + GUI-key columns from
    // migration 0052. Existing rows pick up mode='ai' from the CHECK
    // default; null for pair_mode_state + gui_control_key_expires_at.
    mode: (row.mode as 'manual' | 'ai' | 'pair') ?? 'ai',
    // 6.c / #15 — picked Claude 4.x model (migration 0066 column; backfill
    // default 'claude-opus-4-7', bumped to 'claude-opus-4-8' for new rows in 0087).
    model: (row.model as AgentModel) ?? DEFAULT_AGENT_MODEL,
    // 0086 — fleet node the session was dispatched to (NULL until dispatch /
    // on every no-fleet-CP row).
    nodeId: row.nodeId,
    // 0089 — the profile this session runs (NULL for ephemeral sessions / pre-
    // column rows). The out-of-session trim reads it via countActiveForProfile.
    profileId: row.profileId,
    // 0116 — proxy the session was dispatched through (NULL until dispatch / on
    // operator-default egress). The capabilityReport relay attributes a measured
    // QUIC verdict to this proxy.
    proxyId: row.proxyId,
    pairModeState: row.pairModeState,
    lastErrorEvent: readLastErrorEvent(row.lastErrorEvent),
    guiControlKeyExpiresAt: row.guiControlKeyExpiresAt,
    guiControlKeyCiphertext: row.guiControlKeyCiphertext,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleAgentSessionsRepo implements AgentSessionsRepo {
  private readonly clock: () => Date;
  private readonly transcriptEncryptionKeyBase64: string | undefined;

  constructor(
    private readonly database: Database,
    options: {
      transcriptEncryptionKeyBase64?: string;
      clock?: () => Date;
    } = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.transcriptEncryptionKeyBase64 = options.transcriptEncryptionKeyBase64;
  }

  private requireTranscriptEncryptionKey(): string {
    if (this.transcriptEncryptionKeyBase64 === undefined) {
      throw new Error('Agent transcript encryption key is unavailable.');
    }
    return this.transcriptEncryptionKeyBase64;
  }

  /**
   * Authenticate the configured key before rewriting anything, then convert a
   * bounded stable page of plaintext/v1 rows with exact-json compare-and-set.
   * Ordinary repository reads never call this legacy path.
   */
  async migrateTranscriptEnvelopes(
    limit = MAX_TRANSCRIPT_MIGRATION_BATCH,
  ): Promise<{ scanned: number; converted: number; remaining: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRANSCRIPT_MIGRATION_BATCH) {
      throw new Error(
        `Agent transcript migration limit must be an integer from 1 to ${MAX_TRANSCRIPT_MIGRATION_BATCH}.`,
      );
    }
    const key = this.requireTranscriptEncryptionKey();

    // Unknown/malformed objects must fail before any plaintext write. Exact v1
    // and v2 objects are separately authenticated below; arrays are the only
    // accepted plaintext legacy representation.
    const [malformedObject] = await this.database.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(
        sql`
        jsonb_typeof(${agentSessions.transcript}) = 'object'
        AND NOT (
          (
            (${agentSessions.transcript}->>'kind') IS NOT DISTINCT FROM ${AGENT_TRANSCRIPT_ENVELOPE_KIND}
            AND (${agentSessions.transcript}->>'version') IS NOT DISTINCT FROM '1'
          )
          OR (
            (${agentSessions.transcript}->>'kind') IS NOT DISTINCT FROM ${AGENT_SESSION_TRANSCRIPT_ENVELOPE_KIND}
            AND (${agentSessions.transcript}->>'version') IS NOT DISTINCT FROM '2'
          )
        )
      `,
      )
      .limit(1);
    if (malformedObject !== undefined) {
      throw new Error('Agent-session transcript storage contains a malformed envelope.');
    }

    // Production's first cutover has v1 envelopes but no v2 rows. Authenticate
    // one v1 before converting any arrays so an incorrect operator key cannot
    // partially rewrite plaintext under the wrong key.
    const [v1Probe] = await this.database.db
      .select({ transcript: agentSessions.transcript })
      .from(agentSessions)
      .where(
        sql`
        jsonb_typeof(${agentSessions.transcript}) = 'object'
        AND (${agentSessions.transcript}->>'kind') IS NOT DISTINCT FROM ${AGENT_TRANSCRIPT_ENVELOPE_KIND}
        AND (${agentSessions.transcript}->>'version') IS NOT DISTINCT FROM '1'
      `,
      )
      .limit(1);
    if (v1Probe !== undefined) {
      const probeTranscript = v1Probe.transcript;
      verifyBootEncryptionKey('Agent session transcripts', 'MFA_ENCRYPTION_KEY', () => {
        readAgentTranscript(probeTranscript, key);
      });
    }

    // On successor boots, authenticate one already-bound envelope with its
    // exact database identity before selecting the remaining legacy page.
    const [v2Probe] = await this.database.db
      .select({
        id: agentSessions.id,
        accountId: agentSessions.accountId,
        transcript: agentSessions.transcript,
      })
      .from(agentSessions)
      .where(
        sql`
        jsonb_typeof(${agentSessions.transcript}) = 'object'
        AND (${agentSessions.transcript}->>'kind') IS NOT DISTINCT FROM ${AGENT_SESSION_TRANSCRIPT_ENVELOPE_KIND}
        AND (${agentSessions.transcript}->>'version') IS NOT DISTINCT FROM '2'
      `,
      )
      .limit(1);
    if (v2Probe !== undefined) {
      readAgentSessionTranscript(v2Probe.transcript, key, {
        accountId: v2Probe.accountId,
        sessionId: v2Probe.id,
      });
    }

    const rows = await this.database.db
      .select({
        id: agentSessions.id,
        accountId: agentSessions.accountId,
        transcript: agentSessions.transcript,
      })
      .from(agentSessions)
      .where(transcriptIsNotV2())
      // Authenticate/convert encrypted legacy rows before plaintext arrays,
      // then use immutable created/id identity for deterministic pagination.
      .orderBy(
        sql`CASE WHEN jsonb_typeof(${agentSessions.transcript}) = 'object' THEN 0 ELSE 1 END`,
        asc(agentSessions.createdAt),
        asc(agentSessions.id),
      )
      .limit(limit);

    // Parse/decrypt the entire selected page before the first UPDATE. One bad
    // legacy array/envelope therefore cannot leave a partially converted page.
    const prepared = rows.map((row) => ({
      row,
      nextTranscript: convertLegacyAgentSessionTranscript(row.transcript, key, {
        accountId: row.accountId,
        sessionId: row.id,
      }),
    }));

    let converted = 0;
    for (const { row, nextTranscript } of prepared) {
      const updated = await this.database.db
        .update(agentSessions)
        .set({ transcript: nextTranscript })
        .where(
          and(
            eq(agentSessions.id, row.id),
            sql`${agentSessions.transcript} IS NOT DISTINCT FROM ${JSON.stringify(row.transcript)}::jsonb`,
          ),
        )
        .returning({ id: agentSessions.id });
      if (updated.length === 1) converted += 1;
    }

    const [remainingRow] = await this.database.db
      .select({ value: count() })
      .from(agentSessions)
      .where(transcriptIsNotV2());
    return { scanned: rows.length, converted, remaining: remainingRow?.value ?? 0 };
  }

  async create(args: CreateAgentSessionArgs): Promise<AgentSessionRecord> {
    const key = this.requireTranscriptEncryptionKey();
    const id = `agt_${randomUUID()}`;
    const now = this.clock();
    const inserted = await this.database.db
      .insert(agentSessions)
      .values({
        id,
        accountId: args.accountId,
        driftstackSessionId: args.driftstackSessionId ?? null,
        status: 'active',
        // Same seed handling as createIfUnderActiveCap below — the in-memory twin
        // honors seedTranscript on BOTH creates, and a twin that seeds where the
        // real repo silently encrypts [] is exactly the kind of double that hides
        // the real artifact. Re-sealed under the NEW id (AAD binds the session).
        transcript: encryptAgentSessionTranscript(args.seedTranscript ?? [], key, {
          accountId: args.accountId,
          sessionId: id,
        }),
        tokenBudgetTotal: args.tokenBudgetTotal,
        tokenBudgetRemaining: args.tokenBudgetTotal,
        // v2-#19 hardening columns — partial unique index on
        // (account_id, idempotency_key) enforces "first-write wins" if
        // the route layer races two POSTs with the same key. Postgres
        // raises a UniqueViolation; the route layer's findByIdempotencyKey
        // pre-check is the primary dedupe surface.
        idempotencyKey: args.idempotencyKey ?? null,
        createdByUserId: args.createdByUserId ?? null,
        // Arc 2 sub-slice 8.2 — mode forwarded from caller (or default
        // via DB CHECK constraint when args.mode is omitted).
        ...(args.mode !== undefined ? { mode: args.mode } : {}),
        // 6.c / #15 — model forwarded from caller (or default via DB
        // CHECK constraint when args.model is omitted).
        ...(args.model !== undefined ? { model: args.model } : {}),
        // 0089 — the profile this session runs, when the create carried a
        // profile_id; column defaults NULL (ephemeral session) when omitted.
        ...(args.profileId !== undefined ? { profileId: args.profileId } : {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      throw new Error('AgentSession insert returned no rows');
    }
    return rowToRecord(row, key);
  }

  async createIfUnderActiveCap(
    args: CreateAgentSessionArgs,
    cap: number,
  ): Promise<AgentSessionRecord | null> {
    // Audit #8 (atomicity) — count active + insert atomically so concurrent
    // creates for the same account can't all pass a stale count and overshoot
    // the cap. A per-account advisory xact lock (auto-released on commit/
    // rollback) serialises same-account creates; different accounts hash to
    // different keys so there is no cross-account contention. Mirrors
    // SessionsRepo.insertSessionIfUnderLimit (the proven pattern for the legacy
    // sessions table). Returns null when already at/over the cap.
    //
    // A3 finding #7 (W2979/W2980) — global single-active-session-per-profile
    // guard. When `args.profileId` is set, this takes the canonical cross-surface
    // advisory lock + checks BOTH agent_sessions and legacy sessions. The legacy
    // create path takes the exact same lock and checks the same two tables, so a
    // mixed /v1/sessions ↔ /v1/agent-sessions race has exactly one winner. Throw
    // ProfileInUseError(activeSessionId) with the competing public session id. This
    // prevents a cross-node sealed-blob clobber (two sessions restore the same blob,
    // diverge, then both save back). A create WITHOUT a profile_id never takes the
    // profile lock or runs the check. The account cap lock is taken first, then the
    // profile lock (stable accountId-before-profileId acquisition order).
    const key = this.requireTranscriptEncryptionKey();
    const id = `agt_${randomUUID()}`;
    const now = this.clock();
    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`agent-session-create:${args.accountId}`}))`,
      );
      if (args.profileId !== undefined) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${profileSessionAdvisoryLockKey(args.profileId)}))`,
        );
        const [liveAgent] = await tx
          .select({ id: agentSessions.id })
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.accountId, args.accountId),
              eq(agentSessions.profileId, args.profileId),
              // Non-terminal = anything but 'closed' (the only terminal agent-
              // session status; 'active'/'paused' are live binds).
              notInArray(agentSessions.status, ['closed']),
            ),
          )
          .limit(1);
        if (liveAgent) {
          throw new ProfileInUseError(liveAgent.id);
        }
        const [liveLegacy] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.accountId, args.accountId),
              sql`${sessions.metadata}->>'profile_id' = ${args.profileId}`,
              notInArray(sessions.status, ['destroyed', 'errored']),
              isNull(sessions.destroyedAt),
            ),
          )
          .limit(1);
        if (liveLegacy) {
          throw new ProfileInUseError(`ses_${liveLegacy.id}`);
        }
      }
      const [countRow] = await tx
        .select({ n: count() })
        .from(agentSessions)
        .where(
          and(eq(agentSessions.accountId, args.accountId), eq(agentSessions.status, 'active')),
        );
      if ((countRow?.n ?? 0) >= cap) return null;
      const inserted = await tx
        .insert(agentSessions)
        .values({
          id,
          accountId: args.accountId,
          driftstackSessionId: args.driftstackSessionId ?? null,
          status: 'active',
          // Encrypted under the NEW id: the envelope's AAD binds
          // {accountId, sessionId}, so a continued chat's entries must be
          // re-sealed here rather than copied as ciphertext.
          transcript: encryptAgentSessionTranscript(args.seedTranscript ?? [], key, {
            accountId: args.accountId,
            sessionId: id,
          }),
          tokenBudgetTotal: args.tokenBudgetTotal,
          tokenBudgetRemaining: args.tokenBudgetTotal,
          idempotencyKey: args.idempotencyKey ?? null,
          createdByUserId: args.createdByUserId ?? null,
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          ...(args.model !== undefined ? { model: args.model } : {}),
          ...(args.profileId !== undefined ? { profileId: args.profileId } : {}),
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const row = inserted[0];
      if (!row) {
        throw new Error('AgentSession insert returned no rows');
      }
      return rowToRecord(row, key);
    });
  }

  async get(id: string): Promise<AgentSessionRecord | null> {
    const rows = await this.database.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    const row = rows[0];
    return row ? rowToRecord(row, this.transcriptEncryptionKeyBase64) : null;
  }

  async getAuthoritySnapshot(id: string): Promise<AgentSessionAuthoritySnapshot | null> {
    // Deliberately avoid selecting/decrypting transcript or credential fields:
    // this is the hot continuation fence around provider/browser awaits.
    const rows = await this.database.db
      .select({
        status: agentSessions.status,
        mode: agentSessions.mode,
        pairModeState: agentSessions.pairModeState,
        revision: agentSessions.authorityRevision,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      status: row.status as AgentSessionAuthoritySnapshot['status'],
      mode: row.mode as AgentSessionAuthoritySnapshot['mode'],
      pairModeState: row.pairModeState,
      revision: row.revision,
    };
  }

  async listByAccount(
    accountId: string,
    opts?: { limit?: number },
  ): Promise<ReadonlyArray<AgentSessionRecord>> {
    // Push the sort + cap to the DB so a busy account's full session history
    // isn't fetched into memory on every list call (the only caller renders just
    // the most-recent page). Most-recent first; (created_at, id) desc is a stable
    // total order for the tiebreak.
    const base = this.database.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.accountId, accountId))
      .orderBy(desc(agentSessions.createdAt), desc(agentSessions.id));
    const rows = opts?.limit !== undefined ? await base.limit(opts.limit) : await base;
    return rows.map((row) => rowToRecord(row, this.transcriptEncryptionKeyBase64));
  }

  async listPageByAccount(
    accountId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<AgentSessionListPage> {
    // Keyset cursor on (createdAt desc, id desc) — mirrors sessions-repo
    // listSessions. Cursor = the last row's id; resolve its (createdAt, id)
    // anchor and select strictly-after rows so same-createdAt rows aren't
    // dropped at a page boundary. The `id` PK is `agt_<uuid>` text (not a uuid
    // column), so an unknown cursor just resolves to no anchor → first page,
    // matching the in-memory double + the sessions-repo semantics.
    const conds: SQL[] = [eq(agentSessions.accountId, accountId)];
    if (opts.cursor !== undefined && AGENT_SESSION_ID_RE.test(opts.cursor)) {
      const [c] = await this.database.db
        .select({ createdAt: agentSessions.createdAt, id: agentSessions.id })
        .from(agentSessions)
        .where(and(eq(agentSessions.id, opts.cursor), eq(agentSessions.accountId, accountId)))
        .limit(1);
      if (c) {
        const keyset = or(
          lt(agentSessions.createdAt, c.createdAt),
          and(eq(agentSessions.createdAt, c.createdAt), lt(agentSessions.id, c.id)),
        );
        if (keyset) conds.push(keyset);
      }
    }

    const rows = await this.database.db
      .select()
      .from(agentSessions)
      .where(and(...conds))
      .orderBy(desc(agentSessions.createdAt), desc(agentSessions.id))
      .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map((row) => rowToRecord(row, this.transcriptEncryptionKeyBase64)),
      nextCursor: hasMore && last ? last.id : null,
    };
  }

  async countActive(accountId: string): Promise<number> {
    const rows = await this.database.db
      .select({ n: count() })
      .from(agentSessions)
      .where(and(eq(agentSessions.accountId, accountId), eq(agentSessions.status, 'active')));
    return rows[0]?.n ?? 0;
  }

  async countActiveForProfile(profileId: string): Promise<number> {
    // 0089 — backed by the partial index agent_sessions_profile_id_active_idx
    // (ON (profile_id) WHERE status = 'active'). NULL profile_id never matches.
    const rows = await this.database.db
      .select({ n: count() })
      .from(agentSessions)
      .where(and(eq(agentSessions.profileId, profileId), eq(agentSessions.status, 'active')));
    return rows[0]?.n ?? 0;
  }

  async appendTranscript(id: string, entry: TranscriptEntry): Promise<AgentSessionRecord> {
    // Atomic append under a row lock (see the file header concurrency note):
    // SELECT … FOR UPDATE inside a transaction serialises concurrent
    // same-session appends, so two racing turns never lose an entry — the
    // second blocks until the first commits, then appends to the up-to-date
    // transcript. (Was a bare read-modify-write whose later UPDATE clobbered
    // the earlier → a dropped transcript entry.)
    const key = this.requireTranscriptEncryptionKey();
    const now = this.clock();
    return this.database.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, id))
        .for('update')
        .limit(1);
      const existing = rows[0];
      if (!existing) {
        throw new Error(`AgentSession ${id} not found`);
      }
      const context = { accountId: existing.accountId, sessionId: existing.id };
      const currentTranscript = readAgentSessionTranscript(existing.transcript, key, context);
      const nextTranscript = [...currentTranscript, entry];
      const encryptedTranscript = encryptAgentSessionTranscript(nextTranscript, key, context);
      const updated = await tx
        .update(agentSessions)
        .set({ transcript: encryptedTranscript, updatedAt: now })
        .where(eq(agentSessions.id, id))
        .returning();
      const row = updated[0];
      if (!row) {
        throw new Error(`AgentSession ${id} disappeared mid-transaction`);
      }
      return rowToRecord(row, key);
    });
  }

  async appendTranscriptIfActive(
    id: string,
    entry: TranscriptEntry,
  ): Promise<AgentSessionRecord | null> {
    const key = this.requireTranscriptEncryptionKey();
    const now = this.clock();
    return this.database.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(agentSessions)
        .where(and(eq(agentSessions.id, id), eq(agentSessions.status, 'active')))
        .for('update')
        .limit(1);
      const existing = rows[0];
      if (!existing) return null;
      const context = { accountId: existing.accountId, sessionId: existing.id };
      const currentTranscript = readAgentSessionTranscript(existing.transcript, key, context);
      const encryptedTranscript = encryptAgentSessionTranscript(
        [...currentTranscript, entry],
        key,
        context,
      );
      const updated = await tx
        .update(agentSessions)
        .set({ transcript: encryptedTranscript, updatedAt: now })
        .where(and(eq(agentSessions.id, id), eq(agentSessions.status, 'active')))
        .returning();
      const row = updated[0];
      return row ? rowToRecord(row, key) : null;
    });
  }

  async appendTranscriptIfAuthorityRevision(
    id: string,
    expectedRevision: number,
    entry: TranscriptEntry,
  ): Promise<AgentSessionRecord | null> {
    const key = this.requireTranscriptEncryptionKey();
    const now = this.clock();
    return this.database.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.id, id),
            eq(agentSessions.status, 'active'),
            eq(agentSessions.authorityRevision, expectedRevision),
          ),
        )
        .for('update')
        .limit(1);
      const existing = rows[0];
      if (!existing) return null;
      const context = { accountId: existing.accountId, sessionId: existing.id };
      const currentTranscript = readAgentSessionTranscript(existing.transcript, key, context);
      const encryptedTranscript = encryptAgentSessionTranscript(
        [...currentTranscript, entry],
        key,
        context,
      );
      const updated = await tx
        .update(agentSessions)
        .set({ transcript: encryptedTranscript, updatedAt: now })
        .where(
          and(
            eq(agentSessions.id, id),
            eq(agentSessions.status, 'active'),
            eq(agentSessions.authorityRevision, expectedRevision),
          ),
        )
        .returning();
      const row = updated[0];
      return row ? rowToRecord(row, key) : null;
    });
  }

  async debitTokens(id: string, tokens: number): Promise<AgentSessionRecord> {
    // Atomic debit under a row lock (see the file header concurrency note):
    // SELECT … FOR UPDATE inside a transaction serialises concurrent
    // same-session debits, so two racing turns never lose one — the second
    // blocks until the first commits, then debits the up-to-date remaining.
    // Floored at 0 (CHECK `remaining <= total` guards the opposite drift).
    // (Was a bare read-modify-write whose later UPDATE clobbered the earlier
    // → under-debit / budget over-served.)
    const now = this.clock();
    return this.database.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, id))
        .for('update')
        .limit(1);
      const existing = rows[0];
      if (!existing) {
        throw new Error(`AgentSession ${id} not found`);
      }
      const nextRemaining = Math.max(0, existing.tokenBudgetRemaining - tokens);
      const updated = await tx
        .update(agentSessions)
        .set({ tokenBudgetRemaining: nextRemaining, updatedAt: now })
        .where(eq(agentSessions.id, id))
        .returning();
      const row = updated[0];
      if (!row) {
        throw new Error(`AgentSession ${id} disappeared mid-transaction`);
      }
      return rowToRecord(row, this.transcriptEncryptionKeyBase64);
    });
  }

  async debitTokensIfActive(id: string, tokens: number): Promise<AgentSessionRecord | null> {
    const now = this.clock();
    return this.database.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(agentSessions)
        .where(and(eq(agentSessions.id, id), eq(agentSessions.status, 'active')))
        .for('update')
        .limit(1);
      const existing = rows[0];
      if (!existing) return null;
      const nextRemaining = Math.max(0, existing.tokenBudgetRemaining - tokens);
      const updated = await tx
        .update(agentSessions)
        .set({ tokenBudgetRemaining: nextRemaining, updatedAt: now })
        .where(and(eq(agentSessions.id, id), eq(agentSessions.status, 'active')))
        .returning();
      const row = updated[0];
      return row ? rowToRecord(row, this.transcriptEncryptionKeyBase64) : null;
    });
  }

  async recordErrorEvent(
    id: string,
    reportingNodeId: string,
    event: AgentSessionErrorEvent,
  ): Promise<AgentSessionRecord | null> {
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({ lastErrorEvent: event, updatedAt: now })
      .where(and(eq(agentSessions.id, id), eq(agentSessions.nodeId, reportingNodeId)))
      .returning();
    const row = updated[0];
    return row ? rowToRecord(row, this.transcriptEncryptionKeyBase64) : null;
  }

  async closeWithReason(id: string, reason: string): Promise<AgentSessionRecord> {
    return (await this.closeWithReasonOutcome(id, reason)).session;
  }

  async closeWithReasonOutcome(id: string, reason: string): Promise<CloseAgentSessionResult> {
    // TOCTOU-race fix (audit 2026-07-01) — this used to be a plain
    // read-then-write: a `get()` (only to preserve closedAt on a re-close),
    // then an UNCONDITIONAL `UPDATE … WHERE id=$id`. That left a real race
    // against any OTHER closer of the same session (e.g. the worker-
    // terminal-close service racing this node's own bootId sweep, or a
    // customer DELETE racing a budget-exhausted close): whichever call's
    // UPDATE landed LAST always won, silently overwriting an earlier
    // closer's true closed_reason with a stale/wrong one — closed_at was
    // safe (read-before-write), but closed_reason was not — surfaced to
    // customers via GET /v1/agent-sessions/:id's closed_reason field.
    //
    // Fixed: a single UPDATE … WHERE id=$id AND status!='closed' RETURNING *,
    // mirroring closeActiveByNodeExcept's atomic-sweep pattern below. A
    // matching row is ALWAYS in its FIRST terminal transition (a closed row
    // never flips back), while a challenge-paused session remains closeable.
    // closed_at is therefore always "now" here; no read-before-write needed.
    //
    // A 0-row result means another closer's UPDATE already won the race (the
    // row is already 'closed') — or, rarely, the id is genuinely unknown.
    // Treated as a safe no-op: re-fetch and return the CURRENT row (whatever
    // its real closed_reason is) instead of throwing/re-writing, so none of
    // this method's call sites (grepped: the never-dispatched egress-close in
    // routes/agent-sessions.ts, the customer DELETE route, the worker-
    // terminal-close service, and the budget-exhausted runtime close — none
    // of which inspect the returned closed_reason) regress; a genuinely-
    // unknown id still throws, matching every call site's not-found
    // expectation.
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({ status: 'closed', closedReason: reason, closedAt: now, updatedAt: now })
      .where(and(eq(agentSessions.id, id), notInArray(agentSessions.status, ['closed'])))
      .returning();
    const row = updated[0];
    if (row) {
      return { kind: 'closed', session: rowToRecord(row, this.transcriptEncryptionKeyBase64) };
    }
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`AgentSession ${id} not found`);
    }
    return { kind: 'already_closed', session: existing };
  }

  async closeWithReasonIfAuthorityRevision(
    id: string,
    expectedRevision: number,
    reason: string,
  ): Promise<AgentSessionRecord | null> {
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({ status: 'closed', closedReason: reason, closedAt: now, updatedAt: now })
      .where(
        and(
          eq(agentSessions.id, id),
          eq(agentSessions.status, 'active'),
          eq(agentSessions.authorityRevision, expectedRevision),
        ),
      )
      .returning();
    const row = updated[0];
    return row ? rowToRecord(row, this.transcriptEncryptionKeyBase64) : null;
  }

  async listActivePairModeSessionIds(): Promise<string[]> {
    // V-785 — boot seed for the pair-mode heartbeat tracker. `pair_mode_state` is
    // persisted but the tracker that clears it is a process-local Map, so after a
    // restart a parked session is invisible to the 5s sweep and the documented
    // 30s revert to `ai-driving` never fires. A session in `takeover-pending`
    // cannot re-register itself: the input-event route 409s on that state before
    // reaching `recordHeartbeat`.
    //
    // `IS DISTINCT FROM` rather than `<>` so a row whose `kind` is absent or
    // JSON null still matches — a malformed parked state is the one most in need
    // of a timeout, and `<>` would silently drop it to NULL and exclude it.
    const rows = await this.database.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.status, 'active'),
          sql`${agentSessions.pairModeState} IS NOT NULL`,
          sql`(${agentSessions.pairModeState}->>'kind') IS DISTINCT FROM 'ai-driving'`,
        ),
      );
    return rows.map((r) => r.id);
  }

  async reapOrphanedActiveBefore(cutoff: Date): Promise<number> {
    // Orphaned-session backstop (2026-06-19) — agent sessions only flip to
    // 'closed' on an explicit DELETE or budget exhaustion. When a worker dies
    // mid-session the row lingers status='active' forever. This wall-clock
    // backstop bulk-closes any session that has been 'active' longer than the
    // (generous) lifetime cap. CRITICAL INVARIANT: the WHERE is anchored on
    // BOTH status='active' AND created_at < cutoff, so a still-live session
    // (created_at >= cutoff) or an already-closed row is NEVER touched. The
    // closed_at/closed_reason are set in the same statement; idempotent
    // (re-running closes nothing new because the rows are no longer 'active').
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({
        status: 'closed',
        closedReason: 'orphaned-lifetime',
        closedAt: now,
        updatedAt: now,
      })
      .where(and(eq(agentSessions.status, 'active'), lt(agentSessions.createdAt, cutoff)))
      .returning({ id: agentSessions.id });
    return updated.length;
  }

  async setNodeId(
    id: string,
    nodeId: string,
    proxyId?: string | null,
  ): Promise<AgentSessionRecord | null> {
    // Worker-disconnect fix (2026-06-19) — persist which node a session was
    // dispatched to. This UPDATE is the atomic active-only ownership claim:
    // a dispatch can race DELETE, a reaper, or worker close, so missing and
    // terminal rows both return null and can never receive a later assignment.
    // T-6 — when the caller supplies proxyId, record which proxy the session
    // browses through on the SAME atomic claim; an omitted argument leaves
    // proxy_id untouched.
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({ nodeId, ...(proxyId !== undefined ? { proxyId } : {}), updatedAt: now })
      .where(and(eq(agentSessions.id, id), eq(agentSessions.status, 'active')))
      .returning();
    const row = updated[0];
    return row ? rowToRecord(row, this.transcriptEncryptionKeyBase64) : null;
  }

  async closeActiveByNode(nodeId: string, reason: string): Promise<number> {
    // Worker-disconnect fix (2026-06-19) — bulk-close a node's still-active
    // sessions when the node drops and doesn't reconnect within the grace
    // window. CRITICAL INVARIANT: the WHERE is anchored on BOTH status='active'
    // AND node_id=nodeId, so another node's sessions, already-closed sessions,
    // and never-dispatched rows (node_id NULL — `eq` never matches NULL) are
    // NEVER touched. closed_at/closed_reason set in the same statement;
    // idempotent (re-running closes nothing new — the rows are no longer
    // 'active'). Backed by the agent_sessions_node_id_active_idx partial index.
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({
        status: 'closed',
        closedReason: reason,
        closedAt: now,
        updatedAt: now,
      })
      .where(and(eq(agentSessions.status, 'active'), eq(agentSessions.nodeId, nodeId)))
      .returning({ id: agentSessions.id });
    return updated.length;
  }

  async closeActiveByNodeExcept(
    nodeId: string,
    keepIds: readonly string[],
    reason: string,
    opts: { minIdleMs?: number } = {},
  ): Promise<number> {
    // A2 W2813 bootId consumer — close a restarted node's still-active sessions
    // EXCEPT the ids the new boot reaffirmed in its heartbeat (keepIds). Same
    // invariant as closeActiveByNode (status='active' AND node_id=nodeId; NULL
    // node_id never matches `eq`). Single atomic UPDATE; idempotent.
    //
    // RECENCY GUARD (W2820, review wxbkih0x2): `keepIds` ALONE is NOT a sufficient
    // safety net. A session dispatched to the NEW boot commits setNodeId (row
    // active+node_id, updatedAt=now) BEFORE the harness reports it in
    // activeSessionStates (the assign is fire-and-forget; the harness echoes it
    // only on a LATER beat), so a just-assigned LIVE session is absent from keepIds
    // on the bootId-change beat and would be wrongly closed. `minIdleMs` fences
    // that out: only sweep sessions whose `updatedAt` is OLDER than now−minIdleMs.
    // setNodeId bumps updatedAt, so a freshly-assigned session (updatedAt≈now) is
    // never eligible; a genuine orphan (untouched since before the restart) is. A
    // recently-active old-boot orphan that escapes the window is left to the
    // disconnect reaper / 12h orphan_reap — SAFE (never a false close of a live row).
    const now = this.clock();
    const minIdleMs = opts.minIdleMs ?? 0;
    const conds = [eq(agentSessions.status, 'active'), eq(agentSessions.nodeId, nodeId)];
    if (keepIds.length > 0) conds.push(notInArray(agentSessions.id, [...keepIds]));
    if (minIdleMs > 0) conds.push(lt(agentSessions.updatedAt, new Date(now.getTime() - minIdleMs)));
    const updated = await this.database.db
      .update(agentSessions)
      .set({
        status: 'closed',
        closedReason: reason,
        closedAt: now,
        updatedAt: now,
      })
      .where(and(...conds))
      .returning({ id: agentSessions.id });
    return updated.length;
  }

  async setGuiControlKey(args: {
    id: string;
    ciphertext: Buffer | null;
    expiresAt: Date | null;
  }): Promise<AgentSessionRecord> {
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({
        guiControlKeyCiphertext: args.ciphertext,
        guiControlKeyExpiresAt: args.expiresAt,
        updatedAt: now,
      })
      .where(eq(agentSessions.id, args.id))
      .returning();
    const row = updated[0];
    if (!row) {
      throw new Error(`AgentSession ${args.id} not found`);
    }
    return rowToRecord(row, this.transcriptEncryptionKeyBase64);
  }

  async setGuiControlKeyIfActive(args: {
    id: string;
    ciphertext: Buffer | null;
    expiresAt: Date | null;
  }): Promise<AgentSessionRecord | null> {
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({
        guiControlKeyCiphertext: args.ciphertext,
        guiControlKeyExpiresAt: args.expiresAt,
        updatedAt: now,
      })
      .where(and(eq(agentSessions.id, args.id), eq(agentSessions.status, 'active')))
      .returning();
    const row = updated[0];
    return row ? rowToRecord(row, this.transcriptEncryptionKeyBase64) : null;
  }

  async setPairModeState(id: string, state: unknown): Promise<AgentSessionRecord> {
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({ pairModeState: state, updatedAt: now })
      .where(eq(agentSessions.id, id))
      .returning();
    const row = updated[0];
    if (!row) {
      throw new Error(`AgentSession ${id} not found`);
    }
    return rowToRecord(row, this.transcriptEncryptionKeyBase64);
  }

  async compareAndSetPairModeState(
    id: string,
    expectedState: unknown,
    nextState: unknown,
  ): Promise<AgentSessionRecord | null> {
    // JSONB equality is structural (object key order is irrelevant). Cast a
    // bound JSON string instead of interpolating object text so the expected
    // state remains a parameter and cannot alter the SQL expression. Legacy
    // pair sessions can store SQL NULL, which is distinct from JSONB `null`,
    // so preserve that raw persisted representation with an explicit branch.
    const expectedJson = JSON.stringify(expectedState);
    if (expectedJson === undefined) {
      throw new Error('expected pair-mode state must be JSON-serializable');
    }
    const expectedStatePredicate =
      expectedState === null
        ? isNull(agentSessions.pairModeState)
        : sql`${agentSessions.pairModeState} IS NOT DISTINCT FROM ${expectedJson}::jsonb`;
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({ pairModeState: nextState, updatedAt: now })
      .where(
        and(
          eq(agentSessions.id, id),
          eq(agentSessions.status, 'active'),
          eq(agentSessions.mode, 'pair'),
          expectedStatePredicate,
        ),
      )
      .returning();
    const row = updated[0];
    return row ? rowToRecord(row, this.transcriptEncryptionKeyBase64) : null;
  }

  async setMode(
    id: string,
    mode: 'manual' | 'ai' | 'pair',
    pairModeState: unknown,
  ): Promise<AgentSessionRecord> {
    // Slice 3 — atomic dual-column write. Single UPDATE statement
    // means concurrent /mode calls serialize at the row level; the
    // last writer wins. The route layer guards against the lossy
    // "interleave with mid-flight takeover" case by inspecting
    // pair_mode_state before issuing the transition.
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({ mode, pairModeState, updatedAt: now })
      .where(eq(agentSessions.id, id))
      .returning();
    const row = updated[0];
    if (!row) {
      throw new Error(`AgentSession ${id} not found`);
    }
    return rowToRecord(row, this.transcriptEncryptionKeyBase64);
  }

  async setModeIfActive(
    id: string,
    mode: 'manual' | 'ai' | 'pair',
    pairModeState: unknown,
  ): Promise<AgentSessionRecord | null> {
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({ mode, pairModeState, updatedAt: now })
      .where(and(eq(agentSessions.id, id), eq(agentSessions.status, 'active')))
      .returning();
    const row = updated[0];
    return row ? rowToRecord(row, this.transcriptEncryptionKeyBase64) : null;
  }

  async findByIdempotencyKey(
    accountId: string,
    idempotencyKey: string,
  ): Promise<AgentSessionRecord | null> {
    // v2-#19 — partial unique index `agent_sessions_idempotency_key_unique`
    // on (account_id, idempotency_key) means at most one row matches.
    const rows = await this.database.db
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.accountId, accountId),
          eq(agentSessions.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? rowToRecord(row, this.transcriptEncryptionKeyBase64) : null;
  }
}

/**
 * Erase agent sessions belonging to accounts terminated before `cutoff`.
 *
 * `agent_sessions.transcript` is the customer's agent conversation and
 * `gui_control_key_ciphertext` is a session credential. Nothing purged this
 * table on any schedule, so both were retained indefinitely after termination —
 * the same soft-delete-vs-CASCADE root cause behind the proxy-secret, profile
 * and turn-receipt arms.
 *
 * Cascade behaviour is deliberate and was checked against the live schema
 * rather than assumed: `agent_turn_receipts.agent_session_id` is ON DELETE
 * CASCADE, so a purged session takes its receipts with it, and
 * `recipes.agent_session_id` is ON DELETE SET NULL, so a customer's saved
 * recipes survive with the link cleared rather than being destroyed as a side
 * effect of an unrelated erasure. Nothing billing-related references this
 * table — usage records key off their own session id — so the 7-year billing
 * retention is untouched.
 *
 * Standalone and key-free for the same reason as the turn-receipt purge: the
 * repo class requires the transcript encryption key, a DELETE decrypts nothing,
 * and binding an erasure promise to an unrelated flag is the defect 2eeddefa7
 * already had to fix once.
 *
 * BOUNDED per tick on SESSION rows; the sweep is self-limiting because deleted
 * rows stop matching. The bound sits on a subselect because PostgreSQL's DELETE
 * takes no LIMIT.
 */
export async function purgeAgentSessionsForTerminatedAccountsBefore(
  database: Database,
  cutoff: Date,
  maxPerTick = 500,
): Promise<number> {
  const rows = await database.client<Array<{ id: string }>>`
    DELETE FROM agent_sessions
    WHERE id IN (
      SELECT s.id
      FROM agent_sessions s
      JOIN accounts a ON a.id = s.account_id
      WHERE a.status = 'deleted'
        AND a.deleted_at IS NOT NULL
        AND a.deleted_at < ${cutoff.toISOString()}::timestamptz
      LIMIT ${maxPerTick}
    )
    RETURNING id`;
  return rows.length;
}
