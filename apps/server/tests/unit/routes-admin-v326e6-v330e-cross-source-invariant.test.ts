// W1049 — routes/admin V-326e6 + V-330e cross-source invariant.
// Pins apps/server/src/routes/admin.ts API-key management + usage view:
//
//   Header anchor — 'Admin routes — API key management + usage view'.
//
//   Endpoint roster — 6 routes:
//     POST   /v1/api-keys
//     GET    /v1/api-keys
//     DELETE /v1/api-keys/:id
//     POST   /v1/api-keys/:id/rotate          (V-296)
//     GET    /v1/usage                         (V-330e effective-account)
//     GET    /v1/usage/series                  (V-170 + V-330e)
//
//   V-326e6 team-RBAC framing:
//     - api-keys writes (POST / DELETE / rotate): admin-only on
//       team-scoped requests.
//     - api-keys read (GET): role-agnostic.
//
//   x-driftstack-account header — effective-account resolution
//   header shared with profile-snapshots.
//
//   V-296 rotation framing — fresh plaintext shown once, old key
//   continues for 24h grace period.
//
//   V-330e usage on team — read from OWNER's account (tier sourced
//   from owner), 403 when owner account no longer exists.
//
//   publicApiKey envelope — 8 fields including key_-prefixed id +
//   ISO timestamps + nullable revoked/expires/last-used.
//
//   publicUsage envelope — 5 fields (period_start / period_end /
//   tier / totals / quotas).
//
//   V-170 usage/series — default 30 days, max 90.
//
// stays in lockstep across apps/server/src/routes/admin.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return readFileSync(p, 'utf8');
}

