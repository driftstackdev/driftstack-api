// W420.A — drift guard for apps/server/src/routes/admin.ts.
// Admin routes — API key management + usage view. V-326e6 admin-only
// gate on team-scoped key writes (member is read-only); V-330e
// effective-account header on /v1/usage + /v1/usage/series. Drift
// here either drops the V-326e6 role gate (lets 'member' role mint
// keys on owner's account) or breaks V-330e tier-cap derivation
// (member's tier overrides owner's tier).
//
//   • Framing pinned: API key management (POST/GET/DELETE/rotate) +
//     usage (summary + series).
//   • V-326e6 admin-only on team-scoped key WRITES (POST/DELETE/
//     rotate); read (GET) role-agnostic; 'member' → 403 on writes.
//   • V-330e effective-account: GET /v1/usage + /v1/usage/series
//     honor X-Driftstack-Account; owner's tier is quota-cap source
//     (members don't override cap by being on team); auth repo
//     lookup when header set.
//   • V-296 rotate framing: customer self-service; fresh plaintext
//     shown once; old key 24h grace via expires_at-driven auth gate;
//     optional `name` rename.
//   • Effective-account-deleted-mid-request → 403 ForbiddenError
//     (membership references invalid account).
//   • EFFECTIVE_ACCOUNT_HEADER constant + Array.isArray fallback
//     (shared pattern).
//   • effectiveAccountIdForKeyWrite helper: throws ForbiddenError on
//     team-with-non-admin-role; returns undefined on self-account.
//   • publicApiKey: key_<uuid> + nullable timestamps.
//   • publicUsage: periodStart/End ISO + tier + totals + quotas.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W420.A apps/server/src/routes/admin.ts content parity', () => {
  const body = read(LIB);

  it('V-326e6 framing pinned: admin-only on team-scoped key writes (POST/DELETE/rotate); GET role-agnostic; member → 403', () => {
    expect(body).toMatch(
      /\/\/ V-326e6 — admin-only gate for api-keys writes \(POST \/ DELETE \/\s*\n?\s*\/\/ rotate\)\. Read \(GET \/v1\/api-keys\) is role-agnostic\./,
    );
    expect(body).toMatch(
      /if \(effective\.role !== 'admin'\) \{\s*\n?\s*throw new ForbiddenError\('API key writes on a team owner require admin role on that team\.'\);/,
    );
  });

  it('V-330e effective-account framing pinned: GET /v1/usage + /v1/usage/series honor X-Driftstack-Account; owner tier is quota-cap source', () => {
    expect(body).toMatch(
      /\/\/ V-330e — honors X-Driftstack-Account: a team member with a valid\s*\n?\s*\/\/ membership reads the OWNER's usage\. The OWNER's tier is the\s*\n?\s*\/\/ quota-cap source \(members don't override the cap by being on the\s*\n?\s*\/\/ team\); we look it up from the auth repo when the header is set\./,
    );
    expect(body).toMatch(/\/\/ V-330e — same effective-account treatment as \/v1\/usage above\./);
  });

  it('both usage reads require broad read authority before rate limiting and effective-owner resolution', () => {
    expect(
      body.match(
        /preHandler: \[app\.requireAuth, app\.requireScope\('read'\), app\.rateLimit\('global'\)\]/g,
      ),
    ).toHaveLength(2);
  });

  it('Owner-account-deleted-mid-request → 403 ForbiddenError ("Owner account no longer exists.") on /v1/usage', () => {
    expect(body).toMatch(
      /\/\/ Membership references an account that's been deleted between\s*\n?\s*\/\/ the auth-cache load and the route call\. Surface as 403 — the\s*\n?\s*\/\/ membership is effectively invalid\./,
    );
    expect(body).toMatch(/throw new ForbiddenError\('Owner account no longer exists\.'\);/);
  });

  it('readEffectiveAccountHeader imported from shared lib/effective-account-header.ts (extraction collapsed inline EFFECTIVE_ACCOUNT_HEADER + array-or-string handler across team-RBAC routes)', () => {
    expect(body).toMatch(
      /import \{ readEffectiveAccountHeader \} from '\.\.\/lib\/effective-account-header\.js';/,
    );
    expect(body).toMatch(/readEffectiveAccountHeader\(request\)/);
  });

  it('effectiveAccountIdForKeyWrite: returns undefined on self-account; team-with-admin-role → accountId; team-with-non-admin-role → ForbiddenError', () => {
    expect(body).toMatch(
      /function effectiveAccountIdForKeyWrite\(\s*\n?\s*request: FastifyRequest,\s*\n?\s*ctx: AccountReq,\s*\n?\s*\): string \| undefined \{\s*\n?\s*const effective = resolveEffectiveAccount\(ctx, readEffectiveAccountHeader\(request\)\);\s*\n?\s*if \(effective\.kind !== 'team'\) return undefined;\s*\n?\s*if \(effective\.role !== 'admin'\) \{\s*\n?\s*throw new ForbiddenError\('API key writes on a team owner require admin role on that team\.'\);\s*\n?\s*\}\s*\n?\s*return effective\.accountId;/,
    );
  });

  it('publicApiKey: key_<uuid> + name/key_prefix/scopes + nullable last_used_at/revoked_at/expires_at ISO + created_at ISO', () => {
    expect(body).toMatch(/function publicApiKey\(row: ApiKeyRow\): Record<string, unknown> \{/);
    expect(body).toMatch(/id: `key_\$\{row\.id\}`,/);
    expect(body).toMatch(/key_prefix: row\.keyPrefix,/);
    expect(body).toMatch(
      /last_used_at: row\.lastUsedAt \? row\.lastUsedAt\.toISOString\(\) : null,/,
    );
    expect(body).toMatch(/revoked_at: row\.revokedAt \? row\.revokedAt\.toISOString\(\) : null,/);
    expect(body).toMatch(/expires_at: row\.expiresAt \? row\.expiresAt\.toISOString\(\) : null,/);
    expect(body).toMatch(/created_at: row\.createdAt\.toISOString\(\),/);
  });

  it('publicUsage: 5-field shape (period_start/end ISO + tier + totals + quotas)', () => {
    expect(body).toMatch(
      /function publicUsage\(s: UsageSummary\): Record<string, unknown> \{\s*\n?\s*return \{\s*\n?\s*period_start: s\.periodStart\.toISOString\(\),\s*\n?\s*period_end: s\.periodEnd\.toISOString\(\),\s*\n?\s*tier: s\.tier,\s*\n?\s*totals: s\.totals,\s*\n?\s*quotas: s\.quotas,\s*\n?\s*\};/,
    );
  });

  it('POST /v1/api-keys: V-326e6 admin-only gate; owner tier-derived test/live env switch; spread effectiveAccountId/effectiveTier when team', () => {
    expect(body).toMatch(
      /\/\/ V-326e6 — admin-only on team-scoped requests\. The key is minted\s*\n?\s*\/\/ on the OWNER's account; tier-derived test\/live env switch uses\s*\n?\s*\/\/ the OWNER's tier\./,
    );
    expect(body).toMatch(
      /if \(eff !== undefined\) \{\s*\n?\s*const owner = await authRepo\.getAccount\(eff\);\s*\n?\s*if \(!owner\) throw new ForbiddenError\('Owner account no longer exists\.'\);\s*\n?\s*createOpts = \{ effectiveAccountId: owner\.id, effectiveTier: owner\.tier \};\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /return reply\.code\(201\)\.send\(\{\s*\n?\s*\.\.\.publicApiKey\(created\.row\),\s*\n?\s*plaintext: created\.plaintext,\s*\n?\s*\}\);/,
    );
  });

  it('V-296 rotate framing pinned: customer self-service; fresh plaintext shown-once; 24h grace via expires_at; optional name rename', () => {
    expect(body).toMatch(
      /\/\/ V-296 — customer self-service rotation\. Mints a fresh plaintext \(shown\s*\n?\s*\/\/ once\); old key continues working for 24h grace period via\s*\n?\s*\/\/ expires_at-driven auth gate\. Optional `name` lets the caller rename\s*\n?\s*\/\/ the new key \(useful when rotating "production-2024" → "production-2025"\)\./,
    );
    expect(body).toMatch(
      /return reply\.code\(201\)\.send\(\{\s*\n?\s*\.\.\.publicApiKey\(result\.newRow\),\s*\n?\s*plaintext: result\.plaintext,\s*\n?\s*rotated_from: `key_\$\{result\.oldKey\.id\}`,\s*\n?\s*grace_period_ends_at: result\.gracePeriodEndsAt\.toISOString\(\),\s*\n?\s*\}\);/,
    );
  });

  it('GET /v1/api-keys: role-agnostic effective-account read (both member and admin); apiKeysService.list with effectiveAccountId when team', () => {
    expect(body).toMatch(
      /\/\/ V-326e6 — read role-agnostic; both 'member' and 'admin' can list\s*\n?\s*\/\/ the OWNER's keys\./,
    );
    expect(body).toMatch(
      /const keys = await apiKeysService\.list\(\s*\n?\s*ctx,\s*\n?\s*effective\.kind === 'team' \? \{ effectiveAccountId: effective\.accountId \} : \{\},\s*\n?\s*\);/,
    );
  });

  it("DELETE /v1/api-keys/:id: uuidFromPrefixedId('key') + apiKeysService.revoke with spread-conditional effectiveAccountId; 204 reply", () => {
    expect(body).toMatch(
      /const id = uuidFromPrefixedId\(request\.params\.id, 'key'\);[\s\S]+?await apiKeysService\.revoke\(ctx, id, eff !== undefined \? \{ effectiveAccountId: eff \} : \{\}\);[\s\S]+?return reply\.code\(204\)\.send\(\);/,
    );
  });

  it('GET /v1/usage: team kind → load owner via authRepo.getAccount + usageService.summaryFor(owner.id, owner.tier); else currentPeriodSummary(ctx)', () => {
    expect(body).toMatch(
      /if \(effective\.kind === 'team'\) \{\s*\n?\s*const owner = await authRepo\.getAccount\(effective\.accountId\);[\s\S]+?const summary = await usageService\.summaryFor\(owner\.id, owner\.tier\);\s*\n?\s*return publicUsage\(summary\);/,
    );
    expect(body).toMatch(
      /const summary = await usageService\.currentPeriodSummary\(ctx\);\s*\n?\s*return publicUsage\(summary\);/,
    );
  });

  it('V-170 framing pinned: GET /v1/usage/series daily-bucketed sparkline; default 30 days / max 90; zeros come from the generate_series left-join for days with no rows. V-838 retitled this: it used to say the writers were unwired, and they are wired at bootstrap', () => {
    expect(body).toMatch(
      /\/\/ V-170 — daily-bucketed usage series for sparkline rendering\.\s*\n?\s*\/\/ Customer-dashboard \/usage consumes this\. Default 30 days, max 90\./,
    );
    // V-838 — the endpoint serves real rows; the zeros are per-day gaps from a
    // generate_series left-join, not an unwired-writer stub.
    expect(body).toMatch(/Buckets carry real data\./);
    expect(body, 'the writers are wired').not.toMatch(/usage_records writers not wired/);
    expect(body).toMatch(
      /const series = await usageService\.dailySeries\(ctx, query\.days \?\? 30, undefined, \{\s*\n?\s*\.\.\.\(effective\.kind === 'team' \? \{ effectiveAccountId: effective\.accountId \} : \{\}\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*from_date: series\.fromDate,\s*\n?\s*to_date: series\.toDate,\s*\n?\s*buckets: series\.buckets,\s*\n?\s*\};/,
    );
  });

  it('AdminRoutesOptions: apiKeysService + usageService + authRepo (V-330e owner-tier resolution)', () => {
    expect(body).toMatch(/export interface AdminRoutesOptions \{/);
    expect(body).toMatch(/apiKeysService: ApiKeysService;/);
    expect(body).toMatch(/usageService: UsageService;/);
    expect(body).toMatch(
      /\/\*\*\s*\n?\s*\*\s*V-330e — needed to load the OWNER's account row \(for tier\s*\n?\s*\*\s*resolution\) when a team member calls \/v1\/usage with an\s*\n?\s*\*\s*X-Driftstack-Account header\.\s*\n?\s*\*\/\s*\n?\s*authRepo: AccountAuthRepo;/,
    );
  });

  it('imports: FastifyInstance/FastifyRequest + AccountTier + CreateApiKey/UsageSeries schemas + AccountAuthRepo/ApiKeyRow + ApiKeysService + UsageService/Summary + BadRequestError/ForbiddenError + resolveEffectiveAccount', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    // AccountTier is no longer imported here: the two locals that named it were
    // the loose `{ effectiveAccountId?; effectiveTier? }` pair, and they are one
    // type now. The tier still travels — inside EffectiveOwner.
    expect(body).not.toMatch(/import type \{ AccountTier \} from '@driftstack\/api-types';/);
    expect(body).toMatch(
      /import type \{ EffectiveOwner \} from '\.\.\/lib\/effective-account-header\.js';/,
    );
    expect(body).toMatch(
      /import \{ CreateApiKeyRequestSchema, UsageSeriesQuerySchema \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /import type \{ AccountAuthRepo, ApiKeyRow \} from '\.\.\/services\/auth\.js';/,
    );
    expect(body).toMatch(/import type \{ ApiKeysService \} from '\.\.\/services\/api-keys\.js';/);
    expect(body).toMatch(
      /import type \{ UsageService, UsageSummary \} from '\.\.\/services\/usage\.js';/,
    );
    expect(body).toMatch(
      /import \{ BadRequestError, ForbiddenError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(/import \{ resolveEffectiveAccount \} from '\.\.\/services\/auth\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
