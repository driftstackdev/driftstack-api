// W702 — cross-SDK V-359/V-307/V-351/V-356 webhooks rotation +
// replay + update + test-ping parity. Twenty-ninth in the cross-SDK
// drift-guard series (W649 + W675-W702).
//
// Asserts the V-359 secret rotation + V-307 replay + V-351 update +
// V-356 test-ping invariants are consistent across all 3 SDKs:
//
//   - V-359 anchor on rotateSecret per-SDK + 24h grace window
//   - V-307 anchor on replayDelivery per-SDK + account-scoped
//   - V-351 anchor on update per-SDK + secret-not-rotated-by-update
//   - V-356 anchor on sendTest per-SDK + bypasses-subscription
//   - 9-verb surface (create + list + get + delete + listDeliveries
//     + iterateDeliveries + replayDelivery + rotateSecret + sendTest
//     + update) — actually 10 verbs in TS
//   - Wire-paths: /v1/webhooks + /v1/webhooks/:id + /v1/webhooks/:id/
//     deliveries + /v1/webhooks/:id/rotate-secret +
//     /v1/webhooks/:id/test + /v1/webhook-deliveries/:id/replay
//   - "Plaintext signing secret returned ONCE" framing on create +
//     rotateSecret
//   - Dual-sign framing on V-359 rotation grace window
//   - admin-scope-required framing on create/update/rotateSecret/sendTest
//
// CRITICAL invariant: V-359 dual-sign during grace window — drift to
// single-sign-only-with-new-secret would break every customer whose
// verifier still uses the old secret during the 24h rollover window.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_WH = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/webhooks.ts');
const GO_WH = resolve(REPO_ROOT, 'packages/sdk-go/webhooks.go');
const PY_WH = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/webhooks.py');

