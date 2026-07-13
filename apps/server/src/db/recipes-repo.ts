// AI-B4 — Drizzle implementation of RecipesRepo (migration 0044).
// Production wires this; tests/dev use InMemoryRecipesRepo from
// services/recipes.ts.
//
// Key shape rules (matching the in-memory variant + migration 0044):
//   - text PK `rec_<uuid>` minted at create.
//   - jsonb intent_log + transcript_snapshot store versioned AES-GCM envelopes.
//     Legacy plaintext arrays remain readable and are converted by a bounded
//     compare-and-set bootstrap upgrader.
//   - Label trim + length + description length validation lives in
//     the service-layer `validateLabelAndDescription`; the DB CHECK
//     constraint is the belt-and-suspenders backstop for that.
//   - No update/delete surface in v1.0 — write-only per the
//     orchestrator handoff #3 Q.5.

import { randomUUID } from 'node:crypto';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { recipes } from './schema.js';
import {
  encryptAgentTranscript,
  isEncryptedAgentTranscript,
  readAgentTranscript,
} from '../services/agent-transcript-encryption.js';
import {
  encryptRecipeIntentLog,
  isEncryptedRecipeIntentLog,
  readRecipeIntentLog,
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

function rowToRecord(
  row: typeof recipes.$inferSelect,
  payloadEncryptionKeyBase64: string | undefined,
): RecipeRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    agentSessionId: row.agentSessionId,
    label: row.label,
    description: row.description,
    intentLog: readRecipeIntentLog(row.intentLog, payloadEncryptionKeyBase64),
    transcriptSnapshot: readAgentTranscript(row.transcriptSnapshot, payloadEncryptionKeyBase64),
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

  private async encryptLegacyRow(row: {
    id: string;
    intentLog: unknown;
    transcriptSnapshot: unknown;
  }): Promise<boolean> {
    const key = this.requireEncryptionKey();
    const intentLog = isEncryptedRecipeIntentLog(row.intentLog)
      ? row.intentLog
      : encryptRecipeIntentLog(readRecipeIntentLog(row.intentLog, key), key);
    const transcriptSnapshot = isEncryptedAgentTranscript(row.transcriptSnapshot)
      ? row.transcriptSnapshot
      : encryptAgentTranscript(readAgentTranscript(row.transcriptSnapshot, key), key);
    if (intentLog === row.intentLog && transcriptSnapshot === row.transcriptSnapshot) return false;

    // Both JSON snapshots must still match the selected bytes. Recipes are
    // insert-once, but this CAS also makes delete/legacy-upgrade races harmless
    // and prevents a future update surface from being clobbered.
    const updated = await this.database.db
      .update(recipes)
      .set({ intentLog, transcriptSnapshot })
      .where(
        and(
          eq(recipes.id, row.id),
          sql`${recipes.intentLog} = ${JSON.stringify(row.intentLog)}::jsonb`,
          sql`${recipes.transcriptSnapshot} = ${JSON.stringify(row.transcriptSnapshot)}::jsonb`,
        ),
      )
      .returning({ id: recipes.id });
    return updated.length === 1;
  }

  /**
   * Bounded legacy plaintext converter. The encrypted probe authenticates at
   * least one existing envelope before the app starts serving; a wrong key
   * therefore fails boot instead of making saved recipes unreadable later.
   */
  async encryptLegacyPayloads(limit = 500): Promise<{ scanned: number; converted: number }> {
    const key = this.requireEncryptionKey();
    const [encryptedProbe] = await this.database.db
      .select({
        intentLog: recipes.intentLog,
        transcriptSnapshot: recipes.transcriptSnapshot,
      })
      .from(recipes)
      .where(
        or(
          sql`jsonb_typeof(${recipes.intentLog}) = 'object'`,
          sql`jsonb_typeof(${recipes.transcriptSnapshot}) = 'object'`,
        ),
      )
      .limit(1);
    if (encryptedProbe !== undefined) {
      readRecipeIntentLog(encryptedProbe.intentLog, key);
      readAgentTranscript(encryptedProbe.transcriptSnapshot, key);
    }

    const rows = await this.database.db
      .select({
        id: recipes.id,
        intentLog: recipes.intentLog,
        transcriptSnapshot: recipes.transcriptSnapshot,
      })
      .from(recipes)
      .where(
        or(
          sql`jsonb_typeof(${recipes.intentLog}) = 'array'`,
          sql`jsonb_typeof(${recipes.transcriptSnapshot}) = 'array'`,
        ),
      )
      .limit(limit);
    let converted = 0;
    for (const row of rows) {
      if (await this.encryptLegacyRow(row)) converted += 1;
    }
    return { scanned: rows.length, converted };
  }

  async create(args: CreateRecipeArgs): Promise<RecipeRecord> {
    const key = this.requireEncryptionKey();
    const validated = validateLabelAndDescription(args.label, args.description);
    const id = `rec_${randomUUID()}`;
    const now = this.clock();
    const inserted = await this.database.db
      .insert(recipes)
      .values({
        id,
        accountId: args.accountId,
        agentSessionId: args.agentSessionId,
        label: validated.label,
        description: validated.description,
        intentLog: encryptRecipeIntentLog(args.intentLog, key),
        transcriptSnapshot: encryptAgentTranscript(args.transcriptSnapshot, key),
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
