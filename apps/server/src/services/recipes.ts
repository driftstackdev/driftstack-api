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
import type { AccountTier } from '@driftstack/api-types';
import type { AgentIntent, TranscriptEntry } from './agent-decomposer.js';

/**
 * Security sweep #7 — how many recipes an account keeps, per plan.
 *
 * Every recipe stores its own encrypted copy of the source session's transcript
 * (up to 1 MiB, and ciphertext does not compress), so the count bounds the bytes
 * one account can put into the database: 10 on free is at most ~10 MiB. Paid
 * plans keep more, in rough proportion to their profile allowance.
 */
export const RECIPES_PER_TIER: Readonly<Record<AccountTier, number>> = {
  free: 10,
  solo_manual: 50,
  team_manual: 200,
  agency_manual: 500,
  api_starter: 100,
  api_builder: 500,
  api_scale: 1000,
  enterprise: 2000,
};

/** The recipe cap for a plan. Enforced by `RecipesRepo.createIfUnderLimit`, under a lock. */
export function recipeLimitFor(tier: AccountTier): number {
  return RECIPES_PER_TIER[tier];
}

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

/** What {@link RecipesRepo.createIfUnderLimit} decided. */
export type CreateRecipeOutcome =
  /** A new recipe was stored. */
  | { kind: 'created'; record: RecipeRecord }
  /** The same session, label and description were already saved: that recipe, unchanged. */
  | { kind: 'existing'; record: RecipeRecord }
  /** The session is already saved as `recipeId` under another label or description. */
  | { kind: 'session_already_saved'; recipeId: string }
  /** The account already holds `current` recipes, at or over the limit. */
  | { kind: 'limit_reached'; current: number };

export interface RecipesRepo {
  /**
   * Snapshot a recipe row, unconditionally. The repo mints a fresh id per insert
   * and enforces neither limit below — the customer route calls
   * {@link createIfUnderLimit}. Kept for fixtures and internal callers.
   */
  create(args: CreateRecipeArgs): Promise<RecipeRecord>;

  /**
   * Security sweep #7 — the customer save path. Under one per-account lock:
   *
   *   1. A source session is saved ONCE. If the account already has a recipe of
   *      `agentSessionId` with the same label and description, that recipe is the
   *      answer (`existing` — a retried save stores no second copy); with any other
   *      label or description, `session_already_saved`. A save with no source
   *      session (`agentSessionId: null`) is never deduplicated.
   *   2. At most `limit` recipes per account (`limit_reached`).
   *   3. Otherwise the recipe is stored (`created`).
   *
   * v1.0 allowed one session under several labels; each was a full transcript
   * copy, which is what let one session be saved 60 times into 19 MB.
   */
  createIfUnderLimit(args: CreateRecipeArgs & { limit: number }): Promise<CreateRecipeOutcome>;

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

  /**
   * Security sweep #7 — mirrors DrizzleRecipesRepo.createIfUnderLimit (the same
   * three rules, in the same order). Sequential, so it needs no lock; the Drizzle
   * method's lock is exercised against Postgres.
   */
  async createIfUnderLimit(
    args: CreateRecipeArgs & { limit: number },
  ): Promise<CreateRecipeOutcome> {
    const validated = validateLabelAndDescription(args.label, args.description);
    if (args.agentSessionId !== null) {
      const saved = [...this.rows.values()]
        .filter((r) => r.accountId === args.accountId && r.agentSessionId === args.agentSessionId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
      const same = saved.find(
        (r) => r.label === validated.label && r.description === validated.description,
      );
      if (same !== undefined) return { kind: 'existing', record: same };
      const first = saved[0];
      if (first !== undefined) return { kind: 'session_already_saved', recipeId: first.id };
    }
    const current = [...this.rows.values()].filter((r) => r.accountId === args.accountId).length;
    if (current >= args.limit) return { kind: 'limit_reached', current };
    return { kind: 'created', record: await this.create(args) };
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

export interface RecipeSuggestion {
  suggestedLabel: string;
  suggestedDescription: string;
}

/**
 * Doc-132 §5.2 (recipe auto-generation) — v1.0 slice. A real
 * cross-customer ML pipeline ("observes patterns, trains a model,
 * feeds published recipes back into training") is out of scope here:
 * it's a genuine customer-data-handling design (Tier 3 per the
 * project's decision-authority policy) that needs a founder call, not
 * a unilateral server-side build. This slice auto-derives a sensible label +
 * description from the CUSTOMER'S OWN intent_log (same data the
 * manual "Save recipe" flow already snapshots for them) so the save
 * dialog prefills something useful instead of a blank form — safe,
 * single-account, no data leaves the account, no training involved.
 *
 * Deterministic (not a model call): scans the ordered intents for the
 * first distinct navigate hostnames + counts interact actions, and
 * composes a short label + one-line description. Never throws —
 * empty/unrecognized logs fall back to a generic label so the caller
 * always gets a usable suggestion.
 */
export function suggestRecipeMetadata(intentLog: ReadonlyArray<AgentIntent>): RecipeSuggestion {
  const hosts: string[] = [];
  for (const intent of intentLog) {
    if (intent.kind !== 'navigate') continue;
    let host: string;
    try {
      host = new URL(intent.url).hostname.replace(/^www\./, '');
    } catch {
      continue; // malformed URL — skip rather than throw
    }
    if (hosts[hosts.length - 1] !== host) hosts.push(host);
  }
  const primaryHost = hosts[0];

  const typeCount = intentLog.filter((i) => i.kind === 'interact' && i.action === 'type').length;
  const tapCount = intentLog.filter((i) => i.kind === 'interact' && i.action === 'tap').length;
  const hasSubmit = intentLog.some((i) => i.kind === 'interact' && i.action === 'press');

  const label = primaryHost
    ? typeCount > 0
      ? `Fill form on ${primaryHost}`
      : `Automation on ${primaryHost}`
    : 'Untitled automation';

  const descriptionParts: string[] = [];
  if (primaryHost) descriptionParts.push(`Navigates to ${primaryHost}`);
  if (typeCount > 0) descriptionParts.push(`fills ${typeCount} field${typeCount === 1 ? '' : 's'}`);
  if (tapCount > 0) descriptionParts.push(`taps ${tapCount} element${tapCount === 1 ? '' : 's'}`);
  if (hasSubmit) descriptionParts.push('submits');
  const description =
    descriptionParts.length > 0
      ? `${descriptionParts.join(', ')}.`
      : `Replays ${intentLog.length} recorded step${intentLog.length === 1 ? '' : 's'}.`;

  return {
    suggestedLabel: label.slice(0, 120),
    suggestedDescription: description.slice(0, 2000),
  };
}
