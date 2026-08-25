// W428.A (W659-deepened) — drift guard for packages/sdk-typescript/
// src/resources/api-keys.ts. V-296 ApiKeysResource TS parity.
//
// W659 splits the original 11 it() blocks into 18 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • V-296 24h grace window — pinned per-line: "sets the OLD key's
//     expires_at to now + 24h grace" + "Both keys work concurrently
//     during the grace window" + "old key auto-revokes at the grace
//     boundary via the existing expires_at-driven auth gate". Drift
//     to a different window (12h / 48h) or dropping the dual-key-
//     concurrent claim would silently change rotation semantics
//     that customers anchor their deploy timelines on.
//   • Plaintext-shown-ONCE invariant — pinned on BOTH create AND
//     rotate (both responses carry plaintext that cannot be re-read).
//     The customer MUST store the plaintext now; the server stores
//     only a one-way hash. Drift to allowing plaintext re-fetch
//     would invert the security model.
//   • extends-CreateApiKeyResponse interface inheritance — drift to
//     hand-rolling RotateApiKeyResponse fields would lose the
//     plaintext + id fields the rotate response shares with create.
//   • rotated_from + grace_period_ends_at fields pinned per-line —
//     the 2 fields rotate ADDS over create (so customers can
//     identify the predecessor key + know when it auto-revokes).
//   • RotateApiKeyOptions.name optional with "Defaults to the old
//     name" semantic — drift to making name required would break
//     the "just rotate, keep the rest" call site.
//   • encodeURIComponent on :keyId — 2 occurrences (revoke + rotate)
//     pinned via count assertion. Drift to dropping the escape on
//     either would let "abc/../../admin" traverse path segments.
//   • Idempotent revoke framing — "Idempotent — revoking an already-
//     revoked key is a no-op". Drift to non-idempotent would break
//     the standard cleanup pattern (dashboard fires revoke without
//     pre-checking liveness).
//   • 4-verb inventory + verb-mix invariants.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/api-keys.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W428.A packages/sdk-typescript/src/resources/api-keys.ts content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module header anchor on the resource line', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/\/\/ ApiKeysResource — typed methods for \/v1\/api-keys\./);
  });

  it('Imports — 3 api-types shapes (ApiKey + CreateApiKeyRequest + CreateApiKeyResponse) + HttpClient. The api-types import is load-bearing — drift to hand-rolled local types in this file would diverge from @driftstack/api-types Zod single-source-of-truth and silently fragment the cross-language wire contract.', () => {
    expect(body).toMatch(
      /import type \{ ApiKey, CreateApiKeyRequest, CreateApiKeyResponse \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
  });

  it('ApiKeyList envelope — single field shape (data: ApiKey[]). No pagination because api-keys are a small per-account set; drift to adding has_more / next_cursor would silently change the contract from "list all" to "paginated", which would break the dashboard\'s 1-call key-management UX.', () => {
    expect(body).toMatch(/export interface ApiKeyList \{\s*data: ApiKey\[\];\s*\}/);
  });

  it('V-296 RotateApiKeyResponse doc-comment pinned per-line — covers "Includes the new key\'s plaintext (shown ONCE)" + "the previous key\'s id" + "the timestamp at which the previous key auto-revokes via the existing expires_at-driven auth gate". CRITICAL: the auto-revoke mechanism ("existing expires_at-driven auth gate") is what makes V-296 work without a separate cleanup job — the auth gate already checks expires_at on every request, so setting OLD.expires_at = now+24h is the entire rotation logic on the server side.', () => {
    expect(body).toMatch(
      /\*\s*V-296 — response shape for POST \/v1\/api-keys\/:id\/rotate\. Includes the\s*\*\s*new key's plaintext \(shown ONCE\), the previous key's id, and the\s*\*\s*timestamp at which the previous key auto-revokes via the existing\s*\*\s*expires_at-driven auth gate\./,
    );
  });

  it("RotateApiKeyResponse — extends CreateApiKeyResponse + 2 NEW fields (rotated_from + grace_period_ends_at). CRITICAL: extends-inheritance lets RotateApiKeyResponse share the plaintext + id + name fields with CreateApiKeyResponse without duplicating the shape. Drift to hand-rolling all fields would silently allow the response shapes to diverge if CreateApiKeyResponse adds a field but RotateApiKeyResponse doesn't.", () => {
    expect(body).toMatch(
      /export interface RotateApiKeyResponse extends CreateApiKeyResponse \{\s*rotated_from: string;\s*grace_period_ends_at: string;\s*\}/,
    );
  });

  it('rotated_from + grace_period_ends_at semantic pinned per-field — rotated_from is the previous key\'s id (so customers can confirm which key they\'re replacing); grace_period_ends_at is the ISO timestamp at which the old key stops working (so customers can plan their deploy window). Drift to renaming either would break dashboard rendering of "rotated from key XXX" + "old key revokes in 23h 45m".', () => {
    expect(body).toMatch(/rotated_from: string;/);
    expect(body).toMatch(/grace_period_ends_at: string;/);
  });

  it('RotateApiKeyOptions.name — optional with "Defaults to the old name" semantic. Drift to making name required would break the "just rotate, keep the rest" call site where customers don\'t want to change the human-readable label. Drift to dropping the default-to-old-name semantic would force every rotate call to specify a name.', () => {
    expect(body).toMatch(
      /export interface RotateApiKeyOptions \{\s*\/\*\* Optional new name for the rotated key\. Defaults to the old name\. \*\/\s*name\?: string;\s*\}/,
    );
  });

  it('ApiKeysResource class declaration + private-readonly http constructor field. Stateless wrapper pattern shared with every other TS SDK resource.', () => {
    expect(body).toMatch(/^export class ApiKeysResource \{$/m);
    expect(body).toMatch(/constructor\(private readonly http: HttpClient\) \{\}/);
  });

  it('create verb JSDoc — CRITICAL plaintext-once invariant: "The plaintext is returned ONCE in the response; store it now — it cannot be retrieved later." Also pinned: "Requires the `account_owner` scope on the calling key" (V-174). The scope check is what prevents a non-owner key from minting new keys (privilege escalation guard).', () => {
    expect(body).toMatch(
      /\*\s*Create a new API key\. The plaintext is returned ONCE in the response;\s*\*\s*store it now — it cannot be retrieved later\. Requires the\s*\*\s*`account_owner` scope on the calling key\./,
    );
  });

  it('create verb implementation — POST /v1/api-keys with CreateApiKeyRequest body → Promise<CreateApiKeyResponse>. Single-line wire-mapping; the validation lives on the server side.', () => {
    expect(body).toMatch(
      /create\(body: CreateApiKeyRequest\): Promise<CreateApiKeyResponse> \{\s*return this\.http\.request<CreateApiKeyResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/api-keys',\s*body,\s*\}\);\s*\}/,
    );
  });

  it('list verb — GET /v1/api-keys → Promise<ApiKeyList>. CRITICAL: "Plaintext is never included" on list response. Drift to including plaintext on list would catastrophically leak ALL active keys on every list call.', () => {
    expect(body).toMatch(
      /\/\*\* List all API keys for the current account\. Plaintext is never included\. \*\//,
    );
    expect(body).toMatch(
      /list\(\): Promise<ApiKeyList> \{\s*return this\.http\.request<ApiKeyList>\(\{ method: 'GET', path: '\/v1\/api-keys' \}\);\s*\}/,
    );
  });

  it('revoke verb — DELETE /v1/api-keys/${encodeURIComponent(keyId)} → Promise<void>. CRITICAL "Idempotent — revoking an already-revoked key is a no-op" framing. Drift to non-idempotent (404 on already-revoked) would break the standard cleanup-in-finally pattern where the dashboard fires revoke without first checking liveness. encodeURIComponent wrapping protects against path-traversal via maliciously-crafted keyIds.', () => {
    expect(body).toMatch(
      /\/\*\* Revoke an API key\. Idempotent — revoking an already-revoked key is a no-op\. \*\//,
    );
    expect(body).toMatch(
      /revoke\(keyId: string\): Promise<void> \{\s*return this\.http\.request<void>\(\{\s*method: 'DELETE',\s*path: `\/v1\/api-keys\/\$\{encodeURIComponent\(keyId\)\}`,\s*\}\);\s*\}/,
    );
  });

  it('V-296 rotate verb JSDoc — pinned per-line: (1) "Mints a fresh plaintext + sets the OLD key\'s expires_at to now + 24h grace" (the SERVER-SIDE rotation logic — atomic mint + expires_at update). (2) "Both keys work concurrently during the grace window; deploy the new key, then the old key auto-revokes at the grace boundary via the existing expires_at-driven auth gate" (the CUSTOMER-FACING deploy flow). Drift to a non-24h window OR a non-auto-revoke mechanism would silently change rotation semantics customers anchor their deploy timelines on.', () => {
    expect(body).toMatch(
      /\*\s*V-296 — rotate an API key\. Mints a fresh plaintext \+ sets the OLD key's\s*\*\s*expires_at to now \+ 24h grace\. Both keys work concurrently during the\s*\*\s*grace window; deploy the new key, then the old key auto-revokes at the\s*\*\s*grace boundary via the existing expires_at-driven auth gate\./,
    );
    expect(body).toMatch(
      /\*\s*The new plaintext is returned ONCE in the response — store it now\./,
    );
  });

  it('V-296 rotate verb implementation — POST /v1/api-keys/${encodeURIComponent(keyId)}/rotate with RotateApiKeyOptions body (default-empty `= {}`) → Promise<RotateApiKeyResponse>. Default-empty options lets callers write `apiKeys.rotate(keyId)` without passing options at all (covering the "rotate, keep the old name" common case).', () => {
    expect(body).toMatch(
      /rotate\(keyId: string, options: RotateApiKeyOptions = \{\}\): Promise<RotateApiKeyResponse> \{\s*return this\.http\.request<RotateApiKeyResponse>\(\{\s*method: 'POST',\s*path: `\/v1\/api-keys\/\$\{encodeURIComponent\(keyId\)\}\/rotate`,\s*body: options,\s*\}\);\s*\}/,
    );
  });

  it('encodeURIComponent invariant — keyId URL-escaped in EXACTLY 2 places (revoke DELETE + rotate POST). Drift to dropping the escape on either would let a keyId like "abc/../admin" traverse path segments and reach an unrelated key OR a path outside the api-keys namespace. Count assertion enforces both call sites use the escape.', () => {
    const matches = body.match(/encodeURIComponent\(keyId\)/g);
    expect(matches).not.toBeNull();
    expect((matches ?? []).length, 'expected encodeURIComponent on revoke + rotate').toBe(2);
  });

  it('Plaintext-shown-ONCE invariant pinned across BOTH create AND rotate JSDocs. Both responses carry plaintext that cannot be re-read. Search for "ONCE" or "once" wording — the literal "ONCE" appears exactly 3 times (create JSDoc + V-296 interface JSDoc + rotate JSDoc), enforcing the consistent messaging across all 3 places that mention it.', () => {
    const onceMatches = body.match(/\bONCE\b/g) ?? [];
    expect(
      onceMatches.length,
      'expected literal "ONCE" 3 times (create + V-296 type + rotate)',
    ).toBe(3);
  });

  it('4-verb inventory + verb-mix invariants — exactly 4 method declarations (create + list + revoke + rotate). Verb mix: 2 POSTs (create + rotate) + 1 GET (list) + 1 DELETE (revoke) + ZERO PATCH/PUT. Drift to adding an "update key" PATCH would break the "keys are append-only, rotation replaces" lifecycle invariant.', () => {
    const methods = body.match(/^ {2}(?!constructor)[a-zA-Z]+\(/gm) ?? [];
    expect(methods.length, 'expected 4 verb declarations').toBe(4);
    const posts = (body.match(/method: 'POST'/g) ?? []).length;
    expect(posts, 'expected 2 POSTs (create + rotate)').toBe(2);
    const gets = (body.match(/method: 'GET'/g) ?? []).length;
    expect(gets, 'expected 1 GET (list)').toBe(1);
    const deletes = (body.match(/method: 'DELETE'/g) ?? []).length;
    expect(deletes, 'expected 1 DELETE (revoke)').toBe(1);
    expect(body).not.toMatch(/method: 'PATCH'/);
    expect(body).not.toMatch(/method: 'PUT'/);
  });

  it('Wire-path inventory — exactly 3 DISTINCT path templates: bare /v1/api-keys (create + list) + /v1/api-keys/${keyId} (revoke) + /v1/api-keys/${keyId}/rotate (rotate). The per-id base + per-id-action pattern; drift to a per-action GET (e.g. /v1/api-keys/${keyId}/details) would break the action-only-on-POST invariant.', () => {
    // Bare path appears 2× (create + list); revoke uses ${keyId} template; rotate uses ${keyId}/rotate template.
    expect(body).toMatch(/path: '\/v1\/api-keys'/);
    expect(body).toMatch(/path: `\/v1\/api-keys\/\$\{encodeURIComponent\(keyId\)\}`/);
    expect(body).toMatch(/path: `\/v1\/api-keys\/\$\{encodeURIComponent\(keyId\)\}\/rotate`/);
  });
});
