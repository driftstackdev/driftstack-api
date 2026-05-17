// AI-B4 — recipes persistence (write-only at v1.0). A recipe is a
// snapshot of a finished agent_session's intent_log + transcript so
// the customer can replay the same flow later via the SDK without
// re-paying the LLM decomposition cost.
//
// V1.0 scope is intentionally narrow — POST /v1/recipes only. The
// read / list / execute / delete surfaces are v1.1 D2/D3.
//
// Migration: 0044_recipes.sql. Schema follows the same text-PK +
// jsonb-payload pattern as agent_sessions.

import { randomUUID } from 'node:crypto';
import type { AgentIntent, TranscriptEntry } from './agent-decomposer.js';

export interface RecipeRecord {
  /** `rec_<uuid>` id; minted by the repo on create. */
  id: string;
  accountId: string;
  /**
   * Source agent-session this recipe was snapshotted from. NULLABLE
   * because agent sessions may be deleted later but the recipe
   * row survives — ON DELETE SET NULL preserves the recipe while
   * dropping the dangling reference.
   */
  agentSessionId: string | null;
  label: string;
  description: string | null;
  /**
   * Captured plan — the ordered AgentIntent sequence the agent
   * executed. The replay path (v1.1) iterates this in order.
   */
  intentLog: ReadonlyArray<AgentIntent>;
  /**
   * Captured transcript at snapshot time — useful context for "what
   * did I ask?" when the customer revisits the recipe months later.
   */
  transcriptSnapshot: ReadonlyArray<TranscriptEntry>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRecipeArgs {
  accountId: string;
  /** Source agent session id; the service reads its transcript +
   *  intent log at snapshot time. Pass NULL when the customer
   *  composes a recipe out of band (not the v1.0 path; the route
   *  layer always passes a real id). */
  agentSessionId: string | null;
  label: string;
  description?: string;
  intentLog: ReadonlyArray<AgentIntent>;
  transcriptSnapshot: ReadonlyArray<TranscriptEntry>;
}

export interface RecipesRepo {
  /**
   * Snapshot a recipe row. MUST be idempotent on (accountId,
   * agentSessionId, label) if the same combination is sent twice —
   * v1.0 chooses NOT to enforce uniqueness so customers can save
   * the same agent-session under multiple labels (e.g. "smoke test"
   * + "regression test #4" for the same underlying flow). The repo
   * mints a fresh id per insert.
   */
  create(args: CreateRecipeArgs): Promise<RecipeRecord>;
}

/**
 * In-memory implementation for unit tests + the disabled-routes
 * activation-gate stub (kept symmetric with AgentSessionsRepo).
 */
export class InMemoryRecipesRepo implements RecipesRepo {
  private readonly rows = new Map<string, RecipeRecord>();

  constructor(private readonly nowFn: () => Date = () => new Date()) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async create(args: CreateRecipeArgs): Promise<RecipeRecord> {
    const now = this.nowFn();
    const id = `rec_inmem_${randomUUID()}`;
    const validated = validateLabelAndDescription(args.label, args.description);
    const record: RecipeRecord = {
      id,
      accountId: args.accountId,
      agentSessionId: args.agentSessionId,
      label: validated.label,
      description: validated.description,
      intentLog: [...args.intentLog],
      transcriptSnapshot: [...args.transcriptSnapshot],
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, record);
    return record;
  }
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