describe('W1049 routes/admin V-326e6 + V-330e cross-source invariant', () => {
  // ─── Header anchor + roster ──────────────────────────────────

  it("CRITICAL header anchor — 'Admin routes — API key management + usage view'. The single-anchor design pairs the api-keys CRUD with the usage view.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts'));
    expect(p).toMatch(/Admin routes — API key management \+ usage view\./);
  });

  it('CRITICAL endpoint roster — 6 routes (POST/GET/DELETE /v1/api-keys + POST :id/rotate + GET /v1/usage + GET /v1/usage/series). The exhaustive section banner comments are the canonical contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts'));
    expect(p).toMatch(/POST \/v1\/api-keys/);
    expect(p).toMatch(/GET \/v1\/api-keys/);
    expect(p).toMatch(/DELETE \/v1\/api-keys\/:id/);
    expect(p).toMatch(/POST \/v1\/api-keys\/:id\/rotate/);
    expect(p).toMatch(/GET \/v1\/usage/);
    expect(p).toMatch(/GET \/v1\/usage\/series/);
  });

  // ─── V-326e6 team-RBAC framing ───────────────────────────────

  it("CRITICAL V-326e6 admin-only-write framing — 'API key writes on a team owner require admin role on that team.' The 'on that team' phrase distinguishes from cross-account admin (no such thing for customer api-keys).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts'));
    expect(p).toMatch(
      /throw new ForbiddenError\('API key writes on a team owner require admin role on that team\.'\)/,
    );
  });

  it("CRITICAL V-326e6 admin-only-write applied to POST + DELETE + rotate. Read (GET) is role-agnostic — 'V-326e6 — read role-agnostic; both member and admin can list the OWNER's keys'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts'));
    expect(p).toMatch(/V-326e6 — admin-only on team-scoped requests/);
    expect(p).toMatch(/V-326e6 — read role-agnostic;/);
  });

  // ─── x-driftstack-account header ─────────────────────────────

  it("CRITICAL EFFECTIVE_ACCOUNT_HEADER — 'x-driftstack-account'. Extracted to shared lib/effective-account-header.ts; admin.ts imports readEffectiveAccountHeader from there for cross-route team-RBAC consistency.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts'));
    expect(p).toMatch(
      /import \{ readEffectiveAccountHeader \} from '\.\.\/lib\/effective-account-header\.js';/,
    );
    const lib = read(resolve(REPO_ROOT, 'apps/server/src/lib/effective-account-header.ts'));
    expect(lib).toMatch(/export const EFFECTIVE_ACCOUNT_HEADER = 'x-driftstack-account';/);
  });

  // ─── V-296 rotation ──────────────────────────────────────────

  it("CRITICAL V-296 rotation framing — 'customer self-service rotation. Mints a fresh plaintext (shown once); old key continues working for 24h grace period via expires_at-driven auth gate. Optional `name` lets the caller rename the new key'. The 24h grace prevents the 'I rotated and now my prod is down' rollout pain.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts'));
    expect(p).toMatch(/V-296 — customer self-service rotation\. Mints a fresh plaintext \(shown/);
    expect(p).toMatch(/once\); old key continues working for 24h grace period via/);
    expect(p).toMatch(/expires_at-driven auth gate\./);
    expect(p).toMatch(/Optional `name` lets the caller rename/);
  });

  it("CRITICAL rotation response shape — publicApiKey + plaintext + rotated_from key_-prefixed + grace_period_ends_at ISO. The 4-field rotation envelope is what tells the client 'use plaintext now, the rotated_from key stops at grace_period_ends_at'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts'));
    expect(p).toMatch(/plaintext: result\.plaintext,/);
    expect(p).toMatch(/rotated_from: `key_\$\{result\.oldKey\.id\}`,/);
    expect(p).toMatch(/grace_period_ends_at: result\.gracePeriodEndsAt\.toISOString\(\),/);
  });

  // ─── V-330e usage on team ────────────────────────────────────

  it("CRITICAL V-330e usage framing — 'a team member with a valid membership reads the OWNER's usage. The OWNER's tier is the quota-cap source (members don't override the cap by being on the team); we look it up from the auth repo when the header is set'. The OWNER-tier-not-member-tier rule prevents a free-tier member from inheriting a paid team's caps.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts'));
    expect(p).toMatch(/V-330e — honors X-Driftstack-Account: a team member with a valid/);
    expect(p).toMatch(/membership reads the OWNER's usage\. The OWNER's tier is the/);
    expect(p).toMatch(/quota-cap source \(members don't override the cap by being on the/);
    expect(p).toMatch(/team\); we look it up from the auth repo when the header is set\./);
  });

  it("CRITICAL deleted-owner → 403 framing — 'Membership references an account that's been deleted between the auth-cache load and the route call. Surface as 403 — the membership is effectively invalid'. The cache-load-vs-route-call race is the corner case that motivates the explicit check.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts'));
    expect(p).toMatch(/Membership references an account that's been deleted between/);
    expect(p).toMatch(/the auth-cache load and the route call\. Surface as 403 — the/);
    expect(p).toMatch(/membership is effectively invalid\./);
    expect(p).toMatch(/throw new ForbiddenError\('Owner account no longer exists\.'\)/);
  });

  // ─── publicApiKey envelope ───────────────────────────────────

  it("CRITICAL publicApiKey envelope — 8 fields (key_-prefixed id / name / key_prefix / scopes / last_used_at ISO|null / revoked_at ISO|null / expires_at ISO|null / created_at ISO). The 3-nullable-ISO fields preserve client distinctions between 'never used' / 'never expired' / etc.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts'));
    expect(p).toMatch(/id: `key_\$\{row\.id\}`,/);
    expect(p).toMatch(/name: row\.name,/);
    expect(p).toMatch(/key_prefix: row\.keyPrefix,/);
    expect(p).toMatch(/scopes: row\.scopes,/);
    expect(p).toMatch(/last_used_at: row\.lastUsedAt \? row\.lastUsedAt\.toISOString\(\) : null,/);
    expect(p).toMatch(/revoked_at: row\.revokedAt \? row\.revokedAt\.toISOString\(\) : null,/);
    expect(p).toMatch(/expires_at: row\.expiresAt \? row\.expiresAt\.toISOString\(\) : null,/);
    expect(p).toMatch(/created_at: row\.createdAt\.toISOString\(\),/);
  });

  // ─── publicUsage envelope ────────────────────────────────────

  it('CRITICAL publicUsage envelope — 5 fields (period_start ISO / period_end ISO / tier / totals / quotas). The flat shape is what the dashboard /usage page consumes.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts'));
    expect(p).toMatch(/period_start: s\.periodStart\.toISOString\(\),/);
    expect(p).toMatch(/period_end: s\.periodEnd\.toISOString\(\),/);
    expect(p).toMatch(/tier: s\.tier,/);
    expect(p).toMatch(/totals: s\.totals,/);
    expect(p).toMatch(/quotas: s\.quotas,/);
  });

  // ─── V-170 usage series ──────────────────────────────────────

  it("CRITICAL V-170 usage/series framing — 'daily-bucketed usage series for sparkline rendering. Customer-dashboard /usage consumes this. Default 30 days, max 90. Empty buckets today (usage_records writers not wired); the endpoint returns the contract shape with zeros so the dashboard can render empty-state correctly'. The 30-default + 90-max + zeros-for-empty-days design keeps the contract shape stable for accounts with gaps. V-838 corrected this case: it described the endpoint as serving nothing but zeros because the writers had not landed, and they had.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts'));
    expect(p).toMatch(/V-170 — daily-bucketed usage series for sparkline rendering\./);
    expect(p).toMatch(/Customer-dashboard \/usage consumes this\. Default 30 days, max 90\./);
    expect(p).toMatch(/Buckets carry real data\. `DrizzleAgentDecomposerUsageRecorder` inserts/);
    // V-838 SENTINEL — writers are wired at bootstrap; the claim must not return.
    expect(p, 'usage_records writers are wired').not.toMatch(/usage_records writers not wired/);
    expect(p).toMatch(/the contract shape with zeros — `dailyBucketsForRange` left-joins onto a/);
    expect(p).toMatch(/`generate_series`, so empty days are zeros rather than missing rows/);
  });

  it('CRITICAL usage/series default days — 30 (via ?? 30 in the dailySeries call). Matches the V-170 framing comment; drift would diverge dashboard contract from server default.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts'));
    expect(p).toMatch(/usageService\.dailySeries\(ctx, query\.days \?\? 30,/);
  });

  // ─── POST /v1/api-keys 201 envelope ──────────────────────────

  it('CRITICAL POST /v1/api-keys 201 envelope — publicApiKey + plaintext field. The plaintext is shown once at creation; the row never carries it.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts'));
    expect(p).toMatch(
      /return reply\.code\(201\)\.send\(\{\s*\n?\s*\.\.\.publicApiKey\(created\.row\),\s*\n?\s*plaintext: created\.plaintext,/,
    );
  });

  // ─── Auth + rate-limit on every route ────────────────────────

  it('CRITICAL requireAuth + global rate-limit on every admin route. Drift to dropping either would expose api-keys management to anonymous or unrate-limited callers.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts'));
    const routes = p.match(/\bapp\.(?:get|post|put|patch|delete)[<(]/g) ?? [];
    const chains = p.match(/preHandler: \[[^\]]*\]/g) ?? [];
    expect(routes.length, 'admin route registration count').toBe(6);
    expect(chains.length, 'admin routes carrying a preHandler chain').toBe(routes.length);
    for (const chain of chains) {
      expect(chain, 'requireAuth first in every admin preHandler chain').toMatch(
        /^preHandler: \[\s*app\.requireAuth\s*,/,
      );
      expect(chain, 'global rate-limit last in every admin preHandler chain').toMatch(
        /app\.rateLimit\('global'\),?\s*\]$/,
      );
    }
  });
});
