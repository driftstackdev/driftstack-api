// AI-B4 — recipes persistence. A recipe is a snapshot of a finished
// agent_session's intent_log + transcript so the customer can replay
// the same flow later via the SDK without re-paying the LLM
// decomposition cost.
//
// Surface: create + list + getById + deleteById (the read/management
// path was pulled forward from the v1.1 D2/D3 defer — V-530.I/.J).
// Recipe EXECUTION stays v1.1 (gated on the harness-wired executor).
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

export interface ListRecipesArgs {
  accountId: string;
  /** Page size (default 50, max 100 — clamped by the repo). */
  limit?: number;
  /** Opaque cursor = the id of the last recipe on the prior page. */
  cursor?: string;
}

export interface ListRecipesPage {
  data: RecipeRecord[];
  hasMore: boolean;
  /** The id to pass as the next `cursor`, or null when the page is the last. */
  nextCursor: string | null;
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

  /**
   * V-530.I (D2) — list the account's recipes, newest first. Keyset
   * pagination on (createdAt DESC, id DESC), mirroring the prod-proven
   * profiles-repo so same-timestamp rows can't drop at a page boundary.
   * Read-path only; recipe EXECUTION stays gated on the harness executor.
   */
  list(args: ListRecipesArgs): Promise<ListRecipesPage>;

  /**
   * V-530.J (D2) — fetch one recipe, scoped to the account. Returns null
   * when missing OR owned by another account (existence is never leaked
   * cross-account — the route maps null → 404).
   */
  getById(args: { accountId: string; id: string }): Promise<RecipeRecord | null>;

  /**
   * V-530.J (D3) — delete one recipe, scoped to the account. Returns true
   * iff a row was deleted; false = missing or not owned (route → 404).
   */
  deleteById(args: { accountId: string; id: string }): Promise<boolean>;
}

const DEFAULT_RECIPE_PAGE = 50;
const MAX_RECIPE_PAGE = 100;

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

  // eslint-disable-next-line @typescript-eslint/require-await
  async list(args: ListRecipesArgs): Promise<ListRecipesPage> {
    const limit = Math.min(args.limit ?? DEFAULT_RECIPE_PAGE, MAX_RECIPE_PAGE);
    // (createdAt DESC, id DESC) — same total order as the Drizzle keyset.
    let rows = [...this.rows.values()]
      .filter((r) => r.accountId === args.accountId)
      .sort((a, b) => {
        const t = b.createdAt.getTime() - a.createdAt.getTime();
        if (t !== 0) return t;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });

    if (args.cursor !== undefined) {
      const cur = this.rows.get(args.cursor);
      if (cur !== undefined && cur.accountId === args.accountId) {
        const curT = cur.createdAt.getTime();
        rows = rows.filter(
          (r) => r.createdAt.getTime() < curT || (r.createdAt.getTime() === curT && r.id < cur.id),
        );
      }
    }

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit);
    const nextCursor =
      hasMore && data.length > 0 ? (data[data.length - 1] as RecipeRecord).id : null;
    return { data, hasMore, nextCursor };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getById(args: { accountId: string; id: string }): Promise<RecipeRecord | null> {
    const row = this.rows.get(args.id);
    return row !== undefined && row.accountId === args.accountId ? row : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteById(args: { accountId: string; id: string }): Promise<boolean> {
    const row = this.rows.get(args.id);
    if (row === undefined || row.accountId !== args.accountId) return false;
    this.rows.delete(args.id);
    return true;
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
