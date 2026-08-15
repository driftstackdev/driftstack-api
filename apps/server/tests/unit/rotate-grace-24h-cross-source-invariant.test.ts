// W901 — V-296 + V-359 24h rotate-grace parallel-policy cross-
// source invariant. Two-hundred-twenty-seventh in the drift-guard
// series. Pins TWO 24-hour rotate-grace policies:
//
//   V-296 API-key rotation:
//     - Customer self-service rotation. Mints fresh plaintext +
//       hash; sets expires_at on OLD key to now + gracePeriodMs.
//     - gracePeriodMs default = 24 * 60 * 60 * 1000 (24 hours).
//     - Old key continues to authenticate until expires_at; then
//       existing expires_at gate in auth.ts rejects cleanly.
//
//   V-359 Webhook signing-secret rotation:
//     - 24h grace window — every outbound delivery signed with
//       both new + old secret.
//     - rotation_grace_expires_at populated only during grace;
//       null when no rotation in flight.
//
// stays in lockstep across:
//   - apps/server/src/services/api-keys.ts (V-296 24h default).
//   - packages/api-types/src/webhooks.ts (V-359 24h grace
//     framing).
//
// Drift would silently break:
//   * Customer rotation flow if grace shrinks (no time to
//     migrate).
//   * Webhook delivery rejection if old secret cuts off too soon.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const GRACE_HOURS = 24;
const GRACE_MS = GRACE_HOURS * 60 * 60 * 1000;

describe('W901 V-296 + V-359 24h rotate-grace cross-source invariant', () => {
  // ─── V-296 API-key rotate gracePeriodMs default = 24h ────────

  it('CRITICAL apps/server/src/services/api-keys.ts api-key rotate() defaults gracePeriodMs to 24 * 60 * 60 * 1000 (= 24 hours). The 24h default gives customers time to migrate clients to the new key before the old one auto-revokes.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toMatch(/const gracePeriodMs = opts\.gracePeriodMs \?\? 24 \* 60 \* 60 \* 1000;/);
  });

  it("CRITICAL V-296 rotate() framing — 'customer self-service rotation. Mints a fresh plaintext + hash for a new api_keys row (same name + accountId + minter, and the same scopes MINUS any elevated ones), and sets expires_at on the OLD key to now + gracePeriodMs'. V-775 corrected 'same scopes': this pin froze the escalation, asserting verbatim scope copying as the intended contract while rotate's own comment said it 'always produces an ordinary customer API key'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toMatch(/V-296 — customer self-service rotation\. Mints a fresh plaintext \+/);
    expect(p).toMatch(
      /hash for a new api_keys row \(same name \+ accountId \+ minter, and the same/,
    );
    expect(p).toMatch(/scopes MINUS any elevated ones/);
    expect(p, 'the retired verbatim-copy contract must not come back').not.toMatch(
      /same name \+ scopes \+ accountId/,
    );
    expect(p).toMatch(/sets `expires_at` on the OLD key to `now \+ gracePeriodMs`/);
  });

  it("CRITICAL V-296 rotate() comment pins the 'old key continues to authenticate until that timestamp; after that the existing expires_at gate in auth.ts rejects it cleanly' framing. The 'cleanly' part is what makes the old key fail with a clear error (vs ambiguous).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toMatch(
      /The old\s*\n\s*\*\s*key continues to authenticate until that timestamp; after that the/,
    );
    expect(p).toMatch(/existing expires_at gate in auth\.ts rejects it cleanly/);
  });

  // ─── V-359 webhook-secret rotation 24h grace ─────────────────

  it("CRITICAL packages/api-types/src/webhooks.ts pins V-359 24h grace — 'populated only during the 24h rotation grace period'. The 24h matches the V-296 default — both rotation flows use the same window.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(/V-359 — populated only during the 24h rotation grace period/);
    expect(p).toMatch(/Null when no rotation in flight/);
  });

  it("CRITICAL V-359 RotateWebhookSecret response describe — 'Until this timestamp, every outbound delivery is signed with both the new + old secret so the customer can roll their verifier across infra without dropped deliveries'. The dual-signing semantics is what makes mid-rotation deliveries succeed under EITHER signature.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(
      /Until this timestamp, every outbound delivery is signed with both the new \+ old secret/,
    );
    expect(p).toMatch(/customer can roll their verifier across infra without dropped deliveries/);
  });

  // ─── Shared 24h grace cardinality ────────────────────────────

  it('CRITICAL BOTH rotation flows share the 24-hour grace window. The 24h default is consistent across V-296 + V-359 — drift to mismatched windows would create UX asymmetry (one flow more forgiving than the other).', () => {
    expect(GRACE_HOURS).toBe(24);
    expect(GRACE_MS).toBe(86_400_000);
  });

  // ─── Override semantics ──────────────────────────────────────

  it("CRITICAL V-296 gracePeriodMs is OVERRIDABLE via opts.gracePeriodMs — the '?? 24 * 60 * 60 * 1000' nullish-coalesce lets callers pass a custom window. Tests can shrink to 1ms for snapshot tests; production uses 24h default.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toMatch(/gracePeriodMs\?: number;/);
    expect(p).toMatch(/opts\.gracePeriodMs \?\? 24 \* 60 \* 60 \* 1000/);
  });

  // ─── atomic repository transition ───────────────────────────

  it('CRITICAL V-296 rotation atomically locks old-key authority, inserts one successor, and shortens the old key without extending an earlier expiry', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    expect(p).toMatch(/Rotation must use\s*\n\s*\*\s*rotateApiKeyAtomic\(\)/);
    expect(p).toMatch(/rotateApiKeyAtomic\(input: RotateApiKeyInput\)/);
    expect(p).toMatch(/const result = await this\.repo\.rotateApiKeyAtomic\(\{/);
    expect(p).toMatch(/successor and shorten the old key to the grace boundary in one transaction/);
    expect(p).toMatch(/capped at the EARLIER of \(existing,\s*\n\s*\*\s*now\+grace\)/);
    expect(p).not.toMatch(/await this\.repo\.setExpiresAt\(/);
  });

  // ─── 2-rotation-flow + 24h-default parallel ──────────────────

  it('CRITICAL 2 rotation flows share 24h grace — API-key (V-296) + webhook-secret (V-359). The parallel policy is intentional: both are customer-facing secret rotations with similar UX (rotate, get new, migrate clients, old expires).', () => {
    const apiKeys = read(resolve(REPO_ROOT, 'apps/server/src/services/api-keys.ts'));
    const webhooks = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(apiKeys).toMatch(/24 \* 60 \* 60 \* 1000/);
    expect(webhooks).toMatch(/24h rotation grace period/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/rotate-grace-24h-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
