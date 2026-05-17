// AI-B4 — write-only recipe library. Snapshots a finished
// agent-session's intent_log + transcript so the customer can
// later replay the same flow without re-paying the LLM
// decomposition cost.
//
// V1.0 SDK surface is intentionally narrow:
//   - create() — POST /v1/recipes
//
// Read / list / execute / delete surfaces are v1.1 D2/D3 scope.
// When the route is gated 503 (recipesRepo OR agentSessionsRepo
// not wired in the deploy's AppDeps), the SDK propagates the
// FeatureUnavailableError; callers branch on the typed error
// the same way they do for billing / egress / agent-sessions.

import type { HttpClient } from '../http.js';

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
}
