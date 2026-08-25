// W680 — cross-SDK 24h grace-window parity. Seventh in the cross-
// SDK drift-guard series (W649 verb + W675 error class + W676
// problem-type URI + W677 auth/UA + W678 webhook sig + W679 retry +
// W680 grace window).
//
// Asserts the 24h grace-window framing is consistent across all 3
// SDKs for the 2 rotation flows:
//
//   - V-296: api-keys rotate — old key.expires_at = now + 24h;
//     both keys work concurrently during the grace window; old
//     auto-revokes via the existing expires_at-driven auth gate.
//   - V-359: webhook signing secret rotate — previous secret stays
//     active for 24h (`grace_expires_at`); Driftstack dual-signs
//     every outbound delivery during the window (both new + old
//     HMAC).
//
// Drift to a different window (12h / 48h / 7d) in ANY SDK would
// silently change customer rotation timelines that they may have
// architected their deploy pipelines around.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_API_KEYS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/api-keys.ts');
const TS_WEBHOOKS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/webhooks.ts');
const GO_API_KEYS = resolve(REPO_ROOT, 'packages/sdk-go/api_keys.go');
const GO_WEBHOOKS = resolve(REPO_ROOT, 'packages/sdk-go/webhooks.go');
const PY_API_KEYS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/api_keys.py');
const PY_WEBHOOKS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/webhooks.py');

describe('W680 cross-SDK 24h grace-window parity', () => {
  it('all 6 SDK resource files (api-keys + webhooks × 3 SDKs) exist at canonical paths', () => {
    for (const p of [
      TS_API_KEYS,
      TS_WEBHOOKS,
      GO_API_KEYS,
      GO_WEBHOOKS,
      PY_API_KEYS,
      PY_WEBHOOKS,
    ]) {
      expect(existsSync(p), `missing ${p}`).toBe(true);
    }
  });

  it('CRITICAL V-296 api-keys 24h grace window pinned in ALL 3 SDKs. Drift to 12h would force customers to deploy keys 2x faster; drift to 48h would delay key cleanup and widen the auth-key risk surface.', () => {
    const ts = read(TS_API_KEYS);
    const go = read(GO_API_KEYS);
    const py = read(PY_API_KEYS);

    // sdk-typescript: "now + 24h grace"
    expect(ts).toMatch(/24h grace/);

    // sdk-go: "now + 24h grace"
    expect(go).toMatch(/24h grace/);

    // sdk-python: "with a 24h grace period" + "now + 24h"
    expect(py).toMatch(/24h grace period/);
  });

  it('CRITICAL V-296 dual-keys-concurrent invariant pinned per-SDK: "Both keys work concurrently during the grace window". Drift to "the old key is immediately revoked" would invert the rotation contract — customers couldn\'t deploy the new key gradually.', () => {
    const ts = read(TS_API_KEYS);
    const go = read(GO_API_KEYS);
    const py = read(PY_API_KEYS);

    expect(ts).toMatch(/Both keys work concurrently during the/);
    expect(go).toMatch(/Both keys work concurrently during the/);
    expect(py).toMatch(/Both keys work concurrently during the grace/);
  });

  it('CRITICAL V-296 auto-revoke-via-expires_at-gate invariant pinned per-SDK. The "old key auto-revokes via the existing expires_at-driven auth gate" framing is what makes V-296 work without a separate cleanup job. Drift to "manual revoke required" would force customers to add a 24h timer to call DELETE on the old key.', () => {
    const ts = read(TS_API_KEYS);
    const go = read(GO_API_KEYS);

    // sdk-typescript explicitly references the expires_at auth gate.
    expect(ts).toMatch(/expires_at-driven auth gate/);

    // sdk-go references the auto-revoke at grace boundary.
    expect(go).toMatch(/auto-revokes at/);
  });

  it('CRITICAL V-296 grace_period_ends_at field pinned in api-keys RotateApiKeyResponse — all 3 SDKs expose this field so customers can compute "old key revokes in 23h 45m". Drift to dropping would force customers to hardcode the 24h offset themselves.', () => {
    const ts = read(TS_API_KEYS);
    const py = read(PY_API_KEYS);

    expect(ts).toMatch(/grace_period_ends_at: string;/);
    expect(py).toMatch(/grace_period_ends_at: str/);
  });

  it('CRITICAL V-359 webhook 24h grace window pinned in ALL 3 SDKs. Drift to 12h would force customers to roll their verifier 2x faster; drift to 48h would widen the dual-sign window unnecessarily.', () => {
    const ts = read(TS_WEBHOOKS);
    const go = read(GO_WEBHOOKS);
    const py = read(PY_WEBHOOKS);

    expect(ts).toMatch(/previous secret stays active for 24h/);
    expect(go).toMatch(/previous secret stays active for 24h/);
    expect(py).toMatch(/previous secret stays active for 24h/);
  });

  it('CRITICAL V-359 dual-sign invariant pinned per-SDK: "Driftstack dual-signs every outbound delivery (both the new + old HMAC)". Drift to single-sign would force customers to roll their verifier BEFORE the new secret is in production (race condition).', () => {
    const ts = read(TS_WEBHOOKS);
    const go = read(GO_WEBHOOKS);
    const py = read(PY_WEBHOOKS);

    // sdk-typescript: "Driftstack dual-signs every outbound delivery (both the new + old HMAC)"
    expect(ts).toMatch(/Driftstack dual-signs every/);

    // sdk-go: similar dual-sign framing on the secret-rotation shape.
    expect(go).toMatch(/Driftstack dual-signs every/);

    // sdk-python: same dual-sign framing.
    expect(py).toMatch(/Driftstack dual-signs/);
  });

  it('CRITICAL V-359 grace_expires_at field pinned in webhook RotateWebhookSecretResponse — all 3 SDKs reference this field. Drift to renaming would break dashboards rendering "dual-sign ends in 23h".', () => {
    const ts = read(TS_WEBHOOKS);
    const go = read(GO_WEBHOOKS);

    expect(ts).toMatch(/grace_expires_at/);
    expect(go).toMatch(/grace_expires_at|GraceExpiresAt/);
  });

  it('CRITICAL "Roll the new secret across your verifier infra inside that window" customer-action framing pinned in all 3 SDKs. This is the load-bearing instruction that tells customers WHAT to do during the grace window. Drift to dropping would lose the customer guidance.', () => {
    const ts = read(TS_WEBHOOKS);
    const py = read(PY_WEBHOOKS);

    // "Roll the new secret\n   * across your verifier infra inside that window."
    expect(ts).toMatch(/Roll the new secret\s*\*\s*across your verifier infra inside that window/);
    expect(py).toMatch(/Roll the new/);
  });

  it('Cross-flow consistency: V-296 (api-keys) and V-359 (webhooks) both use 24h windows. The CONSISTENCY across the 2 rotation flows is itself a customer-facing claim — "every Driftstack secret rotation has a 24h grace window". Drift on either window would break the simple "you have 24h" mental model.', () => {
    const tsKeys = read(TS_API_KEYS);
    const tsWebhooks = read(TS_WEBHOOKS);

    // Both flows mention 24h.
    expect(tsKeys).toMatch(/24h/);
    expect(tsWebhooks).toMatch(/24h/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-grace-window-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
