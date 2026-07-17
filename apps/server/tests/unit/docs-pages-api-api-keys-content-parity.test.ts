// W762 — apps/docs api/api-keys.md content parity. Eighty-eighth in
// the cross-SDK drift-guard series.
//
// /api/api-keys is the canonical reference for key lifecycle. Drift
// to the "plaintext shown ONCE" + 24h rotate grace + scope catalog
// would let SDK consumers' expectations diverge from server
// enforcement and the W750 dashboard /api-keys surface.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/api-keys.md');

describe('W762 docs /api/api-keys content parity', () => {
  it('api/api-keys.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned. Description matches W760 /api index "create, list, rotate (24-hour grace), revoke" framing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: API keys\n/);
    expect(p).toMatch(
      /description: Create, list, rotate, and revoke API keys via \/v1\/api-keys\./,
    );
  });

  it('CRITICAL Bearer-token framing pinned — "Authorization: Bearer <key>". Matches W760 /api index + W746 server-side api-keys lib.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Driftstack uses bearer-token authentication\. Every API request includes/);
    expect(p).toMatch(/`Authorization: Bearer <key>`/);
  });

  it("CRITICAL plaintext-shown-ONCE-on-create-or-rotate framing pinned. The '**Plaintext is shown ONCE.**' callout + 'Driftstack hashes it server-side and cannot recover it later' wording matches W750 dashboard + W753 webhook + W759 settings shown-ONCE security framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*Plaintext is shown ONCE\.\*\*/);
    expect(p).toMatch(
      /response includes the plaintext value\. Store it now — Driftstack\s*\n?> hashes it server-side and cannot recover it later\./,
    );
    expect(p).toMatch(/If you lose a key,\s*\n?> revoke it and mint a fresh one\./);
  });

  it('CRITICAL POST create-response field set pinned — id/name/key_prefix/scopes/last_used_at/revoked_at/expires_at/created_at/plaintext. Matches W750 dashboard list-row field reads.', () => {
    const p = read(PAGE);

    for (const field of [
      'id',
      'name',
      'key_prefix',
      'scopes',
      'last_used_at',
      'revoked_at',
      'expires_at',
      'created_at',
      'plaintext',
    ]) {
      expect(p, `field ${field}`).toMatch(new RegExp(`"${field}":`));
    }
  });

  it('CRITICAL ds_live_ prefix shown in example pinned. Matches W760 /api index Bearer-prefix pair.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"key_prefix": "ds_live_a1b2c3"/);
    expect(p).toMatch(/"plaintext": "ds_live_a1b2c3secretsecretsecretsecretsec"/);
  });

  it("CRITICAL list-keys plaintext-NEVER-included framing pinned. The 'returns all active and revoked keys for the calling account. Plaintext is never included' wording is the load-bearing security contract — list NEVER returns plaintext.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`GET \/v1\/api-keys` returns all active and revoked keys for the calling\s*\n?account\. Plaintext is never included\./,
    );
  });

  it('CRITICAL rotate 3-step zero-downtime swap pinned. The numbered (1) call rotate (2) deploy new key (3) auto-revoke after grace sequence matches W750 dashboard rotate-confirm framing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/1\. Call rotate on the existing key — receive a new plaintext\./);
    expect(p).toMatch(/2\. Deploy the new key to your applications\./);
    expect(p).toMatch(
      /3\. After all instances are confirmed using the new key, the old key\s*\n?\s+auto-revokes at the grace boundary \(24h from the rotate call\)\./,
    );
  });

  it('CRITICAL rotate response includes rotated_from + grace_period_ends_at fields pinned. Matches W750 dashboard rotate-reveal V-296b 3-field display.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"rotated_from": "key_00000000-0000-4000-8000-000000000001"/);
    expect(p).toMatch(/"grace_period_ends_at": "2026-05-09T10:00:00Z"/);
  });

  it("CRITICAL old-key 401 at grace-boundary framing pinned. The 'After grace_period_ends_at, requests using the old key receive 401 Unauthorized because the existing expires_at-driven auth gate short-circuits. No separate revocation endpoint is needed.' wording is the load-bearing TTL framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /After `grace_period_ends_at`, requests using the old key receive `401\s*\n?Unauthorized` because the existing `expires_at`-driven auth gate/,
    );
    expect(p).toMatch(/No separate revocation endpoint is needed\./);
  });

  it("CRITICAL DELETE idempotent + 204 + cannot-reactivate framing pinned. The 'Idempotent. Revoking an already-revoked key returns the same 204 No Content response. Revoked keys cannot be reactivated; mint a fresh key instead.' wording matches W750 dashboard revoke 204-handling.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Idempotent\. Revoking an already-revoked key returns the same `204 No\s*\n?Content` response\. Revoked keys cannot be reactivated; mint a fresh\s*\n?key instead\./,
    );
  });

  it('CRITICAL 5-scope catalog pinned — read/write/account_owner/gui_control/driftstack_internal_admin. The 5-row table matches V-205 server-side scope enforcement + W750 SCOPE_LABEL map.', () => {
    const p = read(PAGE);

    for (const scope of [
      'read',
      'write',
      'account_owner',
      'gui_control',
      'driftstack_internal_admin',
    ]) {
      expect(p, `scope ${scope}`).toMatch(new RegExp(`\\| \`${scope}\``));
    }
  });

  it("CRITICAL gui_control reserved-for-GUI framing pinned. The 'Reserved for the GUI Client; do not request manually' wording protects against customers requesting the GUI scope on application keys.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Reserved for the GUI Client; do not request manually\./);
  });

  it("CRITICAL driftstack_internal_admin staff-only framing pinned. The 'Internal Driftstack staff scope; never granted to customer accounts' wording is the customer-trust contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Internal Driftstack staff scope; never granted to customer accounts\./);
  });

  it("CRITICAL no-default-scopes + account_owner-only-for-dashboard framing pinned. S36 2026-07-07 (fable-truth-audit): the old 'read + write is the default for new keys' claim was FALSE — CreateApiKeyRequestSchema requires scopes: z.array(...).min(1) (packages/api-types/src/api-keys.ts) and no code path fills in a default; omitting scopes is a 400. Also pins the write-scope row's does-NOT-include-read truth (hasScope never lets `write` satisfy `read`/`read:X`).", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /There is no default scope set — `scopes` is required on create\s*\n?\(at least one entry; omitting it is a `400`\)\./,
    );
    expect(p).toMatch(/Most application\s*\n?keys should request `read` \+ `write` together\./);
    expect(p).toMatch(
      /Mutations \(create\/destroy sessions, profiles, etc\.\)\. Does NOT include read — pair it with `read`\./,
    );
    expect(p).toMatch(
      /Issue\s*\n?`account_owner` only to keys used by the dashboard or operator\s*\n?tooling — application keys do not need it\./,
    );
    // Negative pin — the fictional default must not come back.
    expect(p).not.toMatch(/is the default for new keys/);
  });

  it('CRITICAL 4-endpoint canonical action set pinned — POST/GET/POST-rotate/DELETE. Drift would let SDK URL generation diverge.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`POST \/v1\/api-keys`/);
    expect(p).toMatch(/`GET \/v1\/api-keys`/);
    expect(p).toMatch(/`POST \/v1\/api-keys\/:id\/rotate`/);
    expect(p).toMatch(/`DELETE \/v1\/api-keys\/:id`/);
  });

  it('CRITICAL SDK examples for all 3 languages pinned — TypeScript + Python + Go. Drift to dropping one would force SDK consumers to read inter-language equivalents. All 3 call apiKeys.rotate / api_keys.rotate / APIKeys.Rotate.', () => {
    const p = read(PAGE);

    // TypeScript.
    expect(p).toMatch(/import \{ Driftstack \} from '@driftstack\/sdk';/);
    expect(p).toMatch(/await client\.apiKeys\.rotate\('key_old'/);

    // Python.
    expect(p).toMatch(/from driftstack import Driftstack/);
    expect(p).toMatch(/client\.api_keys\.rotate\("key_old"/);

    // Go.
    expect(p).toMatch(/client\.APIKeys\.Rotate\(/);
    expect(p).toMatch(/&driftstack\.RotateAPIKeyRequest\{Name: "production-2025"\}/);
  });

  it('CRITICAL rotate Python uses `with Driftstack(...) as client` context-manager pattern pinned. Matches sdk-python idiomatic resource-management.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/with Driftstack\(api_key=os\.environ\["DRIFTSTACK_API_KEY"\]\) as client:/);
  });

  it("CRITICAL optional `name` field on rotate framing pinned. The 'Optional name field renames the new key (default: preserves the old name)' wording explains the rename-during-rotate UX.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Optional `name` field renames the new key \(default: preserves the old\s*\n?name\)\./,
    );
  });

  it('CRITICAL customer API keys are paid, Manual is included, and Free can list/revoke but not create/rotate', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Customer API keys require a paid tier/);
    expect(p).toMatch(/Every paid tier, including Manual/);
    expect(p).toMatch(/restricted `ds_test_…` device credential/);
    expect(p).toMatch(/Free dashboard web sessions may still list and revoke/);
    expect(p).toMatch(/create and rotate return the normal RFC 9457 `403 Forbidden`/);
    expect(p).toMatch(/resume after upgrade unless revoked or expired/);
    expect(p).not.toMatch(/feature_not_available/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/docs-pages-api-api-keys-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
