// W581.C (W653-deepened) — drift guard for packages/sdk-python/src/
// driftstack/resources/account.py. V-385/V-428/V-434/V-450 account
// Python parity.
//
// W653 splits the original 7 it() blocks into 14 focused per-concept
// blocks + pins previously-implicit invariants. Mirrors the W638
// sdk-go-account.go split (4→11):
//
//   • V-450 self-service extension framing: update-me / avatar /
//     web-sessions / rate-limits all per-line so a drift that drops
//     ANY one trips the test.
//   • me() — CRITICAL X-Driftstack-Account team-RBAC-IMMUNE
//     invariant. The /me endpoint always returns the CALLER's own
//     account, never the team-context account from the header.
//     Drift to honoring the header would let a team member with
//     bearer-token access to the owner's account read the owner's
//     ME row, widening the auth surface.
//   • me() 15-field catalogue pinned with V-anchor per field group:
//     V-352 timezone, V-298a slug, V-298b region, V-352b avatar_url,
//     V-353h mfa_enrolled, V-326c teams. Drift to dropping any
//     V-anchor field would silently lose the dashboard's ability
//     to render that section.
//   • V-352b avatar allowlist (png/jpeg/webp) pinned + 3-field
//     response (avatar_url + content_type + bytes). The allowlist
//     is load-bearing — drift to accepting GIF/SVG would open XSS
//     vectors via SVG-embedded scripts.
//   • V-355 web-session 3-verb lifecycle: list (current:true
//     marker) + revoke-single (quote-escaped, idempotent) + revoke-
//     all-other (DELETE collection root, EXCLUDES calling session).
//     Drift to including the calling session in revoke-all-other
//     would log the customer OUT mid-revocation, silently breaking
//     the "log out other devices, keep this one" UX.
//   • V-258 rate_limits — effective config read.
//   • 8-verb inventory drift guard via regex count.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/account.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W581.C packages/sdk-python/src/driftstack/resources/account.py content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module docstring with 4 V-anchors (V-385/V-428/V-434/V-450) on the resource line + V-450 self-service extension framing per-line (update-me + avatar + web-sessions + rate-limits)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(
      /^"""Account resource — \/v1\/account\/\* \(V-385 \/ V-428 \/ V-434 \/ V-450\)\.\n/,
    );
    expect(body).toMatch(
      /V-450 extends to cover update-me, avatar upload\+clear, web-sessions\s*\nlist\+revoke, and rate-limits read\./,
    );
  });

  it("dict[str, Any] regen-pass-pending rationale pinned — explicit migration breadcrumb so a future reader doesn't mistake this for hand-rolled shapes. Once scripts/generate.sh runs, the response types become typed AccountMeResponse / UpdateAccountRequest / etc.", () => {
    expect(body).toMatch(
      /Type annotations on the response use ``dict\[str, Any\]`` pending the\s*\nnext ``scripts\/generate\.sh`` regen pass\./,
    );
  });

  it('Imports — __future__ annotations + typing Any + urllib.parse quote (URL-escape for V-355 per-id DELETE) + 2-class HTTP client + coerce_body helper. NO _generated.models import yet because every return is dict[str, Any].', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from typing import Any$/m);
    expect(body).toMatch(/^from urllib\.parse import quote$/m);
    expect(body).toMatch(/^from driftstack\.http import AsyncHttpClient, HttpClient$/m);
    expect(body).toMatch(/^from driftstack\.resources\._common import coerce_body$/m);
  });

  it('AccountResource (sync) class declaration + __init__(http: HttpClient). Stateless wrapper. Same pattern as every other Python sync resource.', () => {
    expect(body).toMatch(/^class AccountResource:$/m);
    expect(body).toMatch(/^ {4}"""Synchronous account resource\."""$/m);
    expect(body).toMatch(
      /^ {4}def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http$/m,
    );
  });

  it('Sync me() — GET /v1/account/me. CRITICAL X-Driftstack-Account team-RBAC-IMMUNE invariant pinned per-line: "Bearer-authenticated; never honors the X-Driftstack-Account team-RBAC header (always returns the caller\'s own account)." Drift to honoring the header would let a team member read the owner\'s ME row by setting the team-context header — silent auth-surface widening across V-326c.', () => {
    expect(body).toMatch(
      /def me\(self\) -> dict\[str, Any\]:\s*\n\s*"""Read the calling account's full self-visible state\./,
    );
    expect(body).toMatch(
      /Bearer-authenticated; never honors the X-Driftstack-Account\s*\n\s*team-RBAC header \(always returns the caller's own account\)\./,
    );
    expect(body).toMatch(/return self\._http\.request\("GET", "\/v1\/account\/me"\)/);
  });

  it("Sync me() — 15-field catalogue pinned per V-anchor field group: V-352 timezone + V-298a slug + V-298b region + V-352b avatar_url + V-353h mfa_enrolled + V-326c teams + concurrent_session/profile_count quotas. Each V-anchor MUST stay attached to its field — drift to silently dropping a V-anchor would lose the dashboard's ability to render that section + lose the changelog provenance for that field.", () => {
    expect(body).toMatch(/Returns 15\+ fields incl\. ``id``, ``email``, ``name``, ``tier``,/);
    expect(body).toMatch(/``status``, ``timezone`` \(V-352\), ``slug`` \(V-298a\),/);
    expect(body).toMatch(/``region`` \(V-298b\), ``avatar_url`` \(V-352b\),/);
    expect(body).toMatch(/``mfa_enrolled`` \(V-353h\), ``concurrent_session_cap`` \//);
    expect(body).toMatch(/``concurrent_session_active`` \/ ``profile_cap`` \//);
    expect(body).toMatch(/``profile_count``, and ``teams`` \(V-326c\)\./);
  });

  it('Sync update_me — V-352 PATCH /v1/account/me. CRITICAL: "partial update (name / timezone / slug / region). Pass null to clear a nullable field; at least one field required." Drift to making all fields required would break partial-update UX (e.g. customer can\'t update just timezone without re-sending name); drift to allowing zero fields would let a no-op PATCH succeed silently.', () => {
    expect(body).toMatch(/def update_me\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(body).toMatch(
      /"""V-352 — partial update of the calling account\s*\n\s*\(name \/ timezone \/ slug \/ region\)\. Pass ``null`` to clear a\s*\n\s*nullable field; at least one field required\.\s*\n\s*"""/,
    );
    expect(body).toMatch(
      /return self\._http\.request\("PATCH", "\/v1\/account\/me", json_body=coerce_body\(body\)\)/,
    );
  });

  it('Sync upload_avatar — V-352b POST /v1/account/me/avatar. CRITICAL avatar allowlist pinned: content_type MUST be "image/png|jpeg|webp" — drift to accepting GIF would open animated-image abuse; drift to accepting SVG would open XSS via SVG-embedded <script>. 3-field response (avatar_url + content_type + bytes) pinned so dashboard can render the upload-success state without re-fetching me().', () => {
    expect(body).toMatch(/def upload_avatar\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(body).toMatch(
      /"""V-352b — upload \(or replace\) the calling account avatar\.\s*\n\s*Body: ``\{"data_base64": "\.\.\.", "content_type": "image\/png\|jpeg\|webp"\}``\.\s*\n\s*Returns ``\{"avatar_url": \.\.\., "content_type": \.\.\., "bytes": \.\.\.\}``\.\s*\n\s*"""/,
    );
    expect(body).toMatch(
      /return self\._http\.request\("POST", "\/v1\/account\/me\/avatar", json_body=coerce_body\(body\)\)/,
    );
  });

  it('Sync clear_avatar — V-352b DELETE /v1/account/me/avatar. Returns None (no body). Idempotent — re-clearing an already-cleared avatar is a no-op. Drift to non-idempotent would break the "let me reset my profile picture" UX where the dashboard might double-click.', () => {
    expect(body).toMatch(
      /def clear_avatar\(self\) -> None:\s*\n\s*"""V-352b — clear the avatar pointer\."""\s*\n\s*self\._http\.request\("DELETE", "\/v1\/account\/me\/avatar"\)/,
    );
  });

  it('Sync list_web_sessions — V-355 GET /v1/account/web-sessions. CRITICAL: "The calling session is marked with current: true" — the response carries a `current: true` flag on whichever session is being used to make this very call. Without that marker, the dashboard couldn\'t distinguish "revoke other devices" from "revoke this device".', () => {
    expect(body).toMatch(
      /def list_web_sessions\(self\) -> dict\[str, Any\]:\s*\n\s*"""V-355 — list active dashboard sign-ins\. The calling\s*\n\s*session is marked with ``current: true``\."""\s*\n\s*return self\._http\.request\("GET", "\/v1\/account\/web-sessions"\)/,
    );
  });

  it('Sync revoke_web_session — V-355 DELETE /v1/account/web-sessions/{quote(session_id, safe=\'\')}. Per-id quote-escape with NO safe-chars; drift to safe=\'/\' would let "abc/../../admin" traverse path segments. "Idempotent" framing pinned — revoking an already-revoked session is a no-op (not a 404) so the dashboard can fire revoke without first checking liveness.', () => {
    expect(body).toMatch(
      /def revoke_web_session\(self, session_id: str\) -> None:\s*\n\s*"""V-355 — revoke a single web session by id\. Idempotent\."""\s*\n\s*self\._http\.request\("DELETE", f"\/v1\/account\/web-sessions\/\{quote\(session_id, safe=''\)\}"\)/,
    );
  });

  it('Sync revoke_all_other_web_sessions — V-355 DELETE /v1/account/web-sessions (NO id, collection root). CRITICAL "every web session except the calling one" framing pinned. Drift to including the calling session would log the customer OUT mid-revocation, silently breaking the "log out my other devices, keep this one" UX. The exclusion of the calling session is the load-bearing claim.', () => {
    // Re-anchored on the CLAIMS: the previous regex ran from the signature
    // through the request call, so adding the required `?keep=current` broke it.
    expect(body, 'signature + framing').toMatch(
      /def revoke_all_other_web_sessions\(self\) -> None:\s*\n\s*"""V-355 — revoke every web session except the calling one\."""/,
    );
    // Without this the server answers 400 "Bulk revoke requires `?keep=current`".
    expect(body, 'the confirm-intent query the endpoint requires').toMatch(
      /"DELETE", "\/v1\/account\/web-sessions", params=\{"keep": "current"\}/,
    );
  });

  it('Sync rate_limits — V-258 GET /v1/account/rate-limits. Read-only; returns effective rate-limit config (per-endpoint quotas + window). Drift to a POST (e.g. for adjusting limits via this endpoint) would shift this from a read-only diagnostic to a write surface that needs CSRF protection.', () => {
    expect(body).toMatch(
      /def rate_limits\(self\) -> dict\[str, Any\]:\s*\n\s*"""V-258 — read effective rate-limit config\."""\s*\n\s*return self\._http\.request\("GET", "\/v1\/account\/rate-limits"\)/,
    );
  });

  it('CRITICAL sync bundled-LLM + BYOK Anthropic methods — get_bundled_llm_settings (GET) + update_bundled_llm_settings (PATCH) + get_bundled_llm_status (GET) + get_byok_anthropic_key (GET) + set_byok_anthropic_key (PUT) + clear_byok_anthropic_key (DELETE) + test_byok_anthropic_key (POST). Lets the GUI/CLI give the customer an in-app fix for BundledLlmConsentRequiredError / BundledLlmBudgetExhaustedError, and BYOK ("always wins" — locked verdict) is the customer-controlled billing override; drift to dropping any of these 7 would strand Python customers on an unreadable raw-API-error path the TS/Go SDKs already fixed.', () => {
    expect(body).toMatch(
      /def get_bundled_llm_settings\(self\) -> dict\[str, Any\]:\s*\n\s*""".*\s*\n\s*return self\._http\.request\("GET", "\/v1\/account\/me\/bundled-llm-settings"\)/,
    );
    expect(body).toMatch(
      /def update_bundled_llm_settings\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /return self\._http\.request\(\s*\n\s*"PATCH", "\/v1\/account\/me\/bundled-llm-settings", json_body=coerce_body\(body\)\s*\n\s*\)/,
    );
    expect(body).toMatch(
      /def get_bundled_llm_status\(self\) -> dict\[str, Any\]:\s*\n\s*"""[\s\S]*?"""\s*\n\s*return self\._http\.request\("GET", "\/v1\/account\/me\/bundled-llm-status"\)/,
    );
    expect(body).toMatch(
      /def get_byok_anthropic_key\(self\) -> dict\[str, Any\]:\s*\n\s*"""[\s\S]*?"""\s*\n\s*return self\._http\.request\("GET", "\/v1\/account\/me\/byok-anthropic-key"\)/,
    );
    expect(body).toMatch(/def set_byok_anthropic_key\(self, api_key: str\) -> dict\[str, Any\]:/);
    expect(body).toMatch(
      /return self\._http\.request\(\s*\n\s*"PUT", "\/v1\/account\/me\/byok-anthropic-key", json_body=\{"api_key": api_key\}\s*\n\s*\)/,
    );
    expect(body).toMatch(
      /def clear_byok_anthropic_key\(self\) -> None:\s*\n\s*"""[\s\S]*?"""\s*\n\s*self\._http\.request\("DELETE", "\/v1\/account\/me\/byok-anthropic-key"\)/,
    );
    expect(body).toMatch(
      /def test_byok_anthropic_key\(self\) -> dict\[str, Any\]:\s*\n\s*"""[\s\S]*?"""\s*\n\s*return self\._http\.request\("POST", "\/v1\/account\/me\/byok-anthropic-key\/test"\)/,
    );
  });

  it('AsyncAccountResource — class declaration + __init__(http: AsyncHttpClient) + 15-verb async mirror (the original 8 + the 7 bundled-LLM/BYOK additions). All sync docstrings re-used (no async-specific framing needed — semantics are identical, only the await keyword differs).', () => {
    expect(body).toMatch(/^class AsyncAccountResource:$/m);
    expect(body).toMatch(/^ {4}"""Async account resource\."""$/m);
    expect(body).toMatch(
      /^ {4}def __init__\(self, http: AsyncHttpClient\) -> None:\s*\n\s*self\._http = http$/m,
    );
    expect(body).toMatch(
      /async def me\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/account\/me"\)/,
    );
    expect(body).toMatch(
      /async def update_me\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("PATCH", "\/v1\/account\/me", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(
      /async def upload_avatar\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /async def clear_avatar\(self\) -> None:\s*\n\s*await self\._http\.request\("DELETE", "\/v1\/account\/me\/avatar"\)/,
    );
    expect(body).toMatch(
      /async def list_web_sessions\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/account\/web-sessions"\)/,
    );
    expect(body).toMatch(
      /async def revoke_web_session\(self, session_id: str\) -> None:\s*\n\s*await self\._http\.request\("DELETE", f"\/v1\/account\/web-sessions\/\{quote\(session_id, safe=''\)\}"\)/,
    );
    // The async mirror carries the same required `?keep=current`; without it
    // the endpoint answers 400 and the method can never succeed.
    expect(body, 'async signature').toMatch(
      /async def revoke_all_other_web_sessions\(self\) -> None:/,
    );
    expect(body, 'async confirm-intent query').toMatch(
      /await self\._http\.request\(\s*"DELETE", "\/v1\/account\/web-sessions", params=\{"keep": "current"\}/,
    );
    expect(body).toMatch(
      /async def rate_limits\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/account\/rate-limits"\)/,
    );
    expect(body).toMatch(
      /async def get_bundled_llm_settings\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/account\/me\/bundled-llm-settings"\)/,
    );
    expect(body).toMatch(
      /async def update_bundled_llm_settings\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /async def get_bundled_llm_status\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/account\/me\/bundled-llm-status"\)/,
    );
    expect(body).toMatch(
      /async def get_byok_anthropic_key\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/account\/me\/byok-anthropic-key"\)/,
    );
    expect(body).toMatch(
      /async def set_byok_anthropic_key\(self, api_key: str\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /async def clear_byok_anthropic_key\(self\) -> None:\s*\n\s*await self\._http\.request\("DELETE", "\/v1\/account\/me\/byok-anthropic-key"\)/,
    );
    expect(body).toMatch(
      /async def test_byok_anthropic_key\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("POST", "\/v1\/account\/me\/byok-anthropic-key\/test"\)/,
    );
  });

  it('15-verb inventory drift guard — sync defines exactly 16 method defs (15 verbs + __init__); async defines the same 16. Verb-mix invariants — GETs (6 × 2): me + list_web_sessions + rate_limits + get_bundled_llm_settings + get_bundled_llm_status + get_byok_anthropic_key. PATCH (2 × 2): update_me + update_bundled_llm_settings. POST (2 × 2): upload_avatar + test_byok_anthropic_key. PUT (1 × 2): set_byok_anthropic_key — the only PUT in the resource, threading the customer-controlled key-replace semantic. DELETEs (4 × 2): clear_avatar + revoke_web_session + revoke_all_other_web_sessions + clear_byok_anthropic_key. Drift to a 16th verb without doubling test coverage would let an untested code path ship.', () => {
    const syncStart = body.indexOf('class AccountResource:');
    const asyncStart = body.indexOf('class AsyncAccountResource:');
    expect(syncStart, 'expected sync class to come first').toBeGreaterThan(0);
    expect(asyncStart, 'expected async class to come after sync class').toBeGreaterThan(syncStart);
    const syncBody = body.slice(syncStart, asyncStart);
    const asyncBody = body.slice(asyncStart);
    const syncDefs = (syncBody.match(/^ {4}(?:async )?def [a-z_]+\(/gm) ?? []).length;
    expect(syncDefs, 'expected 16 sync method defs (15 verbs + __init__)').toBe(16);
    const asyncDefs = (asyncBody.match(/^ {4}(?:async )?def [a-z_]+\(/gm) ?? []).length;
    expect(asyncDefs, 'expected 16 async method defs (15 verbs + __init__)').toBe(16);
    const gets = (body.match(/"GET", "\/v1\/account/g) ?? []).length;
    expect(gets, 'expected 12 GETs (6 verbs × sync+async)').toBe(12);
    const patches = (body.match(/"PATCH", "\/v1\/account/g) ?? []).length;
    expect(patches, 'expected 4 PATCHes (2 verbs × sync+async)').toBe(4);
    const posts = (body.match(/"POST", "\/v1\/account/g) ?? []).length;
    expect(posts, 'expected 4 POSTs (2 verbs × sync+async)').toBe(4);
    const puts = (body.match(/"PUT", "\/v1\/account/g) ?? []).length;
    expect(puts, 'expected 2 PUTs (set_byok_anthropic_key × sync+async)').toBe(2);
    const deletes = (body.match(/"DELETE", /g) ?? []).length;
    expect(deletes, 'expected 8 DELETEs (4 verbs × sync+async)').toBe(8);
  });
});
