// Drift guard for packages/sdk-typescript/src/resources/recipes.ts.
// Pins the public saved-recipe management and suggestion surface +
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

  it('frames recipes around reusable saved workflows without roadmap language', () => {
    expect(body).toMatch(
      /\/\/ Recipe library\. Snapshots a finished agent session's intent log and\s*\n?\s*\/\/ transcript so the customer can reuse the saved workflow without paying\s*\n?\s*\/\/ for another AI decomposition\./,
    );
    expect(body).toMatch(
      /\/\/ Surface: create \+ list \+ iterate \+ get \+ delete \+ suggest\. Deployments\s*\n?\s*\/\/ without recipe storage return FeatureUnavailableError\./,
    );
  });

  it('keeps roadmap and internal dependency language out of the public SDK', () => {
    expect(body).not.toMatch(
      /AI-B4|Doc-132|v1\.1|D2\/D3|V-530|defer|compile ahead|wired in AppDeps|harness-executor-gated/i,
    );
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

  it('RecipesResource method surface pinned: create + list + iterate + get + delete + suggest. Execution is outside this resource.', () => {
    expect(body).toMatch(/export class RecipesResource \{/);
    expect(body).toMatch(/create\(body: CreateRecipeRequest\): Promise<Recipe>/);
    expect(body).toMatch(/list\(query: PaginationQueryInput = \{\}\): Promise<RecipesListPage>/);
    expect(body).toMatch(/get\(id: string\): Promise<RecipeDetail>/);
    expect(body).toMatch(/delete\(id: string\): Promise<void>/);
    expect(body).toMatch(/suggest\(agentSessionId: string\): Promise<RecipeSuggestion>/);
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
