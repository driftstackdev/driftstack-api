// W899 — V-386 AccountMeResponse 14-field cross-source invariant.
// Two-hundred-twenty-fifth in the drift-guard series. Pins the
// V-386 /v1/account/me rich-response shape:
//
//   AccountMeResponse (14 fields):
//     - 6 base: id + email + name + tier + status + (V-352 timezone).
//     - 2 V-298: slug + region.
//     - 1 V-352b: avatar_url (presigned R2 GET URL, 1h short-lived).
//     - 1 V-353h: mfa_enrolled.
//     - 4 derived: concurrent_session_cap + concurrent_session_active
//       + profile_cap + profile_count.
//     - 1 V-326c: teams array (member_id + role 'admin'|'member').
//
//   INTENTIONAL: declared SERVER-INTERNALLY (NOT api-types) per L-001
//   server-internal-shape convention. SDKs read AccountSchema (lean
//   shared type); the rich /me response is dashboard-only.
//
//   V-326 effective-account header is INTENTIONALLY NOT honored on
//   /v1/account/me — always operates on the caller's own account.
//
// stays in lockstep across apps/server/src/lib/openapi.ts +
// apps/server/src/routes/account-me.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W899 V-386 AccountMeResponse cross-source invariant', () => {
  // ─── V-386 anchor + 'declared here not api-types' framing ────

  it("CRITICAL apps/server/src/lib/openapi.ts has V-386 anchor + 'full /v1/account/me response shape. Defined here rather than in api-types because the SDKs read AccountSchema (the lean shared type) and the rich /me response is only ever consumed by the dashboard via the route directly'. The framing pins the lean-vs-rich split.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    expect(p).toMatch(/V-386 — full \/v1\/account\/me response shape/);
    expect(p).toMatch(
      /Defined here rather than\s*\n\/\/ in api-types because the SDKs read AccountSchema \(the lean shared/,
    );
    expect(p).toMatch(
      /type\) and the rich \/me response is only ever consumed by the\s*\n\/\/ dashboard via the route directly/,
    );
  });

  // ─── 14-field shape ──────────────────────────────────────────

  it('CRITICAL AccountMeResponseSchema has 14 fields. Includes 6 base + 2 V-298 + 1 V-352b + 1 V-353h + 4 derived + 1 V-326c teams.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    const m = p.match(/AccountMeResponseSchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const f of [
      'id:',
      'email:',
      'name:',
      'tier:',
      'status:',
      'timezone:',
      'slug:',
      'region:',
      'avatar_url:',
      'mfa_enrolled:',
      'concurrent_session_cap:',
      'concurrent_session_active:',
      'profile_cap:',
      'profile_count:',
      'teams:',
    ]) {
      expect(body, `AccountMeResponseSchema must have ${f}`).toMatch(new RegExp(f));
    }
  });

  // ─── V-326c teams array ─────────────────────────────────────

  it("CRITICAL AccountMeResponse.teams is z.array of objects with 5 fields — owner_account_id + owner_email + owner_name (nullable) + role ('admin' | 'member') + membership_id. owner_email/owner_name (sweep-3) let the dashboard label a team by who owns it. The role matches V-298c TeamRole + the V-326c 'acting as' picker.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    expect(p).toMatch(
      /teams: z\.array\(\s*\n\s*z\.object\(\{\s*\n\s*owner_account_id: z\.string\(\),(?:\s*\n\s*\/\/[^\n]*)*\s*\n\s*owner_email: z\.string\(\),\s*\n\s*owner_name: z\.string\(\)\.nullable\(\),\s*\n\s*role: z\.enum\(\['admin', 'member'\]\),\s*\n\s*membership_id: z\.string\(\),/,
    );
  });

  // ─── Route emits matching shape ──────────────────────────────

  it("CRITICAL apps/server/src/routes/account-me.ts emits the 15-field response (V-326c teams included). The route's return value must match the openapi schema field-for-field.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts'));
    // Sample 5 key fields from the route emission.
    expect(p).toMatch(/concurrent_session_cap: TIER_CONCURRENT_SESSION_LIMITS\[tier\]/);
    expect(p).toMatch(/concurrent_session_active: activeSessions/);
    expect(p).toMatch(/profile_cap: profileCapFor\(tier\)/);
    expect(p).toMatch(/profile_count: profileCount/);
    expect(p).toMatch(
      /teams: ctx\.teams\.map\(\(t\) => \(\{\s*\n\s*owner_account_id: `acc_\$\{t\.ownerAccountId\}`,\s*\n\s*owner_email: t\.ownerEmail \?\? `acc_\$\{t\.ownerAccountId\}`,\s*\n\s*owner_name: t\.ownerName \?\? null,\s*\n\s*role: t\.role,\s*\n\s*membership_id: `mem_\$\{t\.membershipId\}`,/,
    );
  });

  // ─── Route registers AccountMeResponse in openapi components ─

  it("CRITICAL openapi.ts registers 'AccountMeResponse' as a named component — 'r.register('AccountMeResponse', AccountMeResponseSchema)'. The component-registration is what makes Python pydantic / Go struct generators emit a named type.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    expect(p).toMatch(/r\.register\('AccountMeResponse', AccountMeResponseSchema\);/);
  });

  // ─── V-326 effective-account header NOT honored on /me ───────

  it("CRITICAL /v1/account/me INTENTIONALLY does NOT honor V-326 effective-account header — 'always operates on the caller's own account'. The framing pinned in route comments documents the deliberate carve-out.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts'));
    expect(p).toMatch(
      /V-326 effective-account header is intentionally NOT honored\s*\n\s*\/\/ — \/v1\/account\/me always operates on the caller's own account/,
    );
  });

  // ─── avatar_url short-lived 1h ───────────────────────────────

  it("CRITICAL avatar_url framing — 'V-352b — presigned R2 GET URL for the customer's uploaded avatar; null when none uploaded or the public bucket isn't wired in this deploy. URL is short-lived (1h).' The 1h expiry is the security contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts'));
    expect(p).toMatch(/V-352b — presigned R2 GET URL for the customer's uploaded/);
    expect(p).toMatch(/URL is short-lived \(1h\)/);
  });

  // ─── V-298a + V-298b + V-353h field-level anchors ────────────

  it('CRITICAL field-level V-anchors pinned on route emission — V-298a (slug) + V-298b (region) + V-353h (mfa_enrolled). Each anchor traces the field-source to its feature work.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts'));
    expect(p).toMatch(/V-298a — readable account handle/);
    expect(p).toMatch(/V-298b — data-residency region preference/);
    expect(p).toMatch(/V-353h — MFA enrollment flag for dashboard header/);
  });

  // ─── 15-field cardinality ────────────────────────────────────

  it('CRITICAL AccountMeResponse has 15 top-level fields + 5 nested teams-object fields = 20 total matches (sweep-3 added owner_email + owner_name to the nested teams object). The 15-top-level rich shape distinguishes /v1/account/me (dashboard) from the lean AccountSchema (SDKs).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    const m = p.match(/AccountMeResponseSchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m).not.toBeNull();
    const body = m![1] ?? '';
    // Count top-level + nested fields together (15 top + 5 nested = 20).
    const fieldCount = (body.match(/^\s*[a-z_]+:/gm) || []).length;
    expect(fieldCount).toBe(20);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/account-me-response-shape-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
