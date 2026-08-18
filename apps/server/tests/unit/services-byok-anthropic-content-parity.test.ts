// Drift guard for apps/server/src/services/byok-anthropic.ts. Pins
// the AI-CHAT BYOK Anthropic per-customer key storage service —
// Tier-3 verdicts LOCKED 2026-05-17, 5-method service surface,
// 90-day TTL gate, sk-ant- prefix validation, account-owner-only
// authorization, and the dashboard metadata read-no-plaintext contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/byok-anthropic.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/byok-anthropic content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Tier-3 LOCKED 2026-05-17 framing pinned: 'AI-CHAT BYOK Anthropic — per-customer key storage service. Tier-3 verdicts LOCKED 2026-05-17 (5 questions, see docs/internal/byok-anthropic-key-storage-design.md).' — pinned so the lock-date anchor + the 5-questions design-SOT reference survive (drift would orphan operators from the verdict trail)", () => {
    expect(body).toMatch(
      /\/\/ AI-CHAT BYOK Anthropic — per-customer key storage service\.\s*\n?\s*\/\/ Tier-3 verdicts LOCKED 2026-05-17 \(5 questions, see\s*\n?\s*\/\/ docs\/internal\/byok-anthropic-key-storage-design\.md\)\./,
    );
  });

  it("5-method service surface framing pinned: setKey + clearKey + getPlaintext + getMetadata + touchLastUsed. Drift to dropping touchLastUsed would break the dashboard's 'Last used …' display + the silent-fallthrough TTL gate (it relies on last_used_at-vs-set_at to identify stale keys)", () => {
    // The five method names and their one-line purposes, matched individually
    // rather than as one long verbatim block.
    //
    // The block form pinned getPlaintext's description as "decrypt for the
    // AgentRuntime call site ONLY", which had stopped being true — the /test
    // handler decrypts too, and has since it shipped. Correcting the comment
    // failed this arm, which is a pin holding a false statement in place: the
    // same failure as the V-750 checklist number. The surface is what this case
    // is named for and is what it now checks; the call-site set is enforced by
    // byok-plaintext-call-sites-are-pinned.
    expect(body).toMatch(/\/\/ Surface:/);
    for (const [method, purpose] of [
      ['setKey', /encrypt customer's Anthropic key \+ persist/],
      ['clearKey', /delete the row \(NULL ciphertext \+ timestamps\)/],
      ['getPlaintext', /decrypt/],
      ['getMetadata', /non-secret read for the dashboard/],
      ['touchLastUsed', /bump `last_used_at` after a successful Claude call/],
    ] as const) {
      expect(body, `the ${method} line is gone from the Surface block`).toMatch(
        new RegExp(`\\/\\/ {3}- \`${method}\``),
      );
      expect(body, `the ${method} purpose no longer reads as documented`).toMatch(purpose);
    }
    // getMetadata's guarantee is the one worth holding verbatim: it is the read
    // the dashboard calls, and "never returns plaintext" is the property.
    expect(body).toMatch(/never returns plaintext/);
  });

  it("Q3 account-owner-only authorisation framing pinned: 'Account-owner-only authorisation (Q3 verdict). Team members on a shared account may USE the resolved key (the AgentRuntime resolves from the owner's account) but cannot SET/CLEAR via this service — route-layer auth enforces the owner-only gate.' — pinned so the owner-vs-member split + the route-layer-enforces contract stay documented (drift would let team members rotate the owner's BYOK key without consent)", () => {
    expect(body).toMatch(
      /\/\/ Account-owner-only authorisation \(Q3 verdict\)\. Team members on a\s*\n?\s*\/\/ shared account may USE the resolved key \(the AgentRuntime resolves\s*\n?\s*\/\/ from the owner's account\) but cannot SET\/CLEAR via this service —\s*\n?\s*\/\/ route-layer auth enforces the owner-only gate\./,
    );
  });

  it("Q2 'no audit-log fingerprint of key value' framing pinned: 'Audit entries on PUT/DELETE/test record only account_id + timestamp (the route layer wires those calls separately).' — pinned so the deliberately-no-key-fingerprint privacy contract survives (drift to logging fingerprints would leak BYOK key information into audit-log dumps which customers can export)", () => {
    expect(body).toMatch(
      /\/\/ No audit-log fingerprint of the key value \(Q2 verdict\)\. Audit\s*\n?\s*\/\/ entries on PUT\/DELETE\/test record only `account_id` \+ timestamp\s*\n?\s*\/\/ \(the route layer wires those calls separately\)\./,
    );
  });

  it("BYOKAnthropicKeyRow 4-field shape: accountId + ciphertext (Buffer|null) + setAt + lastUsedAt. + 'Drizzle returns this as a Buffer; the InMemory variant uses base64 strings for portability. Both paths normalise to Buffer in the service.' — pinned so the cross-backend portability framing stays documented", () => {
    expect(body).toMatch(
      /export interface BYOKAnthropicKeyRow \{\s*\n?\s*accountId: string;\s*\n?\s*\/\*\* Base64 representation of the bytea \(`\[IV \| tag \| ciphertext\]`\)\.\s*\n?\s*\*\s+Drizzle returns this as a `Buffer`; the InMemory variant uses\s*\n?\s*\*\s+base64 strings for portability\. Both paths normalise to `Buffer`\s*\n?\s*\*\s+in the service\. \*\/\s*\n?\s*ciphertext: Buffer \| null;\s*\n?\s*setAt: Date \| null;\s*\n?\s*lastUsedAt: Date \| null;\s*\n?\s*\}/,
    );
  });

  it("BYOKAnthropicKeyMetadata dashboard read framing pinned: hasKey + setAt + lastUsedAt. + 'hasKey === false means no BYOK key set (runtime falls back to the per-request header → deployment fallback).' — pinned so the no-plaintext-in-metadata contract + the fallback-chain reference stay explicit (drift to including plaintext in the metadata read would leak the key in dashboard responses)", () => {
    expect(body).toMatch(
      /\/\*\* Metadata read for the dashboard — never includes plaintext\.\s*\n?\s*\*\s+`hasKey === false` means no BYOK key set \(runtime falls back to\s*\n?\s*\*\s+the per-request header → deployment fallback\)\. \*\/\s*\n?\s*export interface BYOKAnthropicKeyMetadata \{\s*\n?\s*hasKey: boolean;\s*\n?\s*setAt: Date \| null;\s*\n?\s*lastUsedAt: Date \| null;\s*\n?\s*\}/,
    );
  });

  it("Q1 MFA_ENCRYPTION_KEY sharing framing pinned: 'Base64-encoded 32-byte AES-256 key. Shares MFA_ENCRYPTION_KEY per Q1 verdict 2026-05-17 — operational simplicity over compartmentalisation.' — pinned so the deliberate-shared-key rationale stays documented (drift to a separate BYOK-specific key would force ops to manage one more env var; the verdict deliberately consolidated)", () => {
    expect(body).toMatch(
      /\/\*\* Base64-encoded 32-byte AES-256 key\. Shares\s*\n?\s*\*\s+`MFA_ENCRYPTION_KEY` per Q1 verdict 2026-05-17 — operational\s*\n?\s*\*\s+simplicity over compartmentalisation\. \*\//,
    );
  });

  it("v2-#21 90-day TTL framing pinned: BYOK_ANTHROPIC_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000. + 'matches the ROTATION_TARGET_DAYS constant in the rotation-reminder services (v2-#10.5 / v2-#11.5) — past that point the customer has been nagged for ~30 days and the key is considered stale.' — pinned so the 90-day cap + cross-service rotation-reminder coordination + the 30-day-nag-window stay documented", () => {
    expect(body).toMatch(/export const BYOK_ANTHROPIC_KEY_TTL_MS = 90 \* 24 \* 60 \* 60 \* 1000;/);
    expect(body).toMatch(
      /\/\*\* v2-#21 — default BYOK Anthropic key TTL\. 90 days matches the\s*\n?\s*\*\s+ROTATION_TARGET_DAYS constant in the rotation-reminder services\s*\n?\s*\*\s+\(v2-#10\.5 \/ v2-#11\.5\) — past that point the customer has been\s*\n?\s*\*\s+nagged for ~30 days and the key is considered stale\. \*\//,
    );
  });

  it("InvalidKeyFormatError 'sk-ant-…' prefix-validation framing pinned. Drift to relaxing the prefix-check would let customers paste non-Anthropic keys + waste an Anthropic API call to discover the format mismatch", () => {
    expect(body).toMatch(/export class InvalidKeyFormatError extends Error \{/);
    expect(body).toMatch(
      /super\('Provided value does not look like an Anthropic API key \(expected `sk-ant-…` prefix\)\.'\);/,
    );
  });

  it('BYOKAnthropicService class with 5-method surface: setKey (encrypt + persist + bump set_at) + clearKey (delete row) + getPlaintext (decrypt; null when expired) + getMetadata (no plaintext) + touchLastUsed (idempotent). Drift to changing a method signature would break the route layer that wires them', () => {
    expect(body).toMatch(/export class BYOKAnthropicService \{/);
    expect(body).toMatch(
      /async setKey\(args: \{\s*\n?\s*accountId: string;\s*\n?\s*plaintext: string;\s*\n?\s*now: Date;\s*\n?\s*\}\): Promise<\{ setAt: Date \}>/,
    );
    expect(body).toMatch(
      /async clearKey\(args: \{ accountId: string; now: Date \}\): Promise<void>/,
    );
    expect(body).toMatch(
      /async getPlaintext\(args: \{\s*\n?\s*accountId: string;\s*\n?\s*now\?: Date;\s*\n?\s*\}\): Promise<BYOKAnthropicKeyPlaintext \| null>/,
    );
    expect(body).toMatch(
      /async getMetadata\(args: \{ accountId: string \}\): Promise<BYOKAnthropicKeyMetadata>/,
    );
    expect(body).toMatch(
      /async touchLastUsed\(args: \{ accountId: string; now: Date \}\): Promise<void>/,
    );
  });

  it('set and ordinary read pass the exact owning account into the v2 envelope codec', () => {
    expect(body).toMatch(
      /encryptByokAnthropicKey\(\s*\n?\s*args\.plaintext,\s*\n?\s*this\.config\.encryptionKey,\s*\n?\s*args\.accountId,\s*\n?\s*\)/,
    );
    expect(body).toMatch(
      /decryptByokAnthropicKey\(row\.ciphertext, this\.config\.encryptionKey, row\.accountId\)/,
    );
  });

  it("v2-#21 TTL-gate-bypass-via-header framing pinned: 'Per-request x-byok-anthropic-api-key headers bypass storage entirely so customers can always recover by passing a fresh key on the wire.' — pinned so the customer-recovery-path documentation survives (drift to gating headers behind the storage TTL would trap customers with a 90+ day stored key in the same expired-state on every request)", () => {
    expect(body).toMatch(
      /\/\/ Per-request `x-byok-anthropic-api-key` headers bypass storage\s*\n?\s*\/\/ entirely so customers can always recover by passing a fresh\s*\n?\s*\/\/ key on the wire\./,
    );
  });

  it('v2-#32 onKeyExpired observability hook pinned: error-swallowed best-effort callback that surfaces silent fall-through events to ops without breaking the read path. Drift to throwing on observability errors would let a broken Sentry/Otel sink crash the resolution chain', () => {
    expect(body).toMatch(
      /try \{\s*\n?\s*this\.config\.onKeyExpired\?\.\(\{\s*\n?\s*accountId: args\.accountId,\s*\n?\s*ageMs,\s*\n?\s*maxAgeMs,\s*\n?\s*\}\);\s*\n?\s*\} catch \{\s*\n?\s*\/\* swallow — observability hook must not break the read path \*\//,
    );
  });

  it("InMemoryBYOKAnthropicRepo dual-purpose framing pinned: 'In-memory implementation for tests + dev mode. The real impl is DrizzleBYOKAnthropicRepo in db/byok-anthropic-repo.ts.' — pinned so the cross-backend pointer + the DrizzleRepo reference stay documented", () => {
    expect(body).toMatch(
      /\/\*\* In-memory implementation for tests \+ dev mode\. The real impl\s*\n?\s*\*\s+is `DrizzleBYOKAnthropicRepo` in `db\/byok-anthropic-repo\.ts`\. \*\//,
    );
  });

  it("touchLastUsed no-op-when-no-key pinned: 'if (!row || row.ciphertext === null) return Promise.resolve(); // no-op if no key set'. Drift to inserting a phantom row on touchLastUsed would create rows with NULL ciphertext but populated lastUsedAt, breaking the hasKey=false invariant in getMetadata", () => {
    expect(body).toMatch(
      /touchLastUsed\(args: \{ accountId: string; now: Date \}\): Promise<void> \{\s*\n?\s*const row = this\.rows\.get\(args\.accountId\);\s*\n?\s*if \(!row \|\| row\.ciphertext === null\) return Promise\.resolve\(\); \/\/ no-op if no key set/,
    );
  });
});
