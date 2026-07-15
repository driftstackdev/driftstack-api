// Recipe library. Snapshots a finished agent session's intent log and
// transcript so the customer can reuse the saved workflow without paying
// for another AI decomposition.
//
// Surface: create + list + iterate + get + delete + suggest. Deployments
// without recipe storage return FeatureUnavailableError. Recipe execution is
// intentionally outside this resource and is not exposed here.

import type { PaginationQueryInput } from '@driftstack/api-types';
import type { HttpClient } from '../http.js';
import { iteratePaginated } from '../pagination.js';
import type { AgentIntent } from './agent-sessions.js';

export interface Recipe {
  /** `rec_<uuid>` minted by the server. */
  id: string;
  account_id: string;
  /** Source agent_session this recipe was snapshotted from.
   *  NULLABLE — the recipe survives agent-session cleanup; the
   *  underlying foreign key is ON DELETE SET NULL server-side. */
  agent_session_id: string | null;
  label: string;
  description: string | null;
  /** Length of the recipe's stored intent log (server-assembled
   *  by flatMapping the source agent-session's transcript). */
  intent_count: number;
  created_at: string;
  updated_at: string;
}

/** The public recipe returned by get() — adds the ordered intent_log to the
 *  list metadata. Sensitive type steps retain `sensitive:true` and their
 *  selector but omit the optional value. (list() items omit the entire log.) */
export interface RecipeDetail extends Recipe {
  intent_log: AgentIntent[];
}

export interface RecipesListPage {
  data: Recipe[];
  has_more: boolean;
  next_cursor: string | null;
}

/** A deterministic label/description suggestion derived from a session's own
 *  intent_log (the same assembly `create()` uses), so callers can prefill a
 *  "Save as recipe" form before the customer decides to save. */
export interface RecipeSuggestion {
  suggested_label: string;
  suggested_description: string;
  /** Length of the flattened intent_log the suggestion was derived from. */
  intent_count: number;
}

export interface CreateRecipeRequest {
  /** Source agent_session id to snapshot. The session must
   *  belong to the caller's account; cross-account ids return
   *  404 (server intentionally doesn't distinguish missing
   *  from forbidden to avoid existence leakage). */
  agent_session_id: string;
  /** Human-facing label, 1..120 chars after trim. */
  label: string;
  /** Optional longer-form description, ≤2000 chars. */
  description?: string;
}

export class RecipesResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Snapshot the agent-session's intent_log + transcript into a
   * new recipe row. Returns the inserted Recipe.
   *
   * The server assembles intent_log by flatMapping the source
   * agent-session's transcript — each plan-executed turn's
   * structured intent array is concatenated in turn order. A
   * recipe captured from a 3-turn session that ran 2 + 4 + 1
   * intents produces a 7-intent intent_log. Clarify / refuse
   * turns contribute zero intents.
   */
  create(body: CreateRecipeRequest): Promise<Recipe> {
    return this.http.request<Recipe>({
      method: 'POST',
      path: '/v1/recipes',
      body,
    });
  }

  /** List the calling account's recipes, newest first. Cursor-paginated. */
  list(query: PaginationQueryInput = {}): Promise<RecipesListPage> {
    return this.http.request<RecipesListPage>({
      method: 'GET',
      path: '/v1/recipes',
      query: {
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      },
    });
  }

  /**
   * Lazily iterate every recipe for the calling account, walking
   * cursor pages automatically. See `iteratePaginated` for semantics.
   */
  iterate(opts: { limit?: number } = {}): AsyncGenerator<Recipe, void, void> {
    return iteratePaginated<Recipe>((cursor) =>
      this.list({
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(cursor !== null ? { cursor } : {}),
      }),
    );
  }

  /** Get one recipe with its public intent_log. Sensitive type values are omitted. */
  get(id: string): Promise<RecipeDetail> {
    return this.http.request<RecipeDetail>({
      method: 'GET',
      path: `/v1/recipes/${encodeURIComponent(id)}`,
    });
  }

  /** Delete a recipe. 404 if missing or owned by another account. */
  delete(id: string): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: `/v1/recipes/${encodeURIComponent(id)}`,
    });
  }

  /**
   * Fetch a deterministic label/description suggestion for an agent session,
   * derived from its own intent_log. Safe to call speculatively before the
   * customer decides to save (read-only, no side effects).
   */
  suggest(agentSessionId: string): Promise<RecipeSuggestion> {
    return this.http.request<RecipeSuggestion>({
      method: 'GET',
      path: `/v1/agent-sessions/${encodeURIComponent(agentSessionId)}/recipe-suggestion`,
    });
  }
}
