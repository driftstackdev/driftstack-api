// AI-B4 — Drizzle implementation of RecipesRepo (migration 0044).
// Production wires this; tests/dev use InMemoryRecipesRepo from
// services/recipes.ts.
//
// Key shape rules (matching the in-memory variant + migration 0044):
//   - text PK `rec_<uuid>` minted at create.
//   - jsonb intent_log + transcript_snapshot are atomic snapshots
//     (insert-once; never edited).
//   - Label trim + length + description length validation lives in
//     the service-layer `validateLabelAndDescription`; the DB CHECK
//     constraint is the belt-and-suspenders backstop for that.
//   - No update/delete surface in v1.0 — write-only per the
//     orchestrator handoff #3 Q.5.

import { randomUUID } from 'node:crypto';
import type { Database } from './client.js';
import { recipes } from './schema.js';
import type { AgentIntent, TranscriptEntry } from '../services/agent-decomposer.js';
import type { CreateRecipeArgs, RecipeRecord, RecipesRepo } from '../services/recipes.js';

function rowToRecord(row: typeof recipes.$inferSelect): RecipeRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    agentSessionId: row.agentSessionId,
    label: row.label,
    description: row.description,
    intentLog: (row.intentLog as ReadonlyArray<AgentIntent>) ?? [],
    transcriptSnapshot: (row.transcriptSnapshot as ReadonlyArray<TranscriptEntry>) ?? [],
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
  constructor(
    private readonly database: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async create(args: CreateRecipeArgs): Promise<RecipeRecord> {
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
        intentLog: args.intentLog,
        transcriptSnapshot: args.transcriptSnapshot,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      throw new Error('Recipe insert returned no rows');
    }
    return rowToRecord(row);
  }
}
