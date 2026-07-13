// Drift guard for packages/sdk-typescript/src/resources/recipes.ts.
// Pins the AI-B4 write-only recipe library v1.0 narrow surface +
// the intent_log assembly rationale + the cross-account 404
// existence-leak-prevention contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/recipes.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('sdk-typescript resources/recipes content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("AI-B4 module-level framing pinned: 'recipe library. Snapshots a finished agent-session's intent_log + transcript so the customer can later replay the same flow without re-paying the LLM decomposition cost.' — pinned so the replay-without-re-paying-LLM-cost value-prop survives (drift to dropping the no-replay-cost framing would mislead customers about what recipes solve)", () => {
    expect(body).toMatch(
      /\/\/ AI-B4 — recipe library\. Snapshots a finished agent-session's\s*\n?\s*\/\/ intent_log \+ transcript so the customer can later replay the same\s*\n?\s*\/\/ flow without re-paying the LLM decomposition cost\./,
    );
  });

  it("surface framing pinned: 'SDK surface: create + list + get + delete' + 'The read/management path (list/get/delete) was pulled forward from the v1.1 D2/D3 defer (V-530.I/.J); recipe EXECUTION stays v1.1 (harness-executor-gated).' — pinned so the create+list+get+delete surface + the execution-stays-gated contract stay explicit (drift to adding an execute() would diverge from the server, which has no execution route)", () => {
    expect(body).toMatch(/\/\/ SDK surface: create \+ list \+ get \+ delete\./);
    expect(body).toMatch(
      /\/\/ \(list\/get\/delete\) was pulled forward from the v1\.1 D2\/D3 defer\s*\n?\s*\/\/ \(V-530\.I\/\.J\); recipe EXECUTION stays v1\.1 \(harness-executor-gated\)\./,
    );
  });

  it("503 activation-gate framing pinned: 'When the route is gated 503 (recipesRepo OR agentSessionsRepo not wired in the deploy's AppDeps), the SDK propagates the FeatureUnavailableError; callers branch on the typed error the same way they do for billing / egress / agent-sessions.' — pinned so the dual-repo gating contract + the cross-feature error-handling parallel stay explicit (drift would mislead consumers about which repos drive the 503; drift to dropping the cross-feature pattern reference would orphan the typed-error handling pattern from its peers)", () => {
    // Match the distinctive phrases rather than the exact line-wrap
    // (robust to prose re-wrapping).
    expect(body).toMatch(/When the route is gated 503 \(recipesRepo OR agentSessionsRepo/);
    expect(body).toMatch(/the SDK propagates the/);
    expect(body).toMatch(/FeatureUnavailableError; callers branch on the typed error/);
    expect(body).toMatch(/billing \/ egress \/ agent-sessions\./);
  });

  it("Recipe interface 8-field surface: id + account_id + agent_session_id (nullable) + label + description (nullable) + intent_count + created_at + updated_at. Drift to making agent_session_id NOT nullable would break the recipe-survives-agent-session-cleanup contract; drift to dropping intent_count would force the dashboard to fetch the full intent_log just to render 'N intents' summary", () => {
    expect(body).toMatch(/export interface Recipe \{/);
    expect(body).toMatch(/id: string;/);
    expect(body).toMatch(/account_id: string;/);
    expect(body).toMatch(/agent_session_id: string \| null;/);
    expect(body).toMatch(/label: string;/);
    expect(body).toMatch(/description: string \| null;/);
    expect(body).toMatch(/intent_count: number;/);
    expect(body).toMatch(/created_at: string;/);
    expect(body).toMatch(/updated_at: string;/);
  });

  it("agent_session_id NULLABLE-on-cleanup framing pinned: 'NULLABLE — the recipe survives agent-session cleanup; the underlying foreign key is ON DELETE SET NULL server-side.' — pinned so the FK ON-DELETE-SET-NULL contract stays documented (drift to NOT NULL would either break the cleanup cascade OR cause recipes to evaporate when their source session is purged)", () => {
    expect(body).toMatch(
      /\*\s+NULLABLE — the recipe survives agent-session cleanup; the\s*\n?\s*\*\s+underlying foreign key is ON DELETE SET NULL server-side\./,
    );
  });

  it("intent_count assembly-rationale framing pinned: 'Length of the recipe's stored intent log (server-assembled by flatMapping the source agent-session's transcript).' — pinned so the server-side-flatMap contract + the cross-turn intent concatenation rationale stay documented (drift to a different counting strategy would diverge from server's actual value)", () => {
    expect(body).toMatch(
      /Length of the recipe's stored intent log \(server-assembled\s*\n?\s*\*\s+by flatMapping the source agent-session's transcript\)\./,
    );
  });

  it('CreateRecipeRequest 3-field surface: agent_session_id (required) + label (1..120 chars after trim) + description (optional, ≤2000 chars). Drift to weakening label trim+length would let customers create unlistable empty-label recipes; drift to dropping the 2000-char cap on description would let recipes grow unbounded', () => {
    expect(body).toMatch(/export interface CreateRecipeRequest \{/);
    expect(body).toMatch(/agent_session_id: string;/);
    expect(body).toMatch(/Human-facing label, 1\.\.120 chars after trim\./);
    expect(body).toMatch(/Optional longer-form description, ≤2000 chars\./);
    expect(body).toMatch(/description\?: string;/);
  });

  it("cross-account 404 existence-leak-prevention framing pinned: 'Source agent_session id to snapshot. The session must belong to the caller's account; cross-account ids return 404 (server intentionally doesn't distinguish missing from forbidden to avoid existence leakage).' — pinned so the deliberately-vague 404 contract survives. Drift to a distinguishable 403 would leak whether a session id exists in another account — a privacy violation that the deliberate-404 design is meant to prevent", () => {
    expect(body).toMatch(
      /Source agent_session id to snapshot\. The session must\s*\n?\s*\*\s+belong to the caller's account; cross-account ids return\s*\n?\s*\*\s+404 \(server intentionally doesn't distinguish missing\s*\n?\s*\*\s+from forbidden to avoid existence leakage\)\./,
    );
  });

  it("RecipesResource create() flatMap-rationale framing pinned: 'server assembles intent_log by flatMapping the source agent-session's transcript — each plan-executed turn's structured intent array is concatenated in turn order. A recipe captured from a 3-turn session that ran 2 + 4 + 1 intents produces a 7-intent intent_log. Clarify / refuse turns contribute zero intents.' — pinned so the worked example (3-turn → 7-intent) + the clarify/refuse-contribute-zero contract stay documented (drift would diverge from server's actual flatMap behavior)", () => {
    expect(body).toMatch(
      /The server assembles intent_log by flatMapping the source\s*\n?\s*\*\s+agent-session's transcript — each plan-executed turn's\s*\n?\s*\*\s+structured intent array is concatenated in turn order\./,
    );
    expect(body).toMatch(
      /A\s*\n?\s*\*\s+recipe captured from a 3-turn session that ran 2 \+ 4 \+ 1\s*\n?\s*\*\s+intents produces a 7-intent intent_log\. Clarify \/ refuse\s*\n?\s*\*\s+turns contribute zero intents\./,
    );
  });

  it('RecipesResource method surface pinned: create + list + iterate + get + delete (read/management). EXECUTION is NOT present (no execute() — recipe execution stays gated on the harness executor; an execute() here would diverge from the server, which has no execution route).', () => {
    expect(body).toMatch(/export class RecipesResource \{/);
    expect(body).toMatch(/create\(body: CreateRecipeRequest\): Promise<Recipe>/);
    expect(body).toMatch(/list\(query: PaginationQueryInput = \{\}\): Promise<RecipesListPage>/);
    expect(body).toMatch(/get\(id: string\): Promise<RecipeDetail>/);
    expect(body).toMatch(/delete\(id: string\): Promise<void>/);
    expect(body).not.toMatch(/execute\(/);
  });

  it('RecipeDetail + RecipesListPage shapes and public sensitive-value omission contract pinned', () => {
    expect(body).toMatch(
      /The public recipe returned by get\(\) — adds the ordered intent_log to the\s*\n?\s*\*\s+list metadata\. Sensitive type steps retain `sensitive:true` and their\s*\n?\s*\*\s+selector but omit the optional value\./,
    );
    expect(body).toMatch(
      /export interface RecipeDetail extends Recipe \{\s*\n?\s*intent_log: AgentIntent\[\];/,
    );
    expect(body).toMatch(
      /export interface RecipesListPage \{\s*\n?\s*data: Recipe\[\];\s*\n?\s*has_more: boolean;\s*\n?\s*next_cursor: string \| null;/,
    );
  });

  it("POST /v1/recipes path constant pinned. Drift to a different path would break the route binding; the resource is collection-scoped (POST /v1/recipes, not /v1/agent-sessions/:id/recipes) because the agent_session_id is in the body (matches the V-205 'flat resource hierarchy' convention)", () => {
    expect(body).toMatch(/path: '\/v1\/recipes',/);
  });
});
