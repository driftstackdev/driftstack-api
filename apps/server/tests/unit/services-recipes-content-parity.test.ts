// Drift guard for apps/server/src/services/recipes.ts. Pins the AI-B4
// recipes persistence surface — RecipeRecord shape + RecipesRepo
// interface + InMemoryRecipesRepo helper + validateLabelAndDescription
// invariants. Cross-source pin against the v1.0 narrow scope
// (POST /v1/recipes only).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/recipes.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/recipes content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('AI-B4 module-level framing pinned: recipes persistence + the replay-without-re-paying-LLM-cost value-prop (the AI-B4 anchor stays explicit; drift to dropping the value-prop would orphan the recipe surface from its motivation)', () => {
    expect(body).toMatch(
      /\/\/ AI-B4 — recipes persistence\. A recipe is a snapshot of a finished\s*\/\/ agent_session's intent_log \+ transcript so the customer can replay\s*\/\/ the same flow later via the SDK without re-paying the LLM\s*\/\/ decomposition cost\./,
    );
  });

  it('surface framing pinned: create + list + getById + deleteById (read/management pulled fwd from v1.1 D2/D3 — V-530.I/.J); EXECUTION stays v1.1 (harness-executor-gated)', () => {
    expect(body).toMatch(
      /\/\/ Surface: create \+ list \+ getById \+ deleteById \(the read\/management\s*\/\/ path was pulled forward from the v1\.1 D2\/D3 defer — V-530\.I\/\.J\)\./,
    );
    expect(body).toMatch(/Recipe EXECUTION stays v1\.1 \(gated on the harness-wired executor\)\./);
  });

  it("Migration framing pinned: 'Migration: 0044_recipes.sql. Schema follows the same text-PK + jsonb-payload pattern as agent_sessions.' — pinned so the schema-version anchor (0044) + the cross-table pattern reference survive (drift would orphan operators from the migration that introduced the recipes table)", () => {
    expect(body).toMatch(
      /\/\/ Migration: 0044_recipes\.sql\. Schema follows the same text-PK \+\s*\/\/ jsonb-payload pattern as agent_sessions\./,
    );
  });

  it('RecipeRecord 8-field shape pinned: id (rec_<uuid>) + accountId + agentSessionId (nullable) + label + description (nullable) + intentLog (ReadonlyArray<AgentIntent>) + transcriptSnapshot (ReadonlyArray<TranscriptEntry>) + createdAt + updatedAt. Drift to making agentSessionId non-nullable would break the recipe-survives-agent-session-cleanup contract; drift to dropping intentLog Readonly modifier would let callers accidentally mutate the captured plan', () => {
    expect(body).toMatch(/export interface RecipeRecord \{/);
    expect(body).toMatch(/id: string;/);
    expect(body).toMatch(/accountId: string;/);
    expect(body).toMatch(/agentSessionId: string \| null;/);
    expect(body).toMatch(/label: string;/);
    expect(body).toMatch(/description: string \| null;/);
    expect(body).toMatch(/intentLog: ReadonlyArray<AgentIntent>;/);
    expect(body).toMatch(/transcriptSnapshot: ReadonlyArray<TranscriptEntry>;/);
    expect(body).toMatch(/createdAt: Date;/);
    expect(body).toMatch(/updatedAt: Date;/);
  });

  it("agentSessionId ON-DELETE-SET-NULL framing pinned: 'Source agent-session this recipe was snapshotted from. NULLABLE because agent sessions may be deleted later but the recipe row survives — ON DELETE SET NULL preserves the recipe while dropping the dangling reference.' — pinned so the cleanup-cascade behavior + the survives-after-source-delete contract stay documented (drift to ON DELETE CASCADE would silently vaporize customer recipes when source sessions are purged)", () => {
    expect(body).toMatch(
      /Source agent-session this recipe was snapshotted from\. NULLABLE\s*\*\s+because agent sessions may be deleted later but the recipe\s*\*\s+row survives — ON DELETE SET NULL preserves the recipe while\s*\*\s+dropping the dangling reference\./,
    );
  });

  it('CreateRecipeArgs 5-field shape pinned: accountId + agentSessionId (nullable) + label + description (optional) + intentLog + transcriptSnapshot. Drift to dropping transcriptSnapshot would lose the months-later "what did I ask?" context the comment specifically names', () => {
    expect(body).toMatch(/export interface CreateRecipeArgs \{/);
    expect(body).toMatch(/accountId: string;/);
    expect(body).toMatch(/agentSessionId: string \| null;/);
    expect(body).toMatch(/label: string;/);
    expect(body).toMatch(/description\?: string;/);
    expect(body).toMatch(/intentLog: ReadonlyArray<AgentIntent>;/);
    expect(body).toMatch(/transcriptSnapshot: ReadonlyArray<TranscriptEntry>;/);
  });

  it('RecipesRepo idempotency framing pinned: \'Snapshot a recipe row. MUST be idempotent on (accountId, agentSessionId, label) if the same combination is sent twice — v1.0 chooses NOT to enforce uniqueness so customers can save the same agent-session under multiple labels (e.g. "smoke test" + "regression test #4" for the same underlying flow). The repo mints a fresh id per insert.\' — pinned so the deliberate NON-uniqueness contract + the use-case rationale (multi-label snapshots) survive. Drift to enforcing (accountId, agentSessionId, label) uniqueness would reject legitimate re-saves with different labels for the same session', () => {
    expect(body).toMatch(
      /Snapshot a recipe row\. MUST be idempotent on \(accountId,\s*\*\s+agentSessionId, label\) if the same combination is sent twice —\s*\*\s+v1\.0 chooses NOT to enforce uniqueness so customers can save\s*\*\s+the same agent-session under multiple labels \(e\.g\. "smoke test"\s*\*\s+\+ "regression test #4" for the same underlying flow\)\. The repo\s*\*\s+mints a fresh id per insert\./,
    );
  });

  it("InMemoryRecipesRepo framing pinned: 'In-memory implementation for unit tests + the disabled-routes activation-gate stub (kept symmetric with AgentSessionsRepo).' — pinned so the dual-purpose (test + activation-gate-stub) + the symmetry-with-AgentSessionsRepo reference stay documented (drift would orphan operators from the cross-repo pattern)", () => {
    expect(body).toMatch(
      /\* In-memory implementation for unit tests \+ the disabled-routes\s*\* activation-gate stub \(kept symmetric with AgentSessionsRepo\)\./,
    );
  });

  it('rec_inmem_<uuid> id minting pattern pinned. Drift to a different prefix would break test fixtures that grep for rec_inmem_ to identify in-memory vs. production recipe rows', () => {
    expect(body).toMatch(/const id = `rec_inmem_\$\{randomUUID\(\)\}`;/);
  });

  it('validateLabelAndDescription 2-cap invariants pinned: label trimmed + 1..120 chars + description ≤ 2000 chars. Drift to a different label-length window would diverge from the SDK + dashboard validation; drift to relaxing 2000-char description cap would let recipes grow unbounded', () => {
    expect(body).toMatch(
      /if \(trimmedLabel\.length < 1 \|\| trimmedLabel\.length > 120\) \{\s*throw new Error\('Recipe label must be 1-120 characters after trim'\);\s*\}/,
    );
    expect(body).toMatch(
      /if \(description !== undefined && description\.length > 2000\) \{\s*throw new Error\('Recipe description must be <= 2000 characters'\);\s*\}/,
    );
  });

  it("Empty-string-description normalization pinned: description '' → null (server stores null, not empty). Drift would diverge from the SDK's omit-when-None pattern; the server normalizes empty→null so downstream readers don't need to distinguish '' from missing", () => {
    expect(body).toMatch(
      /description: description === undefined \|\| description === '' \? null : description,/,
    );
  });
});
