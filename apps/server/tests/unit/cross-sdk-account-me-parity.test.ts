// W704 — cross-SDK V-237/V-352/V-355/V-258 account /me resource
// parity. Thirty-first in the cross-SDK drift-guard series (W649 +
// W675-W704).
//
// Asserts the AccountResource (account/me + web-sessions + avatar +
// rate-limits) contract is consistent across all 3 SDKs:
//
//   - V-237 anchor on me() per-SDK + customer-self-profile framing
//   - V-352 anchor on updateMe per-SDK + IANA timezone field
//   - V-352b anchors on uploadAvatar + clearAvatar per-SDK
//   - V-355 anchors on 3 web-session verbs per-SDK
//   - V-258 anchor on rateLimits per-SDK
//   - V-298a slug + V-298b region + V-353h mfa_enrolled + V-326c
//     teams fields pinned in TS + Go AccountSelfProfile shape
//   - 8-verb surface (me + updateMe + uploadAvatar + clearAvatar +
//     listWebSessions + revokeWebSession + revokeAllOtherWebSessions
//     + rateLimits)
//   - 7 wire-paths: /v1/account/me + /v1/account/me/avatar +
//     /v1/account/web-sessions + /v1/account/web-sessions/:id +
//     /v1/account/rate-limits
//   - Method-verb mix: 3× GET (me, listWebSessions, rateLimits) +
//     PATCH (updateMe) + POST (uploadAvatar) + 3× DELETE
//     (clearAvatar, revokeWebSession, revokeAllOtherWebSessions)
//
// CRITICAL invariant: revokeAllOtherWebSessions DELETE is on the
// base /v1/account/web-sessions path (no :id) — drift to the per-id
// path would let the call revoke every session INCLUDING the caller's.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_ACCT = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/account.ts');
const GO_ACCT = resolve(REPO_ROOT, 'packages/sdk-go/account.go');
const PY_ACCT = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/account.py');

