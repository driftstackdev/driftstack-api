// Drift guard for apps/server/src/db/recipes-repo.ts. Pins AI-B4
// Drizzle implementation of RecipesRepo (migration 0044). Production
// wires this; tests/dev use InMemoryRecipesRepo from services/recipes.ts.
// Key shape rules: text PK rec_<uuid> + encrypted jsonb snapshots +
// bounded record-bound legacy conversion + service-layer label/description
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

  it('documents encrypted JSONB payloads and bounded compare-and-set legacy conversion', () => {
    expect(body).toMatch(
      /\/\/\s+- text PK `rec_<uuid>` minted at create\.\s*\n?\s*\/\/\s+- jsonb intent_log \+ transcript_snapshot store versioned AES-GCM envelopes\.\s*\n?\s*\/\/\s+Legacy plaintext arrays and context-free v1 envelopes are readable only\s*\n?\s*\/\/\s+by a bounded compare-and-set bootstrap upgrader\./,
    );
    expect(body).toMatch(
      /\/\/\s+- Label trim \+ length \+ description length validation lives in\s*\n?\s*\/\/\s+the service-layer `validateLabelAndDescription`; the DB CHECK\s*\n?\s*\/\/\s+constraint is the belt-and-suspenders backstop for that\./,
    );
    expect(body).toMatch(
      /\/\/\s+- No update\/delete surface in v1\.0 — write-only per the\s*\n?\s*\/\/\s+orchestrator handoff #3 Q\.5\./,
    );
  });

  it('rowToRecord binds and runtime-validates both JSONB payloads to account + recipe', () => {
    expect(body).toMatch(/const context = \{ accountId: row\.accountId, recipeId: row\.id \};/);
    expect(body).toMatch(
      /intentLog: readRecipeIntentLog\(row\.intentLog, payloadEncryptionKeyBase64, context\),/,
    );
    expect(body).toMatch(/transcriptSnapshot: readRecipeTranscriptSnapshot\(/);
  });

  it('new writes fail closed without a key and persist only record-bound v2 envelopes', () => {
    expect(body).toMatch(/throw new Error\('Recipe payload encryption key is unavailable\.'\);/);
    expect(body).toMatch(/const context = \{ accountId: args\.accountId, recipeId: id \};/);
    expect(body).toMatch(/intentLog: encryptRecipeIntentLog\(args\.intentLog, key, context\),/);
    expect(body).toMatch(
      /transcriptSnapshot: encryptRecipeTranscriptSnapshot\(args\.transcriptSnapshot, key, context\),/,
    );
  });

  it('migration probes v2, prevalidates pages, exact-CASes both snapshots, and counts remaining', () => {
    expect(body).toMatch(/async migratePayloadEnvelopes\(/);
    expect(body).toMatch(/readRecipeIntentLog\(v2Probe\.intentLog, key, context\);/);
    expect(body).toMatch(
      /readRecipeTranscriptSnapshot\(v2Probe\.transcriptSnapshot, key, context\);/,
    );
    expect(body).toMatch(/const prepared = rows\.map\(\(row\) => \{/);
    expect(body).toMatch(/convertRecipeIntentLogToV2\(row\.intentLog, key, context\)/);
    expect(body).toMatch(/convertRecipeTranscriptSnapshotToV2\(/);
    expect(body).toMatch(/eq\(recipes\.accountId, row\.accountId\)/);
    expect(body).toMatch(
      /\$\{recipes\.intentLog\} IS NOT DISTINCT FROM \$\{JSON\.stringify\(row\.intentLog\)\}::jsonb/,
    );
    expect(body).toMatch(
      /\$\{recipes\.transcriptSnapshot\} IS NOT DISTINCT FROM \$\{JSON\.stringify\(row\.transcriptSnapshot\)\}::jsonb/,
    );
    expect(body).toMatch(/return \{ scanned: rows\.length, converted, remaining:/);
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
    expect(body).toMatch(/this\.clock = options\.clock \?\? \(\(\) => new Date\(\)\);/);
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
