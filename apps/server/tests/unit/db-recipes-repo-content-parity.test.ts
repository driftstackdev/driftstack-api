// Drift guard for apps/server/src/db/recipes-repo.ts. Pins AI-B4
// Drizzle implementation of RecipesRepo (migration 0044). Production
// wires this; tests/dev use InMemoryRecipesRepo from services/recipes.ts.
// Key shape rules: text PK rec_<uuid> + jsonb atomic snapshots
// (insert-once, never edited) + service-layer label/description
// validation + no update/delete surface in v1.0 (write-only per
// orchestrator handoff #3 Q.5).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/recipes-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('db/recipes-repo content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("AI-B4 module-level framing pinned: 'Drizzle implementation of RecipesRepo (migration 0044). Production wires this; tests/dev use InMemoryRecipesRepo from services/recipes.ts.' — pinned so the AI-B4 anchor + migration-0044 + production-vs-test-impl split contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ AI-B4 — Drizzle implementation of RecipesRepo \(migration 0044\)\.\s*\n?\s*\/\/ Production wires this; tests\/dev use InMemoryRecipesRepo from\s*\n?\s*\/\/ services\/recipes\.ts\./,
    );
  });

  it("4-key-shape-rule framing pinned: 'text PK rec_<uuid> minted at create.' + 'jsonb intent_log + transcript_snapshot are atomic snapshots (insert-once; never edited).' + 'Label trim + length + description length validation lives in the service-layer validateLabelAndDescription; the DB CHECK constraint is the belt-and-suspenders backstop for that.' + 'No update/delete surface in v1.0 — write-only per the orchestrator handoff #3 Q.5.' — pinned so the 4-rule contract + insert-once-never-edited + CHECK-backstop + write-only v1.0 contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/\s+- text PK `rec_<uuid>` minted at create\.\s*\n?\s*\/\/\s+- jsonb intent_log \+ transcript_snapshot are atomic snapshots\s*\n?\s*\/\/\s+\(insert-once; never edited\)\./,
    );
    expect(body).toMatch(
      /\/\/\s+- Label trim \+ length \+ description length validation lives in\s*\n?\s*\/\/\s+the service-layer `validateLabelAndDescription`; the DB CHECK\s*\n?\s*\/\/\s+constraint is the belt-and-suspenders backstop for that\./,
    );
    expect(body).toMatch(
      /\/\/\s+- No update\/delete surface in v1\.0 — write-only per the\s*\n?\s*\/\/\s+orchestrator handoff #3 Q\.5\./,
    );
  });

  it('rowToRecord 9-field mapper pinned: id + accountId + agentSessionId + label + description + intentLog ?? [] + transcriptSnapshot ?? [] + createdAt + updatedAt. + ReadonlyArray<AgentIntent> + ReadonlyArray<TranscriptEntry> type-casts. Drift to dropping the ?? [] defaults would let null values crash downstream consumers (jsonb columns can be NULL at the schema level)', () => {
    expect(body).toMatch(
      /function rowToRecord\(row: typeof recipes\.\$inferSelect\): RecipeRecord \{\s*\n?\s*return \{\s*\n?\s*id: row\.id,\s*\n?\s*accountId: row\.accountId,\s*\n?\s*agentSessionId: row\.agentSessionId,\s*\n?\s*label: row\.label,\s*\n?\s*description: row\.description,\s*\n?\s*intentLog: \(row\.intentLog as ReadonlyArray<AgentIntent>\) \?\? \[\],\s*\n?\s*transcriptSnapshot: \(row\.transcriptSnapshot as ReadonlyArray<TranscriptEntry>\) \?\? \[\],/,
    );
  });

  it("validateLabelAndDescription 1-120-char-label-after-trim + 2000-char-description-cap framing pinned: trimmedLabel.length < 1 || > 120 → 'Recipe label must be 1-120 characters after trim' + description.length > 2000 → 'Recipe description must be <= 2000 characters' + empty-string description coerces to null. Drift to dropping the trim would let whitespace-only labels through; drift to allowing > 2000-char descriptions would bloat the jsonb column", () => {
    expect(body).toMatch(
      /const trimmedLabel = label\.trim\(\);\s*\n?\s*if \(trimmedLabel\.length < 1 \|\| trimmedLabel\.length > 120\) \{\s*\n?\s*throw new Error\('Recipe label must be 1-120 characters after trim'\);/,
    );
    expect(body).toMatch(
      /if \(description !== undefined && description\.length > 2000\) \{\s*\n?\s*throw new Error\('Recipe description must be <= 2000 characters'\);/,
    );
    expect(body).toMatch(
      /description: description === undefined \|\| description === '' \? null : description,/,
    );
  });

  it("create rec_<uuid> minting + clock-injection framing pinned: const id = `rec_${randomUUID()}` + private readonly clock: () => Date = () => new Date() + .returning() + 'Recipe insert returned no rows' guard. Drift to dropping the no-rows guard would surface undefined-row crashes as opaque errors at the route layer", () => {
    expect(body).toMatch(
      /constructor\(\s*\n?\s*private readonly database: Database,\s*\n?\s*private readonly clock: \(\) => Date = \(\) => new Date\(\),\s*\n?\s*\) \{\}/,
    );
    expect(body).toMatch(/const id = `rec_\$\{randomUUID\(\)\}`;/);
    expect(body).toMatch(/\.returning\(\);/);
    expect(body).toMatch(
      /const row = inserted\[0\];\s*\n?\s*if \(!row\) \{\s*\n?\s*throw new Error\('Recipe insert returned no rows'\);\s*\n?\s*\}/,
    );
  });

  it("Insert-once createdAt === updatedAt framing pinned: const now = this.clock() + createdAt: now + updatedAt: now (same value at create time). Drift to differing createdAt vs updatedAt at insert would create an artificial 'was-edited' signal in the audit log", () => {
    expect(body).toMatch(
      /const now = this\.clock\(\);\s*\n?\s*const inserted = await this\.database\.db\s*\n?\s*\.insert\(recipes\)\s*\n?\s*\.values\(\{[\s\S]*?createdAt: now,\s*\n?\s*updatedAt: now,/,
    );
  });
});
