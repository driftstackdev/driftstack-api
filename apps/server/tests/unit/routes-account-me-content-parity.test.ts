// W420.C — drift guard for apps/server/src/routes/account-me.ts.
// V-237 customer self-profile + V-352 PATCH basics + V-352b avatar
// upload/clear + V-353h MFA enrollment surface + V-298a slug
// uniqueness + V-298b region + V-326c teams memberships + V-330.
// Exact /v1/account/me identity/edit routes stay self-only, while the
// nested /organization profile taxonomy honors the selected effective
// account. Drift here can either grant surprising owner identity edits
// or cross-write one workspace's taxonomy into another.
//
//   • V-237 framing pinned: GET /me identity + tier + concurrent-
//     session + profile usage/caps; tier-aware enforcement display
//     (file 128 spec mirror).
//   • V-352 PATCH: name + timezone update; effective-account header
//     intentionally NOT honored ("/me always operates on caller's
//     own account"; team-owner edits via V-352c).
//   • V-352b avatar: presigned R2 GET URL with AVATAR_PRESIGN_TTL_
//     SECONDS = 60*60 (1h rationale: rotating bucket secret
//     invalidates outstanding URLs in <1h); POST inline base64 ≤
//     AVATAR_MAX_BYTES; bodyLimit 3.5 MiB; DELETE clears pointer
//     (R2 object intentionally left for sweeper).
//   • V-298a SLUG_TAKEN → 409 ConflictError.
//   • V-353h MFA enrolled flag from optional MfaService (null →
//     always false).
//   • V-326c teams shape: owner_account_id=acc_ + role + membership_
//     id=mem_; teams entries from ctx.teams (empty array when not
//     on any team).
//   • Auth-cache invalidation on PATCH + avatar POST + avatar DELETE
//     (best-effort, swallowed).
//   • R2 presign failure → null (logged + swallowed; stale /me read
//     never 500s on R2 hiccup).
//   • profileCapFor: PROFILES_PER_TIER 'custom' → null (enterprise);
//     numeric otherwise.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W420.C apps/server/src/routes/account-me.ts content parity', () => {
  const body = read(LIB);

  it('identity GET /me keeps broad read while nested organization uses profile-scoped read/write gates', () => {
    expect(body).toMatch(
      /'\/v1\/account\/me',\s*\{ preHandler: \[app\.requireAuth, app\.requireScope\('read'\), app\.rateLimit\('global'\)\] \}/,
    );
    expect(body).toMatch(
      /'\/v1\/account\/me\/organization',\s*\{ preHandler: \[app\.requireAuth, app\.requireScope\('read:profiles'\), app\.rateLimit\('global'\)\] \}/,
    );
    expect(body).toMatch(
      /'\/v1\/account\/me\/organization',\s*\{ preHandler: \[app\.requireAuth, app\.requireScope\('write:profiles'\), app\.rateLimit\('global'\)\] \}/,
    );
  });

  it('organization resolves the exact effective owner; team writes authorize admin before parsing and write only that owner', () => {
    expect(body).toMatch(
      /const effective = resolveEffectiveAccount\(ctx, readEffectiveAccountHeader\(request\)\);\s*const org = await authRepo\.getOrganization\(effective\.accountId\);/,
    );
    expect(body).toMatch(
      /const effective = resolveEffectiveAccount\(ctx, readEffectiveAccountHeader\(request\)\);\s*if \(effective\.kind === 'team' && effective\.role !== 'admin'\)[\s\S]+?const parsed = AccountOrganizationSchema\.safeParse\(request\.body \?\? \{\}\);/,
    );
    expect(body).toContain('await authRepo.setOrganization(effective.accountId, parsed.data);');
    expect(body).not.toContain('authRepo.getOrganization(ctx.account.id)');
    expect(body).not.toContain('authRepo.setOrganization(ctx.account.id, parsed.data)');
  });

  it('V-237 framing pinned: GET /v1/account/me identity + tier + concurrent-session usage/cap + profile usage/cap; file 128 spec mirror', () => {
    expect(body).toMatch(/V-237 — customer self-profile endpoint\./);
    expect(body).toMatch(
      /GET \/v1\/account\/me — returns the calling account's identity \+ tier\s*\/\/\s*\+ concurrent-session usage\/cap \+ profile usage\/cap\. Powers the GUI\s*\/\/\s*client's tier-aware enforcement display \(file 128 spec mirror\) so\s*\/\/\s*the customer sees "X \/ Y concurrent sessions" \+ "P \/ Q profiles"\s*\/\/\s*before the API enforces the cap with a 429 tier-limit problem/,
    );
    expect(body).toMatch(
      /Distinct from `\/v1\/account\/rate-limits` \(per-bucket limit config\)\s*\/\/\s*and `\/v1\/account\/audit-log` \(event ledger\) — this is the dashboard\s*\/\/\s*header view\./,
    );
  });

  it('V-352 effective-account NOT honored: /me always self-account; team-owner edits land in V-352c with explicit semantics', () => {
    expect(body).toMatch(
      /\/\/ Note: V-326 effective-account header is intentionally NOT honored\s*\/\/ — \/v1\/account\/me always operates on the caller's own account\.\s*\/\/ Acting on a team owner's account\.name \/ timezone would be\s*\/\/ surprising; if needed, lands in V-352c with explicit semantics\./,
    );
  });

  it('V-352b avatar TTL framing pinned: AVATAR_PRESIGN_TTL_SECONDS = 60*60 (1h rotating-secret invalidates outstanding URLs <1h rationale)', () => {
    expect(body).toMatch(
      /\/\*\* V-352b — avatar presigned-GET TTL\. 1h is long enough that a single\s*\*\s*dashboard render doesn't churn signed URLs but short enough that\s*\*\s*rotating the bucket secret invalidates outstanding URLs in <1h\. \*\/\s*const AVATAR_PRESIGN_TTL_SECONDS = 60 \* 60;/,
    );
  });

  it("profileCapFor: PROFILES_PER_TIER 'custom' → null (enterprise = no fixed cap; see contract); numeric otherwise", () => {
    expect(body).toMatch(
      /\* Resolve the profile cap for a tier\. `PROFILES_PER_TIER` returns\s*\*\s*`'custom'` for enterprise \(negotiated per-customer\); we surface\s*\*\s*that as `null` to the customer \(read: "no fixed cap on this tier;\s*\*\s*see your contract"\)\. All other tiers return a numeric cap\./,
    );
    expect(body).toMatch(
      /function profileCapFor\(tier: AccountTier\): number \| null \{\s*const cap = PROFILES_PER_TIER\[tier\];\s*return cap === 'custom' \? null : cap;/,
    );
  });

  it('presignAvatar helper: null on no key OR no r2Public OR presign failure (warn-log + swallow — stale /me read never 500s on R2 hiccup)', () => {
    expect(body).toMatch(
      /\/\/ V-352b — best-effort presigned GET URL for the avatar\. Returns null\s*\/\/ when no avatar is set, when the public R2 bucket is not configured,\s*\/\/ or when the presign call itself fails \(logged \+ swallowed: a stale\s*\/\/ \/me read should never 500 just because R2 hiccuped\)\./,
    );
    expect(body).toMatch(
      /async function presignAvatar\(key: string \| null\): Promise<string \| null> \{\s*if \(!key\) return null;\s*if \(!r2Public\) return null;[\s\S]+?app\.log\.warn\(\{ err, key \}, 'avatar presign failed'\);\s*return null;/,
    );
  });

  it('GET /me parallel fan-out: Promise.all [countActiveSessions, countByAccount, presignAvatar, mfaService?.getStatus ?? null, oauthAvatarFallback] — 5-promise shape after the OAuth IDP avatar fallback landed', () => {
    expect(body).toMatch(
      /\/\/ Parallel fan-out: counts \+ tier-derived caps \+ avatar presign \+ MFA\.\s*\/\/ Tier caps come from in-memory constants so they cost nothing\./,
    );
    expect(body).toMatch(
      /const \[activeSessions, profileCount, r2AvatarUrl, mfaStatus, oauthFallback\] =\s*await Promise\.all\(\[\s*sessionRepo\.countActiveSessions\(accountId\),\s*profilesRepo\.countByAccount\(accountId\),\s*presignAvatar\(ctx\.account\.avatarR2Key\),\s*mfaService \? mfaService\.getStatus\(accountId\) : Promise\.resolve\(null\),\s*ctx\.account\.avatarR2Key \? Promise\.resolve\(null\) : oauthAvatarFallback\(accountId\),\s*\]\);/,
    );
  });

  it('GET /me reply includes avatar URL plus its removable user / read-only IDP / none source', () => {
    expect(body).toMatch(/id: `acc_\$\{accountId\}`,/);
    expect(body).toMatch(/timezone: ctx\.account\.timezone,/);
    expect(body).toMatch(/\/\/ V-298a — readable account handle \(null when unset\)\./);
    expect(body).toMatch(/slug: ctx\.account\.slug,/);
    expect(body).toMatch(/\/\/ V-298b — data-residency region preference \(null when unset\)\./);
    expect(body).toMatch(/region: ctx\.account\.region,/);
    expect(body).toMatch(/avatar_url: avatarUrl,/);
    expect(body).toMatch(/avatar_source: avatarSource,/);
    expect(body).toMatch(/\/\/ V-353h — MFA enrollment flag for dashboard header \/ settings\./);
    expect(body).toMatch(/mfa_enrolled: mfaStatus !== null && mfaStatus\.enrolled,/);
    expect(body).toMatch(/concurrent_session_cap: TIER_CONCURRENT_SESSION_LIMITS\[tier\],/);
    expect(body).toMatch(/concurrent_session_active: activeSessions,/);
    expect(body).toMatch(/profile_cap: profileCapFor\(tier\),/);
    expect(body).toMatch(/profile_count: profileCount,/);
  });

  it('V-326c teams shape: ctx.teams.map → { owner_account_id=acc_ + owner_email + owner_name + role + membership_id=mem_ }', () => {
    expect(body).toMatch(
      /\/\/ V-326c — owner accounts the caller is a member of \(empty\s*\/\/ array when not on any team\)\. Each entry exposes the public\s*\/\/ owner id \+ the owner's email\/name/,
    );
    expect(body).toMatch(
      /teams: ctx\.teams\.map\(\(t\) => \(\{\s*owner_account_id: `acc_\$\{t\.ownerAccountId\}`,\s*owner_email: t\.ownerEmail \?\? `acc_\$\{t\.ownerAccountId\}`,\s*owner_name: t\.ownerName \?\? null,\s*role: t\.role,\s*membership_id: `mem_\$\{t\.membershipId\}`,\s*\}\)\),/,
    );
  });

  it("V-298a PATCH SLUG_TAKEN → 409 ConflictError 'That slug is already taken. Pick a different one.'", () => {
    expect(body).toMatch(
      /\/\/ V-298a — repo throws SLUG_TAKEN when the unique-constraint\s*\/\/ collides with another account's slug\. 409 surfaces it\./,
    );
    expect(body).toMatch(
      /if \(err instanceof Error && err\.message === 'SLUG_TAKEN'\) \{\s*throw new ConflictError\('That slug is already taken\. Pick a different one\.'\);/,
    );
  });

  it('PATCH /me: UpdateAccountMeRequestSchema safeParse + first-issue BadRequestError; authRepo.updateAccountBasics; NotFoundError on missing; auth-cache invalidate best-effort', () => {
    expect(body).toMatch(
      /const parsed = UpdateAccountMeRequestSchema\.safeParse\(request\.body \?\? \{\}\);\s*if \(!parsed\.success\) \{\s*throw new BadRequestError\(parsed\.error\.issues\[0\]\?\.message \?\? 'Invalid body\.'\);/,
    );
    expect(body).toMatch(
      /updated = await authRepo\.updateAccountBasics\(ctx\.account\.id, parsed\.data\);/,
    );
    expect(body).toMatch(/if \(!updated\) throw new NotFoundError\('Account not found\.'\);/);
    expect(body).toMatch(
      /\/\/ Invalidate the cached AccountContext so the next request reads\s*\/\/ the freshly-updated row\. Best-effort; cache failure must never\s*\/\/ block the user-facing op\./,
    );
    expect(body).toMatch(
      /if \(authCache\) \{\s*try \{\s*await authCache\.invalidateAccount\(ctx\.account\.id\);\s*\} catch \{\s*\/\* swallow \*\/\s*\}\s*\}/,
    );
  });

  it('V-352b avatar POST: bodyLimit 3.5 MiB (2 MiB raw → ~2.8 MiB base64 + JSON envelope rationale); r2Public null → FeatureUnavailableError', () => {
    expect(body).toMatch(
      /\/\/ bodyLimit override: Fastify defaults to 1 MiB JSON\. A 2 MiB raw\s*\/\/ image becomes ~2\.8 MiB base64; we cap the route at 3\.5 MiB so a\s*\/\/ legitimate 2 MiB upload \+ JSON envelope fits and anything beyond\s*\/\/ is short-circuited as 413 by Fastify before our handler runs\./,
    );
    expect(body).toMatch(/bodyLimit: 3\.5 \* 1024 \* 1024,/);
    expect(body).toMatch(
      /if \(!r2Public\) \{\s*throw new FeatureUnavailableError\('Avatar uploads are not available on this deployment\.'\);/,
    );
  });

  it('Avatar POST validation: invalid base64 → 400; empty bytes → 400; bytes > AVATAR_MAX_BYTES → 400; R2 putObject failure → FeatureUnavailableError', () => {
    expect(body).toMatch(
      /bytes = Buffer\.from\(parsed\.data\.data_base64, 'base64'\);[\s\S]+?throw new BadRequestError\('data_base64 is not valid base64\.'\);/,
    );
    expect(body).toMatch(
      /if \(bytes\.length === 0\) \{\s*throw new BadRequestError\('Avatar image is empty\.'\);/,
    );
    expect(body).toMatch(
      /if \(bytes\.length > AVATAR_MAX_BYTES\) \{\s*throw new BadRequestError\(`Avatar image is too large\. Max \$\{AVATAR_MAX_BYTES\} bytes\.`\);/,
    );
    expect(body).toMatch(
      /app\.log\.error\(\{ err, key \}, 'avatar upload to R2 failed'\);\s*throw new FeatureUnavailableError\('Avatar storage is temporarily unavailable\.'\);/,
    );
  });

  it('Avatar DELETE: clear avatarR2Key pointer; 204; R2 object left for sweeper rationale ("public bucket already public-readable; stale objects no worse")', () => {
    expect(body).toMatch(
      /\/\/ V-352b — clear the avatar pointer on the account row\. The R2\s*\/\/ object is intentionally left in place: a future sweeper job\s*\/\/ collects orphaned avatar keys \(off the hot path; avatars are\s*\/\/ already public-readable so leaving stale objects is no worse\s*\/\/ than the public bucket already is\)\. Returns 204\./,
    );
    expect(body).toMatch(
      /const updated = await authRepo\.updateAccountBasics\(ctx\.account\.id, \{\s*avatarR2Key: null,\s*\}\);[\s\S]+?reply\.code\(204\);\s*return null;/,
    );
  });

  it('AccountMeRoutesOptions: sessionRepo + profilesRepo + authRepo + optional authCache/r2Public/mfaService with V-352/V-352b/V-353h framing', () => {
    expect(body).toMatch(/export interface AccountMeRoutesOptions \{/);
    expect(body).toMatch(
      /\/\*\* Session count source — same repo SessionsService uses\. \*\/\s*sessionRepo: SessionRepo;/,
    );
    expect(body).toMatch(
      /\/\*\* Profile count source — same repo ProfilesService uses\. \*\/\s*profilesRepo: ProfilesRepo;/,
    );
    expect(body).toMatch(/authRepo: AccountAuthRepo;/);
    expect(body).toMatch(/authCache\?: AuthCache \| null;/);
    expect(body).toMatch(/r2Public\?: R2 \| null;/);
    expect(body).toMatch(/mfaService\?: MfaService \| null;/);
  });

  it('imports: FastifyInstance + account schemas/caps + effective-account resolver/header + route deps + complete error set', () => {
    expect(body).toMatch(/import \{ randomUUID \} from 'node:crypto';/);
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    // Audit emit for proxy lifecycle (proxy.created / proxy.deleted).
    expect(body).toMatch(
      /import type \{ AccountAuditService \} from '\.\.\/services\/account-audit\.js';/,
    );
    expect(body).toMatch(/import \{ readClientIp \} from '\.\.\/lib\/client-ip\.js';/);
    expect(body).toMatch(
      /import \{\s*AccountOrganizationSchema,\s*AccountProxyInputSchema,\s*AccountProxyUpdateSchema,\s*AVATAR_MAX_BYTES,\s*PROFILES_PER_TIER,\s*PROXIES_PER_TIER,\s*TIER_CONCURRENT_SESSION_LIMITS,\s*UpdateAccountMeRequestSchema,\s*UploadAvatarRequestSchema,\s*UuidSchema,\s*type AccountProxyMetadata,\s*type AccountTier,\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /import \{ resolveEffectiveAccount, type AccountAuthRepo \} from '\.\.\/services\/auth\.js';/,
    );
    expect(body).toMatch(
      /import \{ readEffectiveAccountHeader \} from '\.\.\/lib\/effective-account-header\.js';/,
    );
    expect(body).toMatch(/import type \{ AuthCache \} from '\.\.\/services\/auth-cache\.js';/);
    expect(body).toMatch(/import type \{ SessionRepo \} from '\.\.\/services\/sessions\.js';/);
    expect(body).toMatch(/import type \{ ProfilesRepo \} from '\.\.\/services\/profiles\.js';/);
    expect(body).toMatch(/import type \{ MfaService \} from '\.\.\/services\/mfa\.js';/);
    expect(body).toMatch(/import \{ avatarKey, type R2 \} from '\.\.\/lib\/r2\.js';/);
    expect(body).toMatch(
      /import \{\s*BadRequestError,\s*ConflictError,\s*FeatureUnavailableError,\s*ForbiddenError,\s*NotFoundError,\s*\} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('proxy writes preallocate a UUID, use record-bound slots, enforce the cap atomically, validate path UUIDs, and scheme-CAS partial updates', () => {
    expect(body).toContain("from '../lib/account-proxy-secret-encryption.js'");
    expect(body).toContain("{ accountId, proxyId, slot: 'password' }");
    expect(body).toContain("wrapProxySecret(accountId, proxyId, 'openvpn-config', secret)");
    expect(body).toContain(
      "wrapProxySecret(accountId, proxyId, 'wireguard-private-key', private_key)",
    );
    expect(body).toMatch(
      /const id = randomUUID\(\);[\s\S]*?const proxyCap = PROXIES_PER_TIER\[ctx\.account\.tier\];[\s\S]*?proxyCap === 'custom'[\s\S]*?accountProxiesRepo\.create\(ctx\.account\.id, input\)[\s\S]*?createIfUnderLimit\(ctx\.account\.id, input, proxyCap\)/,
    );
    expect(body).not.toContain('MAX_PROXIES_PER_ACCOUNT');
    expect(body).not.toContain('accountProxiesRepo.list(ctx.account.id)).length');
    expect(body).toMatch(
      /function parseProxyId\(value: string\): string \{[\s\S]*?UuidSchema\.safeParse\(value\)[\s\S]*?BadRequestError\('Proxy id must be a valid UUID\.'\)/,
    );
    expect(body.match(/const id = parseProxyId\(/g)).toHaveLength(3);
    expect(body).toContain("existing.scheme === 'openvpn' || existing.scheme === 'wireguard'");
    expect(body).toContain('expectedScheme: existing.scheme');
    expect(body).toContain(
      "throw new ConflictError('Proxy changed concurrently. Retry the update.')",
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