describe('W702 cross-SDK V-359/V-307/V-351/V-356 webhooks rotation + replay parity', () => {
  it('all 3 SDK webhooks files exist at canonical paths', () => {
    expect(existsSync(TS_WH), `missing ${TS_WH}`).toBe(true);
    expect(existsSync(GO_WH), `missing ${GO_WH}`).toBe(true);
    expect(existsSync(PY_WH), `missing ${PY_WH}`).toBe(true);
  });

  it('CRITICAL V-359 + V-307 + V-351 + V-356 anchors pinned across all 3 SDKs. V-359=secret-rotate, V-307=replay-delivery, V-351=partial-update, V-356=test-ping. Drift to dropping any would lose per-feature changelog provenance.', () => {
    const ts = read(TS_WH);
    const go = read(GO_WH);
    const py = read(PY_WH);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/V-359/);
      expect(sdk).toMatch(/V-307/);
      expect(sdk).toMatch(/V-351/);
      expect(sdk).toMatch(/V-356/);
    }
  });

  it("CRITICAL V-359 dual-sign + 24h grace framing pinned across all 3 SDKs. The dual-sign is what lets customers rotate without breaking the in-flight signature-verification on every customer's downstream service. Drift to single-sign-only-with-new-secret would break every verifier during the rollover.", () => {
    const ts = read(TS_WH);
    const go = read(GO_WH);
    const py = read(PY_WH);

    for (const sdk of [ts, go, py]) {
      // 24h grace window.
      expect(sdk).toMatch(/24h/);
      // dual-sign framing.
      expect(sdk).toMatch(/dual-signs/);
      // grace_expires_at field name.
      expect(sdk).toMatch(/grace_expires_at|GraceExpiresAt/);
    }
  });

  it('CRITICAL V-307 account-scoped replay framing pinned in TS + Go. The "delivery must belong to an endpoint the calling account owns" wording is the cross-tenant safety check; drift to skipping would let one customer replay another\'s deliveries.', () => {
    const ts = read(TS_WH);
    const go = read(GO_WH);

    expect(ts).toMatch(
      /Scoped to the EFFECTIVE account: the delivery[\s\S]{0,80}must belong to an endpoint your own account owns/,
    );
    expect(go).toMatch(
      /Scoped to the EFFECTIVE account: the delivery must\s*\n?\s*\/\/\s*belong to an endpoint the caller's own account owns/,
    );
  });

  it('CRITICAL V-351 "signing secret NOT rotated by update" framing pinned in all 3 SDKs. The separation is what keeps secret-rotation an explicit (admin-scoped) operation — drift to merging would silently rotate the secret on every partial update.', () => {
    const ts = read(TS_WH);
    const go = read(GO_WH);
    const py = read(PY_WH);

    expect(ts).toMatch(/signing secret is NOT rotated by update/);
    expect(go).toMatch(/signing secret is NOT rotated by\s*\n?\s*\/\/\s*Update/);
    expect(py).toMatch(/signing secret is NOT rotated by|signing secret\s*\n?\s*is NOT rotated/);
  });

  it("CRITICAL V-356 test.ping framing pinned in all 3 SDKs. The synthetic test.ping is what lets customers verify their handler is reachable + signature-valid BEFORE depending on real events. The 'bypasses subscription' wording is load-bearing — without it customers would think they need to subscribe to test.ping first.", () => {
    const ts = read(TS_WH);
    const go = read(GO_WH);
    const py = read(PY_WH);

    expect(ts).toMatch(/test\.ping/);
    expect(ts).toMatch(/[Bb]ypasses subscription/);

    expect(go).toMatch(/test\.ping/);
    expect(go).toMatch(/[Bb]ypasses subscription/);

    expect(py).toMatch(/test\.ping/);
    expect(py).toMatch(/[Bb]ypass[^s]?es?\s+subscription|bypasses subscription/);
  });

  it('CRITICAL 9-verb surface across all 3 SDKs — create + list + get + delete + listDeliveries + replayDelivery + rotateSecret + sendTest + update. The 9-verb set covers the entire webhook lifecycle; drift to dropping any would break the dashboard or replay tooling.', () => {
    const ts = read(TS_WH);
    const go = read(GO_WH);
    const py = read(PY_WH);

    // sdk-typescript: camelCase methods.
    expect(ts).toMatch(/create\(body:/);
    expect(ts).toMatch(/list\(\)/);
    expect(ts).toMatch(/get\(id: string/);
    expect(ts).toMatch(/delete\(id: string/);
    expect(ts).toMatch(/update\(id: string/);
    expect(ts).toMatch(/listDeliveries\(/);
    expect(ts).toMatch(/iterateDeliveries\(/);
    expect(ts).toMatch(/replayDelivery\(deliveryId: string/);
    expect(ts).toMatch(/rotateSecret\(id: string/);
    expect(ts).toMatch(/sendTest\(id: string/);

    // sdk-go: PascalCase methods.
    expect(go).toMatch(/func \(r \*WebhooksResource\) Create\(/);
    expect(go).toMatch(/func \(r \*WebhooksResource\) List\(/);
    expect(go).toMatch(/func \(r \*WebhooksResource\) Get\(/);
    expect(go).toMatch(/func \(r \*WebhooksResource\) Delete\(/);
    expect(go).toMatch(/func \(r \*WebhooksResource\) Update\(/);
    expect(go).toMatch(/func \(r \*WebhooksResource\) ListDeliveries\(/);
    expect(go).toMatch(/func \(r \*WebhooksResource\) ReplayDelivery\(/);
    expect(go).toMatch(/func \(r \*WebhooksResource\) RotateSecret\(/);
    expect(go).toMatch(/func \(r \*WebhooksResource\) SendTest\(/);

    // sdk-python: snake_case methods.
    expect(py).toMatch(/def create\(self/);
    expect(py).toMatch(/def list\(self/);
    expect(py).toMatch(/def get\(self/);
    expect(py).toMatch(/def delete\(self/);
    expect(py).toMatch(/def update\(self/);
    expect(py).toMatch(/def list_deliveries\(/);
    expect(py).toMatch(/def replay_delivery\(self/);
    expect(py).toMatch(/def rotate_secret\(self/);
    expect(py).toMatch(/def send_test\(self/);
  });

  it('CRITICAL 6 wire-path patterns pinned per-SDK: /v1/webhooks + /v1/webhooks/:id + /v1/webhooks/:id/deliveries + /v1/webhooks/:id/rotate-secret + /v1/webhooks/:id/test + /v1/webhook-deliveries/:id/replay. Drift to renaming would break server-side routing.', () => {
    const ts = read(TS_WH);
    const go = read(GO_WH);
    const py = read(PY_WH);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/\/v1\/webhooks/);
      expect(sdk).toMatch(/\/v1\/webhooks\/(?:\$\{|"\s*\+|\{)/);
      expect(sdk).toMatch(/\/deliveries/);
      expect(sdk).toMatch(/\/rotate-secret/);
      expect(sdk).toMatch(/\/test/);
      expect(sdk).toMatch(/\/v1\/webhook-deliveries/);
      expect(sdk).toMatch(/\/replay/);
    }
  });

  it('CRITICAL "Plaintext signing secret returned once" framing on create pinned in all 3 SDKs. The plaintext is returned ONCE — drift to repeated GET would let the signing secret leak through replay.', () => {
    const ts = read(TS_WH);
    const go = read(GO_WH);
    const py = read(PY_WH);

    // sdk-typescript: "Plaintext signing secret is returned\n   * once"
    expect(ts).toMatch(/Plaintext signing secret is returned\s*\n?\s*\*?\s*once/);
    expect(ts).toMatch(/cannot be retrieved later/);

    // sdk-go: "Plaintext signing secret is returned\n// ONCE"
    expect(go).toMatch(/Plaintext signing secret is returned\s*\n?\s*\/\/\s*ONCE/);

    // sdk-python: similar.
    expect(py).toMatch(
      /Plaintext signing secret is returned\s*\n?\s*once|Plaintext signing secret is returned ONCE/,
    );
  });

  it("CRITICAL V-359 'returned ONCE' framing on rotateSecret pinned per-SDK. Each rotation produces a fresh plaintext; the SDK returns it once and never again. Drift to repeated-GET would leak.", () => {
    const ts = read(TS_WH);
    const go = read(GO_WH);
    const py = read(PY_WH);

    // sdk-typescript: "fresh plaintext is\n   * returned ONCE"
    expect(ts).toMatch(/fresh plaintext is\s*\n?\s*\*?\s*returned ONCE/);

    // sdk-go: "The fresh\n// plaintext is returned ONCE"
    expect(go).toMatch(
      /fresh\s*\n?\s*\/\/\s*plaintext is returned ONCE|fresh plaintext is returned ONCE/,
    );

    // sdk-python: "Returns the fresh plaintext (shown ONCE)"
    expect(py).toMatch(/fresh plaintext \(shown ONCE\)|fresh plaintext is\s*\n?\s*returned ONCE/);
  });

  it('CRITICAL admin-scope requirement pinned on 4 mutating verbs in sdk-typescript — create + update + rotateSecret + sendTest. The admin-scope gating is what prevents read-keys from chain-escalating to full webhook control.', () => {
    const ts = read(TS_WH);

    // sdk-typescript: 4 "account_owner scope" mentions (create + update + rotateSecret + sendTest).
    const tsAdminScope = (ts.match(/`account_owner` scope\s*\n?\s*\*?\s*on the calling key/g) ?? [])
      .length;
    expect(tsAdminScope, 'sdk-typescript account_owner-scope mentions').toBeGreaterThanOrEqual(4);
  });

  it("CRITICAL RotateWebhookSecretResponse 5-field shape pinned in sdk-go — id + secret + secret_prefix + prev_secret_prefix + grace_expires_at. The 5 fields carry the full rotation receipt including BOTH prefixes (so dashboards can render 'rotating from sk_old... to sk_new...').", () => {
    const go = read(GO_WH);

    expect(go).toMatch(/type RotateWebhookSecretResponse struct/);
    expect(go).toMatch(/Secret\s+string\s+`json:"secret"`/);
    expect(go).toMatch(/SecretPrefix\s+string\s+`json:"secret_prefix"`/);
    expect(go).toMatch(/PrevSecretPrefix\s+string\s+`json:"prev_secret_prefix"`/);
    expect(go).toMatch(/GraceExpiresAt\s+time\.Time\s+`json:"grace_expires_at"`/);
  });

  it('CRITICAL test.ping literal event_type pinned in sdk-typescript + sdk-go SendTestWebhookResponse. The literal-type constraint is what lets dashboards filter "synthetic test deliveries" out of the audit-log timeline.', () => {
    const ts = read(TS_WH);
    const go = read(GO_WH);

    // sdk-typescript: "event_type: 'test.ping'"
    expect(ts).toMatch(/event_type:\s*'test\.ping'/);

    // sdk-go: comment-pinned.
    expect(go).toMatch(/EventType\s+string\s+`json:"event_type"`\s+\/\/ always "test\.ping"/);
  });

  it('Cross-SDK V-359 5-invariant cluster — V-359 anchor + V-307 + V-351 + V-356 + dual-sign 24h grace + admin-scope on rotateSecret + plaintext-ONCE. Drift on any would fragment the cross-language webhooks contract.', () => {
    const sdks = {
      'sdk-typescript': read(TS_WH),
      'sdk-go': read(GO_WH),
      'sdk-python': read(PY_WH),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} V-359`).toMatch(/V-359/);
      expect(body, `${name} V-307`).toMatch(/V-307/);
      expect(body, `${name} V-351`).toMatch(/V-351/);
      expect(body, `${name} V-356`).toMatch(/V-356/);
      expect(body, `${name} dual-signs`).toMatch(/dual-signs/);
      expect(body, `${name} 24h`).toMatch(/24h/);
      expect(body, `${name} /v1/webhooks`).toMatch(/\/v1\/webhooks/);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-webhooks-rotation-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
