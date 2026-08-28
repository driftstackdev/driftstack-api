// AI-B4 — Drizzle implementation of RecipesRepo (migration 0044).
// Production wires this; tests/dev use InMemoryRecipesRepo from
// services/recipes.ts.
//
// Key shape rules (matching the in-memory variant + migration 0044):
//   - text PK `rec_<uuid>` minted at create.
//   - jsonb intent_log + transcript_snapshot store versioned AES-GCM envelopes.
//     Legacy plaintext arrays and context-free v1 envelopes are readable only
//     by a bounded compare-and-set bootstrap upgrader.
//   - Label trim + length + description length validation lives in
//     the service-layer `validateLabelAndDescription`; the DB CHECK
//     constraint is the belt-and-suspenders backstop for that.
//   - No UPDATE surface. There IS a delete: `deleteById` backs
//     `DELETE /v1/recipes/:id`, which is registered, `write`-scoped,
//     returns 204, and is published in the OpenAPI document.
//
// ⛔ This line used to deny that any delete surface existed and cited the
// orchestrator handoff that deferred one. Deliberately PARAPHRASED rather than
// quoted: the parity pin below asserts the stale sentence is ABSENT, and
// reproducing it here would satisfy that pin from inside the retraction.
// The write-only posture was real when this file was written and was
// REVERSED: routes/recipes.ts records the
// read/management path (list/get/delete) being pulled forward out of the
// v1.1 defer as V-530.I/.J, and its own header has said so since. One file
// kept recording a decision another file records as overturned.
//
// ⚠️ Worth stating because it cost something measurable: a reader who
// believes there is no delete surface does not go looking for the account
// scoping on it. `deleteById` scopes on (id, accountId), and when the
// ownership mutation sweep reached this file the delete predicate turned out
// to be covered — but by `db-account-scoped-deletes-tenant-scope-drizzle`,
// which was written against the route, not against this header's claim.

import { verifyBootEncryptionKey } from '../lib/boot-key-verification.js';
import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from './client.js';
import { recipes } from './schema.js';
import {
  convertRecipeIntentLogToV2,
  convertRecipeTranscriptSnapshotToV2,
  encryptRecipeIntentLog,
  encryptRecipeTranscriptSnapshot,
  readRecipeIntentLog,
  readRecipeTranscriptSnapshot,
  RECIPE_INTENT_LOG_ENVELOPE_KIND,
  RECIPE_TRANSCRIPT_SNAPSHOT_ENVELOPE_KIND,
} from '../services/recipe-payload-encryption.js';
import type {
  CreateRecipeArgs,
  ListRecipesArgs,
  ListRecipesPage,
  RecipeRecord,
  RecipesRepo,
} from '../services/recipes.js';

const DEFAULT_RECIPE_PAGE = 50;
const MAX_RECIPE_PAGE = 100;
const MAX_RECIPE_PAYLOAD_MIGRATION_BATCH = 500;

function recipePayloadsAreV2(): SQL {
  return sql`(
    (${recipes.intentLog}->>'kind') IS NOT DISTINCT FROM ${RECIPE_INTENT_LOG_ENVELOPE_KIND}
    AND (${recipes.intentLog}->>'version') IS NOT DISTINCT FROM '2'
    AND (${recipes.transcriptSnapshot}->>'kind') IS NOT DISTINCT FROM ${RECIPE_TRANSCRIPT_SNAPSHOT_ENVELOPE_KIND}
    AND (${recipes.transcriptSnapshot}->>'version') IS NOT DISTINCT FROM '2'
  )`;
}

function recipePayloadsAreNotV2(): SQL {
  return sql`NOT (${recipePayloadsAreV2()})`;
}