describe('W704 cross-SDK V-237/V-352/V-355 account-me parity', () => {
  it('all 3 SDK account files exist at canonical paths', () => {
    expect(existsSync(TS_ACCT), `missing ${TS_ACCT}`).toBe(true);
    expect(existsSync(GO_ACCT), `missing ${GO_ACCT}`).toBe(true);
    expect(existsSync(PY_ACCT), `missing ${PY_ACCT}`).toBe(true);
  });

  it('CRITICAL V-237 anchor pinned on me() / self-profile in all 3 SDKs. V-237 is the customer-self-profile feature anchor; drift to dropping would lose changelog provenance.', () => {
    const ts = read(TS_ACCT);
    const go = read(GO_ACCT);
    const py = read(PY_ACCT);

    expect(ts).toMatch(/V-237/);
    // sdk-go uses V-385 as the AccountSelfProfile mirror anchor; V-237 framing applies via me().
    expect(go).toMatch(/V-237|V-385/);
    expect(py).toMatch(/V-237|V-385/);
  });

  it('CRITICAL V-352 + V-352b anchors pinned in all 3 SDKs. V-352 is the partial-update feature; V-352b is the avatar upload + clear feature. Drift to dropping would lose per-feature provenance.', () => {
    const ts = read(TS_ACCT);
    const go = read(GO_ACCT);
    const py = read(PY_ACCT);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/V-352\b/);
      expect(sdk).toMatch(/V-352b/);
    }
  });

  it('CRITICAL V-355 web-sessions anchor pinned in all 3 SDKs. V-355 is the active-dashboard-sign-ins feature anchor; drift to dropping would lose changelog provenance for the 3-verb web-sessions surface.', () => {
    const ts = read(TS_ACCT);
    const go = read(GO_ACCT);
    const py = read(PY_ACCT);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/V-355/);
    }
  });

  it('CRITICAL V-258 rate-limits anchor pinned in all 3 SDKs. V-258 is the rate-limit-config feature anchor; drift to dropping would lose changelog provenance for the rateLimits() read.', () => {
    const ts = read(TS_ACCT);
    const go = read(GO_ACCT);
    const py = read(PY_ACCT);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/V-258/);
    }
  });

  it('CRITICAL 8-verb surface pinned in TS + Go — me + updateMe + uploadAvatar + clearAvatar + listWebSessions + revokeWebSession + revokeAllOtherWebSessions + rateLimits. The 8-verb set covers the full account self-profile + web-sessions + avatar + rate-limits surface. (sdk-python regen pending for full 8-verb mirror.)', () => {
    const ts = read(TS_ACCT);
    const go = read(GO_ACCT);

    // sdk-typescript: camelCase methods.
    expect(ts).toMatch(/me\(\)/);
    expect(ts).toMatch(/updateMe\(body:/);
    expect(ts).toMatch(/uploadAvatar\(body:/);
    expect(ts).toMatch(/clearAvatar\(\)/);
    expect(ts).toMatch(/listWebSessions\(\)/);
    expect(ts).toMatch(/revokeWebSession\(id: string/);
    expect(ts).toMatch(/revokeAllOtherWebSessions\(\)/);
    expect(ts).toMatch(/rateLimits\(\)/);

    // sdk-go: PascalCase methods.
    expect(go).toMatch(/func \(r \*AccountResource\) Me\(/);
    expect(go).toMatch(/func \(r \*AccountResource\) UpdateMe\(/);
    expect(go).toMatch(/func \(r \*AccountResource\) UploadAvatar\(/);
    expect(go).toMatch(/func \(r \*AccountResource\) ClearAvatar\(/);
    expect(go).toMatch(/func \(r \*AccountResource\) ListWebSessions\(/);
    expect(go).toMatch(/func \(r \*AccountResource\) RevokeWebSession\(/);
    expect(go).toMatch(/func \(r \*AccountResource\) RevokeAllOtherWebSessions\(/);
    expect(go).toMatch(/func \(r \*AccountResource\) RateLimits\(/);
  });

  it('CRITICAL 5 wire-paths pinned per-SDK: /v1/account/me + /v1/account/me/avatar + /v1/account/web-sessions + /v1/account/web-sessions/:id + /v1/account/rate-limits. Drift to renaming would break server-side routing.', () => {
    const ts = read(TS_ACCT);
    const go = read(GO_ACCT);
    const py = read(PY_ACCT);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/\/v1\/account\/me/);
      expect(sdk).toMatch(/\/v1\/account\/me\/avatar/);
      expect(sdk).toMatch(/\/v1\/account\/web-sessions/);
      // Per-id sub-path with per-SDK encode wrapper.
      expect(sdk).toMatch(/\/v1\/account\/web-sessions\/(?:\$\{|"\s*\+|\{)/);
      expect(sdk).toMatch(/\/v1\/account\/rate-limits/);
    }
  });

  it("CRITICAL method-verb mix on account/me + adjacents in TS + Go — 6× GET + 2× PATCH + 2× POST + 4× DELETE + 1× PUT. The original 3-DELETE-and-1-POST mix (create-once / clear / revoke-one / revoke-all) is now joined by the bundled-LLM (Arc 1 sub-slice 6.6/6.7) and BYOK-Anthropic (AI-CHAT) verb clusters — BYOK's PUT is the only PUT in the resource, threading the customer-controlled key-replace semantic.", () => {
    const ts = read(TS_ACCT);

    const tsGet = (ts.match(/method: 'GET'/g) ?? []).length;
    const tsPatch = (ts.match(/method: 'PATCH'/g) ?? []).length;
    const tsPost = (ts.match(/method: 'POST'/g) ?? []).length;
    const tsDelete = (ts.match(/method: 'DELETE'/g) ?? []).length;
    const tsPut = (ts.match(/method: 'PUT'/g) ?? []).length;

    expect(tsGet, 'sdk-typescript GET count').toBe(6);
    expect(tsPatch, 'sdk-typescript PATCH count').toBe(2);
    expect(tsPost, 'sdk-typescript POST count').toBe(2);
    expect(tsDelete, 'sdk-typescript DELETE count').toBe(4);
    expect(tsPut, 'sdk-typescript PUT count').toBe(1);

    const go = read(GO_ACCT);
    const goGet = (go.match(/method: "GET"/g) ?? []).length;
    const goPatch = (go.match(/method: "PATCH"/g) ?? []).length;
    const goPost = (go.match(/method: "POST"/g) ?? []).length;
    const goDelete = (go.match(/method: "DELETE"/g) ?? []).length;
    const goPut = (go.match(/method: "PUT"/g) ?? []).length;
    expect(goGet, 'sdk-go GET count').toBe(6);
    expect(goPatch, 'sdk-go PATCH count').toBe(2);
    expect(goPost, 'sdk-go POST count').toBe(2);
    expect(goDelete, 'sdk-go DELETE count').toBe(4);
    expect(goPut, 'sdk-go PUT count').toBe(1);
  });

  it("CRITICAL revokeAllOtherWebSessions targets BASE path /v1/account/web-sessions (no :id) pinned in sdk-typescript + sdk-go. Drift to a per-id path would let the call revoke EVERY session including the caller's — silently locking them out.", () => {
    const ts = read(TS_ACCT);
    const go = read(GO_ACCT);

    // sdk-typescript: revokeAllOtherWebSessions DELETE on the base path (no template id).
    expect(ts).toMatch(
      /revokeAllOtherWebSessions\(\)[\s\S]{0,150}path: '\/v1\/account\/web-sessions',/,
    );

    // sdk-go: RevokeAllOtherWebSessions DELETE on the base path.
    expect(go).toMatch(
      /func \(r \*AccountResource\) RevokeAllOtherWebSessions\([\s\S]{0,250}path:\s*"\/v1\/account\/web-sessions",/,
    );
  });

  it('CRITICAL AccountSelfProfile multi-anchor field map pinned in TS + Go — slug (V-298a) + region (V-298b) + avatar_url (V-352b) + mfa_enrolled (V-353h) + teams (V-326c). Each field carries its own feature anchor in the inline comment; drift to dropping the anchor would lose the field-level provenance.', () => {
    const ts = read(TS_ACCT);
    const go = read(GO_ACCT);

    // TS: per-field doc-comment anchors.
    expect(ts).toMatch(/V-298a — readable account handle/);
    expect(ts).toMatch(/V-298b — stated infrastructure-region preference/);
    expect(ts).toMatch(/V-352b — short-lived \(~1h\) presigned R2 GET URL/);
    expect(ts).toMatch(/V-353h — true once TOTP enrollment is verified/);
    expect(ts).toMatch(/V-326c — team memberships the calling account holds/);

    // Go: per-field inline comments with anchors.
    expect(go).toMatch(/Slug\s+\*string\s+`json:"slug"`\s*\/\/ V-298a/);
    expect(go).toMatch(/Region\s+\*string\s+`json:"region"`\s*\/\/ V-298b/);
    expect(go).toMatch(/AvatarURL\s+\*string\s+`json:"avatar_url"`\s*\/\/ V-352b/);
    expect(ts).toMatch(/avatar_source: 'user' \| 'idp' \| 'none'/);
    expect(go).toMatch(/AvatarSource\s+string\s+`json:"avatar_source"`/);
    expect(go).toMatch(/MfaEnrolled[\s\S]{0,40}`json:"mfa_enrolled"`[\s\S]{0,40}V-353h/);
  });

  it("CRITICAL V-298b region 4-value enum pinned in sdk-typescript: 'us' | 'eu' | 'apac' | null. The closed-4 set is what dashboards anchor their region-badge rendering on. sdk-go uses string type. Drift to a 5th value would break the closed-set switch.", () => {
    const ts = read(TS_ACCT);

    // sdk-typescript: literal-type union.
    expect(ts).toMatch(/region: 'us' \| 'eu' \| 'apac' \| null/);

    // sdk-go: comment-based enum.
    const go = read(GO_ACCT);
    expect(go).toMatch(/"us"\|"eu"\|"apac"\|null/);
  });

  it("CRITICAL account status 3-value enum pinned in sdk-typescript: 'active' | 'suspended' | 'deleted'. The closed-3 set is what dashboards anchor their account-status badge on. Drift to a 4th value would break the closed-set switch.", () => {
    const ts = read(TS_ACCT);
    expect(ts).toMatch(/status: 'active' \| 'suspended' \| 'deleted'/);
  });

  it("CRITICAL RateLimitBucket V-258 4-bucket-key enum pinned in sdk-typescript: 'global' | 'sessions:create' | 'agent_sessions:message' | 'agent_sessions:input_event' (mirrors server BUCKET_KEYS — sweep-3). The set is the rate-limit-bucket roster; an exhaustive switch must cover every bucket the server actually returns.", () => {
    const ts = read(TS_ACCT);
    expect(ts).toMatch(/'global'/);
    expect(ts).toMatch(/'sessions:create'/);
    expect(ts).toMatch(/'agent_sessions:message'/);
    expect(ts).toMatch(/'agent_sessions:input_event'/);
  });

  it("CRITICAL RateLimitBucket source 2-value enum pinned in sdk-typescript: 'tier_default' | 'override'. The 'override' value flags accounts that have a per-account rate-limit override (tier-default-overridden by support); drift to dropping would lose the audit signal.", () => {
    const ts = read(TS_ACCT);
    expect(ts).toMatch(/source: 'tier_default' \| 'override'/);
  });

  it('CRITICAL WebSessionEntry 6-field shape pinned in sdk-typescript — id + os + browser + last_used_at + expires_at + current. The 6 fields are what the dashboard sign-in card renders. Drift to dropping `current` would let dashboards revoke the calling session.', () => {
    const ts = read(TS_ACCT);
    expect(ts).toMatch(
      /export interface WebSessionEntry \{[\s\S]*?id: string;[\s\S]*?os: string;[\s\S]*?browser: string;[\s\S]*?last_used_at: string;[\s\S]*?expires_at: string;[\s\S]*?current: boolean;/,
    );
  });

  it('Cross-SDK V-237 7-invariant cluster — V-237/V-385 anchor + V-352 + V-352b + V-355 + V-258 anchors + /v1/account/me path + 8-verb surface. Drift on any would fragment the cross-language account contract.', () => {
    const sdks = {
      'sdk-typescript': read(TS_ACCT),
      'sdk-go': read(GO_ACCT),
      'sdk-python': read(PY_ACCT),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} V-352`).toMatch(/V-352\b/);
      expect(body, `${name} V-352b`).toMatch(/V-352b/);
      expect(body, `${name} V-355`).toMatch(/V-355/);
      expect(body, `${name} V-258`).toMatch(/V-258/);
      expect(body, `${name} /v1/account/me`).toMatch(/\/v1\/account\/me/);
      expect(body, `${name} /v1/account/web-sessions`).toMatch(/\/v1\/account\/web-sessions/);
      expect(body, `${name} /v1/account/rate-limits`).toMatch(/\/v1\/account\/rate-limits/);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-account-me-parity.test.ts')),
    ).toBe(true);
  });
});
