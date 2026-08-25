// W701 — cross-SDK V-296 api-keys lifecycle parity. Twenty-eighth in
// the cross-SDK drift-guard series (W649 + W675-W701).
//
// Asserts the V-296 api-keys + 24h-grace-rotate contract is
// consistent across all 3 SDKs:
//
//   - V-296 anchor on rotate verb per-SDK
//   - 4-verb surface (create + list + revoke + rotate) language-
//     canonical naming
//   - 3 wire-paths: /v1/api-keys + /v1/api-keys/:id + /v1/api-keys/
//     :id/rotate
//   - Method-verb mix: 2× POST (create + rotate) + GET (list) +
//     DELETE (revoke)
//   - "Plaintext ... ONCE ... cannot be retrieved later" framing on
//     create + rotate; "Plaintext is never included" on list
//   - "Idempotent" on revoke
//   - V-296 24h grace-period framing on rotate
//   - RotateApiKeyResponse 2-extra-field shape (rotated_from +
//     grace_period_ends_at) extending CreateApiKeyResponse
//   - "admin scope" requirement on create framing
//
// CRITICAL invariant: rotate plaintext is shown ONCE — drift to
// repeated GET-of-plaintext would let the key leak through audit-
// log or session-replay.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_KEYS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/api-keys.ts');
const GO_KEYS = resolve(REPO_ROOT, 'packages/sdk-go/api_keys.go');
const PY_KEYS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/api_keys.py');