function rowToRecord(
  row: typeof recipes.$inferSelect,
  payloadEncryptionKeyBase64: string | undefined,
): RecipeRecord {
  const context = { accountId: row.accountId, recipeId: row.id };
  return {
    id: row.id,
    accountId: row.accountId,
    agentSessionId: row.agentSessionId,
    label: row.label,
    description: row.description,
    intentLog: readRecipeIntentLog(row.intentLog, payloadEncryptionKeyBase64, context),
    transcriptSnapshot: readRecipeTranscriptSnapshot(
      row.transcriptSnapshot,
      payloadEncryptionKeyBase64,
      context,
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function validateLabelAndDescription(
  label: string,
  description: string | undefined,
): { label: string; description: string | null } {
  const trimmedLabel = label.trim();
  if (trimmedLabel.length < 1 || trimmedLabel.length > 120) {
    throw new Error('Recipe label must be 1-120 characters after trim');
  }
  if (description !== undefined && description.length > 2000) {
    throw new Error('Recipe description must be <= 2000 characters');
  }
  return {
    label: trimmedLabel,
    description: description === undefined || description === '' ? null : description,
  };
}

export class DrizzleRecipesRepo implements RecipesRepo {
  private readonly clock: () => Date;
  private readonly payloadEncryptionKeyBase64: string | undefined;

  constructor(
    private readonly database: Database,
    options: {
      payloadEncryptionKeyBase64?: string;
      clock?: () => Date;
    } = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.payloadEncryptionKeyBase64 = options.payloadEncryptionKeyBase64;
  }

  private requireEncryptionKey(): string {
    if (this.payloadEncryptionKeyBase64 === undefined) {
      throw new Error('Recipe payload encryption key is unavailable.');
    }
    return this.payloadEncryptionKeyBase64;
  }

  /**
   * Bootstrap-only no-DDL conversion from plaintext/context-free v1 JSONB to
   * purpose/account/recipe/slot-bound v2. Every selected page authenticates and
   * validates completely before its first exact-CAS maintenance write.
   */
  async migratePayloadEnvelopes(
    limit = MAX_RECIPE_PAYLOAD_MIGRATION_BATCH,
  ): Promise<{ scanned: number; converted: number; remaining: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECIPE_PAYLOAD_MIGRATION_BATCH) {
      throw new Error(
        `Recipe payload migration limit must be an integer from 1 to ${MAX_RECIPE_PAYLOAD_MIGRATION_BATCH.toString()}.`,
      );
    }
    const key = this.requireEncryptionKey();

    // Authenticate one already-bound payload tuple even after legacy rows have
    // drained. A wrong operator key therefore fails every successor boot.
    const [v2Probe] = await this.database.db
      .select({
        id: recipes.id,
        accountId: recipes.accountId,
        intentLog: recipes.intentLog,
        transcriptSnapshot: recipes.transcriptSnapshot,
      })
      .from(recipes)
      .where(recipePayloadsAreV2())
      .orderBy(asc(recipes.id))
      .limit(1);
    if (v2Probe !== undefined) {
      const context = { accountId: v2Probe.accountId, recipeId: v2Probe.id };
      verifyBootEncryptionKey('Recipe payloads', 'MFA_ENCRYPTION_KEY', () => {
        readRecipeIntentLog(v2Probe.intentLog, key, context);
        readRecipeTranscriptSnapshot(v2Probe.transcriptSnapshot, key, context);
      });
    }

    const rows = await this.database.db
      .select({
        id: recipes.id,
        accountId: recipes.accountId,
        intentLog: recipes.intentLog,
        transcriptSnapshot: recipes.transcriptSnapshot,
      })
      .from(recipes)
      .where(recipePayloadsAreNotV2())
      // Context-free encrypted objects authenticate before plaintext arrays;
      // immutable recipe identity then makes page selection deterministic.
      .orderBy(
        sql`CASE WHEN jsonb_typeof(${recipes.intentLog}) = 'object'
          OR jsonb_typeof(${recipes.transcriptSnapshot}) = 'object' THEN 0 ELSE 1 END`,
        asc(recipes.id),
      )
      .limit(limit);

    const prepared = rows.map((row) => {
      const context = { accountId: row.accountId, recipeId: row.id };
      return {
        row,
        intentLog: convertRecipeIntentLogToV2(row.intentLog, key, context),
        transcriptSnapshot: convertRecipeTranscriptSnapshotToV2(
          row.transcriptSnapshot,
          key,
          context,
        ),
      };
    });

    let converted = 0;
    for (const { row, intentLog, transcriptSnapshot } of prepared) {
      const updated = await this.database.db
        .update(recipes)
        .set({ intentLog, transcriptSnapshot })
        .where(
          and(
            eq(recipes.id, row.id),
            eq(recipes.accountId, row.accountId),
            sql`${recipes.intentLog} IS NOT DISTINCT FROM ${JSON.stringify(row.intentLog)}::jsonb`,
            sql`${recipes.transcriptSnapshot} IS NOT DISTINCT FROM ${JSON.stringify(row.transcriptSnapshot)}::jsonb`,
          ),
        )
        .returning({ id: recipes.id });
      if (updated.length === 1) converted += 1;
    }

    const [remainingRow] = await this.database.db
      .select({ value: count() })
      .from(recipes)
      .where(recipePayloadsAreNotV2());
    return { scanned: rows.length, converted, remaining: remainingRow?.value ?? 0 };
  }

  async create(args: CreateRecipeArgs): Promise<RecipeRecord> {
    const key = this.requireEncryptionKey();
    const validated = validateLabelAndDescription(args.label, args.description);
    const id = `rec_${randomUUID()}`;
    const context = { accountId: args.accountId, recipeId: id };
    const now = this.clock();
    const inserted = await this.database.db
      .insert(recipes)
      .values({
        id,
        accountId: args.accountId,
        agentSessionId: args.agentSessionId,
        label: validated.label,
        description: validated.description,
        intentLog: encryptRecipeIntentLog(args.intentLog, key, context),
        transcriptSnapshot: encryptRecipeTranscriptSnapshot(args.transcriptSnapshot, key, context),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      throw new Error('Recipe insert returned no rows');
    }
    return rowToRecord(row, key);
  }

  async list(args: ListRecipesArgs): Promise<ListRecipesPage> {
    const limit = Math.min(args.limit ?? DEFAULT_RECIPE_PAGE, MAX_RECIPE_PAGE);

    // Keyset on (createdAt DESC, id DESC). Resolve the cursor row first
    // (scoped to the account) so a forged/foreign cursor can't leak rows.
    let cursorWhere;
    if (args.cursor !== undefined) {
      const [cursorRow] = await this.database.db
        .select({ createdAt: recipes.createdAt, id: recipes.id })
        .from(recipes)
        .where(and(eq(recipes.id, args.cursor), eq(recipes.accountId, args.accountId)))
        .limit(1);
      if (cursorRow !== undefined) {
        cursorWhere = or(
          lt(recipes.createdAt, cursorRow.createdAt),
          and(eq(recipes.createdAt, cursorRow.createdAt), lt(recipes.id, cursorRow.id)),
        );
      }
    }

    const rows = await this.database.db
      .select()
      .from(recipes)
      .where(
        cursorWhere !== undefined
          ? and(eq(recipes.accountId, args.accountId), cursorWhere)
          : eq(recipes.accountId, args.accountId),
      )
      .orderBy(desc(recipes.createdAt), desc(recipes.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const data = rows
      .slice(0, limit)
      .map((row) => rowToRecord(row, this.payloadEncryptionKeyBase64));
    const nextCursor =
      hasMore && data.length > 0 ? (data[data.length - 1] as RecipeRecord).id : null;
    return { data, hasMore, nextCursor };
  }

  async getById(args: { accountId: string; id: string }): Promise<RecipeRecord | null> {
    const [row] = await this.database.db
      .select()
      .from(recipes)
      .where(and(eq(recipes.id, args.id), eq(recipes.accountId, args.accountId)))
      .limit(1);
    return row ? rowToRecord(row, this.payloadEncryptionKeyBase64) : null;
  }

  async deleteById(args: { accountId: string; id: string }): Promise<boolean> {
    const deleted = await this.database.db
      .delete(recipes)
      .where(and(eq(recipes.id, args.id), eq(recipes.accountId, args.accountId)))
      .returning({ id: recipes.id });
    return deleted.length > 0;
  }
}

/**
 * V-1607 — erase the recipes of accounts terminated before `cutoff` (GDPR
 * Art. 17). Mirrors `purgeAgentSessionsForTerminatedAccountsBefore` exactly,
 * including its per-tick bound and its `RETURNING id` count.
 *
 * ⛔ This gap HID, which is why it lasted. The account-deletion sweeper already
 * hard-deletes `agent_sessions`, and that arm's own docstring names `transcript`
 * as the customer's agent conversation — so erasure looked complete. But
 * `recipes.agent_session_id` is `ON DELETE SET NULL` *specifically so a recipe
 * survives agent-session cleanup* (schema.ts:2467-2469). Deleting the sessions
 * therefore left the recipes behind with their `intent_log` and
 * `transcript_snapshot` intact — and those hold the same `AgentIntentSchema`
 * navigate members, whose `url` is `z.string()`, unconstrained: full URLs with
 * path and query. The deliberate survival is correct for a LIVE account and
 * exactly wrong for a terminated one.
 *
 * Hard delete rather than emptying the jsonb, matching the sibling arms: the
 * account is terminated, so there is no one the recipe can still serve, and
 * nothing billing-related references this table (unlike `sessions`, whose
 * `usage_records` force the anonymise-instead-of-delete approach §9 authorises).
 *
 * The only other delete over this table is the customer-initiated
 * `deleteById` — nothing purged it on any schedule.
 */
export async function purgeRecipesForTerminatedAccountsBefore(
  database: Database,
  cutoff: Date,
  maxPerTick = 500,
): Promise<number> {
  const rows = await database.client<Array<{ id: string }>>`
    DELETE FROM recipes
    WHERE id IN (
      SELECT r.id
      FROM recipes r
      JOIN accounts a ON a.id = r.account_id
      WHERE a.status = 'deleted'
        AND a.deleted_at IS NOT NULL
        AND a.deleted_at < ${cutoff.toISOString()}::timestamptz
      LIMIT ${maxPerTick}
    )
    RETURNING id`;
  return rows.length;
}
