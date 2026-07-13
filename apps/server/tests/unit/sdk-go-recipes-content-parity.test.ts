// Drift guard for packages/sdk-go/recipes.go.
// Pins the AI-B4 write-only Go surface — mirrors TS + Python.
// Load-bearing pieces: the v1.0 narrow surface (Create only), the
// cross-account 404 existence-leak-prevention contract, and the
// Recipe Go struct nullable-field pointer pattern.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/recipes.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('sdk-go recipes content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Module-level RecipesResource framing pinned: 'RecipesResource handles /v1/recipes (AI-B4). Mirrors the TypeScript + Python RecipesResource.' — pinned so the AI-B4 anchor + cross-SDK TS + Python mirror references survive (drift would orphan the Go SDK from its peers)", () => {
    expect(body).toMatch(
      /\/\/ RecipesResource handles \/v1\/recipes \(AI-B4\)\. Mirrors the TypeScript\s*\n?\s*\/\/ \+ Python RecipesResource\./,
    );
  });

  it("503 activation-gate dual-repo framing pinned: 'Server registers these endpoints as 503 FeatureUnavailable stubs until both recipesRepo and agentSessionsRepo are wired in AppDeps. SDK surface is stable so consumers compile ahead of time.' — pinned so the dual-repo (recipesRepo + agentSessionsRepo) AND-gate stays documented (drift to a single-repo gate would mismatch the server's actual activation logic)", () => {
    expect(body).toMatch(
      /\/\/ Server registers these endpoints as 503 FeatureUnavailable stubs\s*\n?\s*\/\/ until both recipesRepo and agentSessionsRepo are wired in AppDeps\.\s*\n?\s*\/\/ SDK surface is stable so consumers compile ahead of time\./,
    );
  });

  it("surface framing pinned: 'Surface: Create + List + Get + Delete (the read/management path was pulled forward from the v1.1 D2/D3 defer — V-530.I/.J). Recipe EXECUTION stays v1.1 (gated on the harness executor).' — pinned so the Create+List+Get+Delete surface + the execution-stays-gated contract stay explicit (drift to adding an Execute would diverge from the server, which has no execution route)", () => {
    expect(body).toMatch(/\/\/ Surface: Create \+ List \+ Get \+ Delete/);
    expect(body).toMatch(/\/\/ EXECUTION stays v1\.1 \(gated on the harness executor\)\./);
  });

  it('Recipe Go struct 8-field surface: ID + AccountID + AgentSessionID (*string nullable) + Label + Description (*string nullable) + IntentCount + CreatedAt + UpdatedAt. Drift to making AgentSessionID non-pointer would break the ON DELETE SET NULL cleanup contract; drift to dropping IntentCount would force Go customers to fetch the full intent_log just for a count', () => {
    expect(body).toMatch(/type Recipe struct \{/);
    expect(body).toMatch(/ID\s+string\s+`json:"id"`/);
    expect(body).toMatch(/AccountID\s+string\s+`json:"account_id"`/);
    expect(body).toMatch(/AgentSessionID\s+\*string\s+`json:"agent_session_id"`/);
    expect(body).toMatch(/Label\s+string\s+`json:"label"`/);
    expect(body).toMatch(/Description\s+\*string\s+`json:"description"`/);
    expect(body).toMatch(/IntentCount\s+int\s+`json:"intent_count"`/);
    expect(body).toMatch(/CreatedAt\s+string\s+`json:"created_at"`/);
    expect(body).toMatch(/UpdatedAt\s+string\s+`json:"updated_at"`/);
  });

  it('CreateRecipeRequest 3-field surface: AgentSessionID (required) + Label (required) + Description (omitempty string, not pointer — the wire shape is just absent vs. present; null-vs-absent equivalence is fine for this request body unlike the response shape where the server may emit null). Drift to making Description *string would diverge from the cross-SDK pattern', () => {
    expect(body).toMatch(
      /type CreateRecipeRequest struct \{\s*\n?\s*AgentSessionID string `json:"agent_session_id"`\s*\n?\s*Label\s+string `json:"label"`\s*\n?\s*Description\s+string `json:"description,omitempty"`\s*\n?\s*\}/,
    );
  });

  it("Create() cross-account 404 existence-leak-prevention framing pinned: 'Cross-account access on AgentSessionID returns 404 (not 403) — the server intentionally doesn't distinguish missing from forbidden to avoid existence leakage.' — pinned so the deliberate-404 privacy contract is explicit on the Go side. Drift to documenting 403 would mislead Go consumers about server behavior + leak the privacy-contract rationale to callers", () => {
    expect(body).toMatch(
      /\/\/ Cross-account access on AgentSessionID returns 404 \(not 403\) — the\s*\n?\s*\/\/ server intentionally doesn't distinguish missing from forbidden to\s*\n?\s*\/\/ avoid existence leakage\./,
    );
  });

  it("Create() signature pinned: 'Create(ctx context.Context, body CreateRecipeRequest) (*Recipe, error)' — pinned so the context-first idiom + value-receiver-CreateRecipeRequest body stays uniform with Go's standard library conventions. Drift would break Go consumers using ctx-cancellation", () => {
    expect(body).toMatch(
      /func \(r \*RecipesResource\) Create\(ctx context\.Context, body CreateRecipeRequest\) \(\*Recipe, error\)/,
    );
  });

  it('RecipesResource method surface pinned: Create + List + Iterate + Get + Delete (read/management). No Execute — recipe execution stays gated on the harness executor (an Execute here would diverge from the server, which has no execution route)', () => {
    expect(body).toMatch(/type RecipesResource struct \{/);
    expect(body).toMatch(
      /func \(r \*RecipesResource\) List\(ctx context\.Context, query \*ListRecipesQuery\) \(\*RecipesListPage, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*RecipesResource\) Get\(ctx context\.Context, recipeID string\) \(\*RecipeDetail, error\)/,
    );
    expect(body).toMatch(
      /func \(r \*RecipesResource\) Delete\(ctx context\.Context, recipeID string\) error/,
    );
    expect(body).not.toMatch(/func \(r \*RecipesResource\) Execute\(/);
  });

  it('RecipeDetail + RecipesListPage shapes and public sensitive-value omission contract pinned', () => {
    expect(body).toMatch(
      /\/\/ RecipeDetail is the public recipe returned by Get\. It embeds the list\s*\n?\s*\/\/ metadata and adds the ordered IntentLog\. Sensitive type steps retain their\s*\n?\s*\/\/ selector and sensitive marker but omit the optional value; exact replay\s*\n?\s*\/\/ values stay encrypted server-side\./,
    );
    expect(body).toMatch(
      /type RecipeDetail struct \{\s+Recipe\s+IntentLog\s+\[\]json\.RawMessage\s+`json:"intent_log"`/,
    );
    expect(body).toMatch(
      /type RecipesListPage struct \{\s+Data\s+\[\]Recipe\s+`json:"data"`\s+HasMore\s+bool\s+`json:"has_more"`\s+NextCursor\s+\*string\s+`json:"next_cursor"`/,
    );
  });

  it('POST /v1/recipes path constant pinned. Drift to a different path would break the route binding; the resource is collection-scoped because the agent_session_id is in the body (matches the V-205 flat-resource-hierarchy convention)', () => {
    expect(body).toMatch(/path:\s+"\/v1\/recipes",/);
  });
});
