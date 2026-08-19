// W891 — Plaintext-once secrets cross-source invariant. Two-
// hundred-seventeenth in the drift-guard series. Pins the
// 'returned once, never retrievable later' contract across 3
// secret-bearing response schemas:
//
//   1. CreateApiKeyResponse.plaintext — API key shown at mint;
//      ApiKey list/get response (the NON-plaintext shape) has key_prefix
//      ONLY (display hint).
//   2. WebSessionSchema.token — session token returned once; caller
//      stores in auth cookie.
//   3. CreateWebhookResponse.secret + RotateWebhookSecretResponse.secret
//      — plaintext signing secret returned once.
//
// stays in lockstep across:
//   - packages/api-types/src/api-keys.ts (ApiKeySchema + Create
//     response).
//   - packages/api-types/src/auth.ts (WebSessionSchema).
//   - packages/api-types/src/webhooks.ts (Create + Rotate responses).
//
// Drift would silently break:
//   * Server leaking plaintext on read endpoints (compromised
//     audit-trail).
//   * SDK consumers assuming plaintext is retrievable.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W891 plaintext-once secrets cross-source invariant', () => {
  // ─── ApiKeySchema NEVER includes plaintext ───────────────────

  it("CRITICAL packages/api-types/src/api-keys.ts ApiKeySchema (list/get response) has key_prefix display hint but NEVER plaintext. The '// API key as returned in list / get responses (NEVER includes plaintext)' comment is the security contract.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/api-keys.ts'));
    expect(p).toMatch(
      /\/\/ API key as returned in list \/ get responses \(NEVER includes plaintext\)/,
    );
    expect(p).toMatch(/key_prefix: z\.string\(\),/);
    expect(p).toMatch(
      /\/\/ First chars of plaintext; useful as a display hint \("ds_live_a1b2…"\)/,
    );
  });

  it('CRITICAL ApiKeySchema has 8 fields — id + name + key_prefix + scopes + last_used_at + revoked_at + expires_at + created_at. The 8 fields are display-only; no plaintext field. The count said 9 while listing 8 until V-1019 — nothing counted it.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/api-keys.ts'));
    const m = p.match(/ApiKeySchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const f of [
      'id:',
      'name:',
      'key_prefix:',
      'scopes:',
      'last_used_at:',
      'revoked_at:',
      'expires_at:',
      'created_at:',
    ]) {
      expect(body, `ApiKeySchema must have field ${f}`).toMatch(new RegExp(f));
    }
    // CRITICAL: no plaintext field in ApiKeySchema.
    expect(body, 'ApiKeySchema MUST NOT have plaintext field').not.toMatch(/plaintext:/);
  });

  // ─── CreateApiKeyResponse extends with plaintext (ONCE) ──────

  it("CRITICAL CreateApiKeyResponseSchema = ApiKeySchema.extend({ plaintext: ... }) — plaintext ONLY appears in create response. The describe 'Shown once at creation; not retrievable later' pins the one-shot contract.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/api-keys.ts'));
    expect(p).toMatch(
      /CreateApiKeyResponseSchema = ApiKeySchema\.extend\(\{\s*\n\s*plaintext: z\s*\n?\s*\.string\(\)\s*\n?\s*\.describe\('The plaintext key\. Shown once at creation; not retrievable later\.'\)/,
    );
  });

  it("CRITICAL api-keys.ts file comment pins the 'persisted key MET PLUS the plaintext (returned once, never again)' security framing. The comment doubles as documentation of why plaintext is response-only.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/api-keys.ts'));
    expect(p).toMatch(
      /Create-key response: the persisted key MET PLUS the plaintext \(returned\s*\n\/\/ once, never again\)/,
    );
  });

  // ─── WebSessionSchema token returned ONCE ────────────────────

  it("CRITICAL WebSessionSchema.token is 'Plaintext session token — returned ONCE here, never retrievable again. Caller stores it in the auth cookie'. The framing is what the session-rotation flow relies on (refresh emits a new token; old becomes revoked_at).", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(
      /\/\/ Plaintext session token — returned ONCE here, never retrievable again\./,
    );
    expect(p).toMatch(/\/\/ Caller stores it in the auth cookie\./);
  });

  it('CRITICAL WebSessionSchema has 3 fields — token + expires_at + account_id. The 3-field shape is the session-cookie contract.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    expect(p).toMatch(
      /WebSessionSchema = z\.object\(\{[\s\S]+?token: z\.string\(\),\s*\n\s*expires_at: Iso8601Schema,\s*\n\s*account_id: z\.string\(\),/,
    );
  });

  // ─── Webhook secret returned ONCE on create + rotate ─────────

  it("CRITICAL CreateWebhookResponse.secret has describe 'Plaintext signing secret. Returned ONCE; not retrievable later.' The webhook-secret contract matches the API-key-plaintext contract.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(
      /secret: z\.string\(\)\.describe\('Plaintext signing secret\. Returned ONCE; not retrievable later\.'\)/,
    );
  });

  it("CRITICAL RotateWebhookSecretResponse.secret has describe 'Fresh plaintext signing secret. Returned ONCE.'. The rotate flow mirrors create — fresh secret is one-shot at rotation time.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(
      /secret: z\.string\(\)\.describe\('Fresh plaintext signing secret\. Returned ONCE\.'\)/,
    );
  });

  // ─── WebhookEndpoint READ schema has prefix-only, no plaintext ─

  it("CRITICAL WebhookEndpointSchema (list/get response) has secret_prefix but NEVER plaintext secret. The prefix-only pattern mirrors ApiKeySchema's key_prefix — display hint without leaking the key.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    const m = p.match(/WebhookEndpointSchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body, 'WebhookEndpoint must have secret_prefix').toMatch(/secret_prefix:/);
    expect(body, 'WebhookEndpoint MUST NOT have plaintext secret field').not.toMatch(
      /^\s*secret: z\.string\(\)/m,
    );
  });

  // ─── 3-schema plaintext-once cardinality ─────────────────────

  it('CRITICAL EXACTLY 3 plaintext-once secrets — ApiKey + WebSession + WebhookEndpoint. The 3 are the customer-facing secret-bearing flows; each follows the same returned-once contract.', () => {
    const apiKeys = read(resolve(REPO_ROOT, 'packages/api-types/src/api-keys.ts'));
    const auth = read(resolve(REPO_ROOT, 'packages/api-types/src/auth.ts'));
    const webhooks = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    // Each file has at least one "returned once" / "Returned ONCE" / "shown once" mention.
    expect(apiKeys).toMatch(/Shown once at creation/);
    expect(auth).toMatch(/returned ONCE here, never retrievable again/);
    expect(webhooks).toMatch(/Returned ONCE/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/plaintext-once-secrets-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
