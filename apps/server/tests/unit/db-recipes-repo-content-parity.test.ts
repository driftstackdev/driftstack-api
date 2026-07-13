// Drift guard for apps/server/src/db/recipes-repo.ts. Pins AI-B4
// Drizzle implementation of RecipesRepo (migration 0044). Production
// wires this; tests/dev use InMemoryRecipesRepo from services/recipes.ts.
// Key shape rules: text PK rec_<uuid> + encrypted jsonb snapshots +
// bounded legacy conversion + service-layer label/description
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
      /\/\/\s+- text PK `rec_<uuid>` minted at create\.\s*\n?\s*\/\/\s+- jsonb intent_log \+ transcript_snapshot store versioned AES-GCM envelopes\.\s*\n?\s*\/\/\s+Legacy plaintext arrays remain readable and are converted by a bounded\s*\n?\s*\/\/\s+compare-and-set bootstrap upgrader\./,
    );
    expect(body).toMatch(
      /\/\/\s+- Label trim \+ length \+ description length validation lives in\s*\n?\s*\/\/\s+the service-layer `validateLabelAndDescription`; the DB CHECK\s*\n?\s*\/\/\s+constraint is the belt-and-suspenders backstop for that\./,
    );
    expect(body).toMatch(
      /\/\/\s+- No update\/delete surface in v1\.0 — write-only per the\s*\n?\s*\/\/\s+orchestrator handoff #3 Q\.5\./,
    );
  });

  it('rowToRecord decrypts and runtime-validates both JSONB payloads before returning a recipe', () => {
    expect(body).toMatch(
      /intentLog: readRecipeIntentLog\(row\.intentLog, payloadEncryptionKeyBase64\),\s*\n?\s*transcriptSnapshot: readAgentTranscript\(row\.transcriptSnapshot, payloadEncryptionKeyBase64\),/,
    );
  });

  it('new writes fail closed without a key and persist only encrypted envelopes', () => {
    expect(body).toMatch(/throw new Error\('Recipe payload encryption key is unavailable\.'\);/);
    expect(body).toMatch(/intentLog: encryptRecipeIntentLog\(args\.intentLog, key\),/);
    expect(body).toMatch(
      /transcriptSnapshot: encryptAgentTranscript\(args\.transcriptSnapshot, key\),/,
    );
  });

  it('legacy conversion authenticates an encrypted probe, finds arrays, and compare-and-sets both snapshots', () => {
    expect(body).toMatch(/async encryptLegacyPayloads\(limit = 500\)/);
    expect(body).toMatch(/readRecipeIntentLog\(encryptedProbe\.intentLog, key\);/);
    expect(body).toMatch(/readAgentTranscript\(encryptedProbe\.transcriptSnapshot, key\);/);
    expect(body).toMatch(/jsonb_typeof\(\$\{recipes\.intentLog\}\) = 'array'/);
    expect(body).toMatch(
      /\$\{recipes\.intentLog\} = \$\{JSON\.stringify\(row\.intentLog\)\}::jsonb/,
    );
    expect(body).toMatch(
      /\$\{recipes\.transcriptSnapshot\} = \$\{JSON\.stringify\(row\.transcriptSnapshot\)\}::jsonb/,
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
