// Drift guard for apps/server/src/db/byok-anthropic-repo.ts. Pins
// the AI-CHAT BYOK Anthropic Drizzle repo backing the 3 new columns
// from migration 0041. NULL ciphertext is the "no BYOK key set"
// sentinel — runtime resolution falls back to header then to
// BYOK_ANTHROPIC_FALLBACK_KEY env. v2-#11 reset-rotation-reminder
// on every upsert.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/byok-anthropic-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('db/byok-anthropic-repo content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("AI-CHAT BYOK Anthropic module-level framing pinned: 'Drizzle implementation of BYOKAnthropicRepo. Backs the three new columns on accounts (migration 0041): byok_anthropic_api_key_ciphertext bytea + byok_anthropic_api_key_set_at timestamptz + byok_anthropic_api_key_last_used_at timestamptz.' — pinned so the migration 0041 + 3-column shape + bytea/timestamptz types contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ AI-CHAT BYOK Anthropic — Drizzle implementation of BYOKAnthropicRepo\.\s*\/\/ Backs the three new columns on `accounts` \(migration 0041\):\s*\/\/\s+- byok_anthropic_api_key_ciphertext bytea\s*\/\/\s+- byok_anthropic_api_key_set_at timestamptz\s*\/\/\s+- byok_anthropic_api_key_last_used_at timestamptz/,
    );
  });

  it('NULL-ciphertext-sentinel + fallback-cascade framing pinned: \'The repo only reads/writes these three columns; the rest of the accounts row stays untouched. NULL ciphertext is the "no BYOK key set" sentinel — runtime resolution falls back to the request header, then the deployment fallback BYOK_ANTHROPIC_FALLBACK_KEY env var.\' — pinned so the 3-column-only-touch + NULL-sentinel + 3-tier fallback cascade (DB → header → env) contract all stay documented', () => {
    expect(body).toMatch(
      /\/\/ The repo only reads\/writes these three columns; the rest of the\s*\/\/ accounts row stays untouched\. NULL ciphertext is the "no BYOK key\s*\/\/ set" sentinel — runtime resolution falls back to the request header,\s*\/\/ then the deployment fallback `BYOK_ANTHROPIC_FALLBACK_KEY` env var\./,
    );
  });

  it('findByAccount 4-field SELECT + ?? null defaults pinned: id + ciphertext + setAt + lastUsedAt + ?? null on the 3 nullable fields. Drift to dropping the ?? null on row.ciphertext would let undefined slip through to the runtime resolver', () => {
    expect(body).toMatch(
      /\.select\(\{\s*id: accounts\.id,\s*ciphertext: accounts\.byokAnthropicApiKeyCiphertext,\s*setAt: accounts\.byokAnthropicApiKeySetAt,\s*lastUsedAt: accounts\.byokAnthropicApiKeyLastUsedAt,\s*\}\)/,
    );
    expect(body).toMatch(
      /return \{\s*accountId: row\.id,\s*ciphertext: row\.ciphertext \?\? null,\s*setAt: row\.setAt \?\? null,\s*lastUsedAt: row\.lastUsedAt \?\? null,\s*\};/,
    );
  });

  it("upsert ALTER-TABLE-no-separate-row framing pinned + v2-#11 reset-rotation-reminder dedupe pinned: 'ALTER TABLE migration only added columns to the existing accounts row — there's no separate fleet row to insert. UPDATE the three BYOK columns + bump updatedAt.' + 'v2-#11 — reset rotation reminder dedupe on every key set so the next 90d cycle can fire reminders again.' + byokAnthropicApiKeyLastReminderSentAt: null on every upsert. Drift to NOT resetting the reminder dedupe would suppress the next 90d cycle's reminders after a key rotation", () => {
    expect(body).toMatch(
      /\/\/ ALTER TABLE migration only added columns to the existing accounts\s*\/\/ row — there's no separate fleet row to insert\. UPDATE the three\s*\/\/ BYOK columns \+ bump updatedAt\./,
    );
    expect(body).toMatch(
      /\/\/ v2-#11 — reset rotation reminder dedupe on every key set so\s*\/\/ the next 90d cycle can fire reminders again\.\s*byokAnthropicApiKeyLastReminderSentAt: null,/,
    );
  });

  it("clear NULL-out-4-columns + updatedAt bump framing pinned: byokAnthropicApiKeyCiphertext: null + setAt: null + lastUsedAt: null + lastReminderSentAt: null + updatedAt: args.now. Drift to leaving lastUsedAt populated on clear would leak a 'last seen' signal after a customer removed their key", () => {
    expect(body).toMatch(
      /async clear\(args: \{ accountId: string; now: Date \}\): Promise<void> \{\s*await this\.database\.db\s*\.update\(accounts\)\s*\.set\(\{\s*byokAnthropicApiKeyCiphertext: null,\s*byokAnthropicApiKeySetAt: null,\s*byokAnthropicApiKeyLastUsedAt: null,\s*byokAnthropicApiKeyLastReminderSentAt: null,\s*updatedAt: args\.now,/,
    );
  });

  it("touchLastUsed bumps lastUsedAt ONLY, not updatedAt framing pinned: 'Bump only — does NOT touch updated_at (the touch is an application-side observation, not a customer mutation).' + .set({ byokAnthropicApiKeyLastUsedAt: args.now }). Drift to bumping updatedAt on touch would create artificial 'customer edited' signals in the audit log for every request that resolves a BYOK key", () => {
    expect(body).toMatch(
      /\/\/ Bump only — does NOT touch `updated_at` \(the touch is an\s*\/\/ application-side observation, not a customer mutation\)\./,
    );
    expect(body).toMatch(
      /\.set\(\{ byokAnthropicApiKeyLastUsedAt: args\.now \}\)\s*\.where\(eq\(accounts\.id, args\.accountId\)\);/,
    );
  });
});