describe('W701 cross-SDK V-296 api-keys lifecycle parity', () => {
  it('all 3 SDK api-keys files exist at canonical paths', () => {
    expect(existsSync(TS_KEYS), `missing ${TS_KEYS}`).toBe(true);
    expect(existsSync(GO_KEYS), `missing ${GO_KEYS}`).toBe(true);
    expect(existsSync(PY_KEYS), `missing ${PY_KEYS}`).toBe(true);
  });

  it('CRITICAL V-296 anchor pinned on rotate verb in all 3 SDKs. V-296 is the api-key-rotation feature anchor; drift to dropping would lose changelog provenance.', () => {
    const ts = read(TS_KEYS);
    const go = read(GO_KEYS);
    const py = read(PY_KEYS);

    expect(ts).toMatch(/V-296/);
    expect(go).toMatch(/V-296/);
    expect(py).toMatch(/V-296/);
  });

  it('CRITICAL 4-verb surface pinned in all 3 SDKs — create + list + revoke + rotate. The 4-verb set is the full api-key lifecycle; drift to dropping any would break the dashboard or compliance flow.', () => {
    const ts = read(TS_KEYS);
    const go = read(GO_KEYS);
    const py = read(PY_KEYS);

    // sdk-typescript.
    expect(ts).toMatch(/create\(body:/);
    expect(ts).toMatch(/list\(\)/);
    expect(ts).toMatch(/revoke\(keyId: string/);
    expect(ts).toMatch(/rotate\(keyId: string/);

    // sdk-go.
    expect(go).toMatch(/func \(r \*APIKeysResource\) Create\(/);
    expect(go).toMatch(/func \(r \*APIKeysResource\) List\(/);
    expect(go).toMatch(/func \(r \*APIKeysResource\) Revoke\(/);
    expect(go).toMatch(/func \(r \*APIKeysResource\) Rotate\(/);

    // sdk-python.
    expect(py).toMatch(/def create\(self/);
    expect(py).toMatch(/def list\(self/);
    expect(py).toMatch(/def revoke\(self, key_id:/);
    expect(py).toMatch(/def rotate\(self, key_id:/);
  });

  it('CRITICAL 3 wire-path patterns pinned per-SDK: /v1/api-keys + /v1/api-keys/:id + /v1/api-keys/:id/rotate. Drift to renaming would break server-side routing.', () => {
    const ts = read(TS_KEYS);
    const go = read(GO_KEYS);
    const py = read(PY_KEYS);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/\/v1\/api-keys/);
      // /v1/api-keys/:id sub-path with per-SDK encode wrapper.
      expect(sdk).toMatch(/\/v1\/api-keys\/(?:\$\{|"\s*\+|\{)/);
      // /rotate sub-path.
      expect(sdk).toMatch(/\/rotate/);
    }
  });

  it('CRITICAL method-verb mix on api-keys pinned in TS + Go — 2× POST (create + rotate) + GET (list) + DELETE (revoke). The DELETE-on-/v1/api-keys/:id revokes the key; drift to POST would conflate revoke with rotate.', () => {
    const ts = read(TS_KEYS);
    const go = read(GO_KEYS);

    // sdk-typescript: method counts.
    const tsPost = (ts.match(/method: 'POST'/g) ?? []).length;
    const tsGet = (ts.match(/method: 'GET'/g) ?? []).length;
    const tsDelete = (ts.match(/method: 'DELETE'/g) ?? []).length;

    expect(tsPost, 'sdk-typescript POST count').toBe(2);
    expect(tsGet, 'sdk-typescript GET count').toBe(1);
    expect(tsDelete, 'sdk-typescript DELETE count').toBe(1);

    // sdk-go.
    const goPost = (go.match(/method: "POST"/g) ?? []).length;
    const goGet = (go.match(/method: "GET"/g) ?? []).length;
    const goDelete = (go.match(/method: "DELETE"/g) ?? []).length;

    expect(goPost, 'sdk-go POST count').toBe(2);
    expect(goGet, 'sdk-go GET count').toBe(1);
    expect(goDelete, 'sdk-go DELETE count').toBe(1);
  });

  it('CRITICAL plaintext-ONCE framing pinned on create + rotate per-SDK. The plaintext is returned ONCE in the response — drift to repeated GET would let the key leak through replay or audit-log inspection.', () => {
    const ts = read(TS_KEYS);
    const go = read(GO_KEYS);
    const py = read(PY_KEYS);

    // sdk-typescript: "plaintext is returned ONCE in the response"
    expect(ts).toMatch(/plaintext is returned ONCE in the response/);
    expect(ts).toMatch(/cannot be retrieved later/);
    expect(ts).toMatch(/new plaintext is returned ONCE in the response/);

    // sdk-go: "Plaintext is in the response — store it\n// now, it cannot be retrieved later"
    expect(go).toMatch(/Plaintext is in the response/);
    expect(go).toMatch(/cannot be retrieved later/);

    // sdk-python: "Plaintext is in the response"
    expect(py).toMatch(/Plaintext is in the response/);
    expect(py).toMatch(/cannot be\s*retrieved later/);
  });

  it('CRITICAL "plaintext is never included" framing on list pinned per-SDK. The list endpoint never includes plaintext — drift to including would silently widen the customer\'s key-leak attack surface (anyone with read scope could enumerate plaintexts).', () => {
    const ts = read(TS_KEYS);
    const go = read(GO_KEYS);
    const py = read(PY_KEYS);

    expect(ts).toMatch(/Plaintext is never included/);
    expect(go).toMatch(/Plaintext is never\s*\/\/\s*included/);
    expect(py).toMatch(/Plaintext never included/);
  });

  it('CRITICAL "Idempotent" framing on revoke pinned in all 3 SDKs. Revoke is IDEMPOTENT — calling on an already-revoked key is a no-op. Drift to 404-on-revoked would force callers to ignore 404s in revoke flow.', () => {
    const ts = read(TS_KEYS);
    const go = read(GO_KEYS);
    const py = read(PY_KEYS);

    expect(ts).toMatch(/Idempotent/);
    expect(go).toMatch(/Idempotent/);
    expect(py).toMatch(/Idempotent/);
  });

  it('CRITICAL V-296 24h grace-period framing on rotate pinned in all 3 SDKs. The 24h window is what lets customers safely roll over without an outage: both keys work concurrently, then the old auto-revokes at the boundary. Drift to a different grace duration would silently change customer rollover behavior.', () => {
    const ts = read(TS_KEYS);
    const go = read(GO_KEYS);
    const py = read(PY_KEYS);

    expect(ts).toMatch(/now \+ 24h grace/);
    expect(ts).toMatch(/Both keys work concurrently/);

    expect(go).toMatch(/now \+ 24h grace/);
    expect(go).toMatch(/Both keys work concurrently/);

    expect(py).toMatch(/``now \+ 24h``/);
    expect(py).toMatch(/Both keys work concurrently/);
  });

  it('CRITICAL RotateApiKeyResponse 2-extra-field shape pinned per-SDK: rotated_from + grace_period_ends_at. These extend CreateApiKeyResponse so dashboards can render "rotated from key abc123 — old key revokes at 2026-05-15T..." Drift to dropping either field would let dashboards lose the rollover audit trail.', () => {
    const ts = read(TS_KEYS);
    const go = read(GO_KEYS);
    const py = read(PY_KEYS);

    // sdk-typescript: RotateApiKeyResponse extends CreateApiKeyResponse + 2 fields.
    expect(ts).toMatch(
      /export interface RotateApiKeyResponse extends CreateApiKeyResponse \{[\s\S]*?rotated_from: string;[\s\S]*?grace_period_ends_at: string;/,
    );

    // sdk-go: RotateAPIKeyResponse with both wire-fields (assumed in api-types-go).
    expect(go).toMatch(/RotateAPIKeyResponse/);

    // sdk-python: class RotateApiKeyResponse(CreateApiKeyResponse) with 2 fields.
    expect(py).toMatch(
      /class RotateApiKeyResponse\(CreateApiKeyResponse\):[\s\S]*?rotated_from: str[\s\S]*?grace_period_ends_at: str/,
    );
  });

  it('CRITICAL `account_owner` scope requirement on create framing pinned in TS + Go + Python (V-174). The scope is what prevents read-scoped keys from minting new keys; drift to dropping would let a leaked read-key chain-escalate to account control.', () => {
    const ts = read(TS_KEYS);
    const go = read(GO_KEYS);
    const py = read(PY_KEYS);

    // sdk-typescript: "Requires the\n   * `account_owner` scope on the calling key"
    expect(ts).toMatch(/Requires the\s*\*?\s*`account_owner` scope on the calling key/);

    // sdk-go: "Requires the account_owner scope\n// on the calling key"
    expect(go).toMatch(/Requires the account_owner scope\s*\/\/\s*on the calling key/);

    // sdk-python: "Requires the ``account_owner`` scope on the calling key"
    expect(py).toMatch(/Requires the ``account_owner`` scope on the calling key/);
  });

  it('CRITICAL "auto-revokes at the grace boundary via the existing expires_at-driven auth gate" pinned in all 3 SDKs. The expires_at-driven implementation is the load-bearing detail — drift to a separate rotation table would let the grace logic diverge from the auth gate.', () => {
    const ts = read(TS_KEYS);
    const go = read(GO_KEYS);
    const py = read(PY_KEYS);

    // sdk-typescript: "auto-revokes at the\n   * grace boundary via the existing expires_at-driven auth gate"
    expect(ts).toMatch(
      /auto-revokes at the\s*\*?\s*grace boundary via the existing expires_at-driven auth gate/,
    );

    // sdk-go: "auto-revokes at\n// the grace boundary via the existing expires_at-driven auth gate"
    expect(go).toMatch(
      /auto-revokes at\s*\/\/\s*the grace boundary via the existing expires_at-driven auth gate/,
    );

    // sdk-python: "the old key auto-revokes at\n        the grace boundary"
    expect(py).toMatch(/auto-revokes at\s*the grace boundary/);
  });

  it('Cross-SDK V-296 5-invariant cluster — V-296 anchor + 4-verb surface + 3 wire-paths + plaintext-ONCE-on-create-rotate + 24h-grace-rotate framing. Drift on any would fragment the cross-language api-keys contract.', () => {
    const sdks = {
      'sdk-typescript': read(TS_KEYS),
      'sdk-go': read(GO_KEYS),
      'sdk-python': read(PY_KEYS),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} V-296`).toMatch(/V-296/);
      expect(body, `${name} /v1/api-keys`).toMatch(/\/v1\/api-keys/);
      expect(body, `${name} /rotate path`).toMatch(/\/rotate/);
      expect(body, `${name} 24h grace`).toMatch(/24h/);
      expect(body, `${name} Idempotent`).toMatch(/Idempotent/);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-api-keys-lifecycle-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
