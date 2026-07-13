// W420.C — drift guard for apps/server/src/routes/account-me.ts.
// V-237 customer self-profile + V-352 PATCH basics + V-352b avatar
// upload/clear + V-353h MFA enrollment surface + V-298a slug
// uniqueness + V-298b region + V-326c teams memberships + V-330
// effective-account NOT honored (always self-account by design).
// Drift here either accidentally honors X-Driftstack-Account on
// /v1/account/me (surprising semantics — acts on owner's name) or
// drops the auth-cache invalidation on PATCH (stale dashboard until
// TTL).
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

  it('V-237 framing pinned: GET /v1/account/me identity + tier + concurrent-session usage/cap + profile usage/cap; file 128 spec mirror', () => {
    expect(body).toMatch(/V-237 — customer self-profile endpoint\./);
    expect(body).toMatch(
      /GET \/v1\/account\/me — returns the calling account's identity \+ tier\s*\n?\s*\/\/\s*\+ concurrent-session usage\/cap \+ profile usage\/cap\. Powers the GUI\s*\n?\s*\/\/\s*client's tier-aware enforcement display \(file 128 spec mirror\) so\s*\n?\s*\/\/\s*the customer sees "X \/ Y concurrent sessions" \+ "P \/ Q profiles"\s*\n?\s*\/\/\s*before the API enforces the cap with a 402\./,
    );
    expect(body).toMatch(
      /Distinct from `\/v1\/account\/rate-limits` \(per-bucket limit config\)\s*\n?\s*\/\/\s*and `\/v1\/account\/audit-log` \(event ledger\) — this is the dashboard\s*\n?\s*\/\/\s*header view\./,
    );
  });

  it('V-352 effective-account NOT honored: /me always self-account; team-owner edits land in V-352c with explicit semantics', () => {
    expect(body).toMatch(
      /\/\/ Note: V-326 effective-account header is intentionally NOT honored\s*\n?\s*\/\/ — \/v1\/account\/me always operates on the caller's own account\.\s*\n?\s*\/\/ Acting on a team owner's account\.name \/ timezone would be\s*\n?\s*\/\/ surprising; if needed, lands in V-352c with explicit semantics\./,
    );
  });

  it('V-352b avatar TTL framing pinned: AVATAR_PRESIGN_TTL_SECONDS = 60*60 (1h rotating-secret invalidates outstanding URLs <1h rationale)', () => {
    expect(body).toMatch(
      /\/\*\* V-352b — avatar presigned-GET TTL\. 1h is long enough that a single\s*\n?\s*\*\s*dashboard render doesn't churn signed URLs but short enough that\s*\n?\s*\*\s*rotating the bucket secret invalidates outstanding URLs in <1h\. \*\/\s*\n?\s*const AVATAR_PRESIGN_TTL_SECONDS = 60 \* 60;/,
    );
  });

  it("profileCapFor: PROFILES_PER_TIER 'custom' → null (enterprise = no fixed cap; see contract); numeric otherwise", () => {
    expect(body).toMatch(
      /\* Resolve the profile cap for a tier\. `PROFILES_PER_TIER` returns\s*\n?\s*\*\s*`'custom'` for enterprise \(negotiated per-customer\); we surface\s*\n?\s*\*\s*that as `null` to the customer \(read: "no fixed cap on this tier;\s*\n?\s*\*\s*see your contract"\)\. All other tiers return a numeric cap\./,
    );
    expect(body).toMatch(
      /function profileCapFor\(tier: AccountTier\): number \| null \{\s*\n?\s*const cap = PROFILES_PER_TIER\[tier\];\s*\n?\s*return cap === 'custom' \? null : cap;/,
    );
  });

  it('presignAvatar helper: null on no key OR no r2Public OR presign failure (warn-log + swallow — stale /me read never 500s on R2 hiccup)', () => {
    expect(body).toMatch(
      /\/\/ V-352b — best-effort presigned GET URL for the avatar\. Returns null\s*\n?\s*\/\/ when no avatar is set, when the public R2 bucket is not configured,\s*\n?\s*\/\/ or when the presign call itself fails \(logged \+ swallowed: a stale\s*\n?\s*\/\/ \/me read should never 500 just because R2 hiccuped\)\./,
    );
    expect(body).toMatch(
      /async function presignAvatar\(key: string \| null\): Promise<string \| null> \{\s*\n?\s*if \(!key\) return null;\s*\n?\s*if \(!r2Public\) return null;[\s\S]+?app\.log\.warn\(\{ err, key \}, 'avatar presign failed'\);\s*\n?\s*return null;/,
    );
  });

  it('GET /me parallel fan-out: Promise.all [countActiveSessions, countByAccount, presignAvatar, mfaService?.getStatus ?? null, oauthAvatarFallback] — 5-promise shape after the OAuth IDP avatar fallback landed', () => {
    expect(body).toMatch(
      /\/\/ Parallel fan-out: counts \+ tier-derived caps \+ avatar presign \+ MFA\.\s*\n?\s*\/\/ Tier caps come from in-memory constants so they cost nothing\./,
    );
    expect(body).toMatch(
      /const \[activeSessions, profileCount, r2AvatarUrl, mfaStatus, oauthFallback\] =\s*\n?\s*await Promise\.all\(\[\s*\n?\s*sessionRepo\.countActiveSessions\(accountId\),\s*\n?\s*profilesRepo\.countByAccount\(accountId\),\s*\n?\s*presignAvatar\(ctx\.account\.avatarR2Key\),\s*\n?\s*mfaService \? mfaService\.getStatus\(accountId\) : Promise\.resolve\(null\),\s*\n?\s*ctx\.account\.avatarR2Key \? Promise\.resolve\(null\) : oauthAvatarFallback\(accountId\),\s*\n?\s*\]\);/,
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
      /\/\/ V-326c — owner accounts the caller is a member of \(empty\s*\n?\s*\/\/ array when not on any team\)\. Each entry exposes the public\s*\n?\s*\/\/ owner id \+ the owner's email\/name/,
    );
    expect(body).toMatch(
      /teams: ctx\.teams\.map\(\(t\) => \(\{\s*\n?\s*owner_account_id: `acc_\$\{t\.ownerAccountId\}`,\s*\n?\s*owner_email: t\.ownerEmail \?\? `acc_\$\{t\.ownerAccountId\}`,\s*\n?\s*owner_name: t\.ownerName \?\? null,\s*\n?\s*role: t\.role,\s*\n?\s*membership_id: `mem_\$\{t\.membershipId\}`,\s*\n?\s*\}\)\),/,
    );
  });

  it("V-298a PATCH SLUG_TAKEN → 409 ConflictError 'That slug is already taken. Pick a different one.'", () => {
    expect(body).toMatch(
      /\/\/ V-298a — repo throws SLUG_TAKEN when the unique-constraint\s*\n?\s*\/\/ collides with another account's slug\. 409 surfaces it\./,
    );
    expect(body).toMatch(
      /if \(err instanceof Error && err\.message === 'SLUG_TAKEN'\) \{\s*\n?\s*throw new ConflictError\('That slug is already taken\. Pick a different one\.'\);/,
    );
  });

  it('PATCH /me: UpdateAccountMeRequestSchema safeParse + first-issue BadRequestError; authRepo.updateAccountBasics; NotFoundError on missing; auth-cache invalidate best-effort', () => {
    expect(body).toMatch(
      /const parsed = UpdateAccountMeRequestSchema\.safeParse\(request\.body \?\? \{\}\);\s*\n?\s*if \(!parsed\.success\) \{\s*\n?\s*throw new BadRequestError\(parsed\.error\.issues\[0\]\?\.message \?\? 'Invalid body\.'\);/,
    );
    expect(body).toMatch(
      /updated = await authRepo\.updateAccountBasics\(ctx\.account\.id, parsed\.data\);/,
    );
    expect(body).toMatch(/if \(!updated\) throw new NotFoundError\('Account not found\.'\);/);
    expect(body).toMatch(
      /\/\/ Invalidate the cached AccountContext so the next request reads\s*\n?\s*\/\/ the freshly-updated row\. Best-effort; cache failure must never\s*\n?\s*\/\/ block the user-facing op\./,
    );
    expect(body).toMatch(
      /if \(authCache\) \{\s*\n?\s*try \{\s*\n?\s*await authCache\.invalidateAccount\(ctx\.account\.id\);\s*\n?\s*\} catch \{\s*\n?\s*\/\* swallow \*\/\s*\n?\s*\}\s*\n?\s*\}/,
    );
  });

  it('V-352b avatar POST: bodyLimit 3.5 MiB (2 MiB raw → ~2.8 MiB base64 + JSON envelope rationale); r2Public null → FeatureUnavailableError', () => {
    expect(body).toMatch(
      /\/\/ bodyLimit override: Fastify defaults to 1 MiB JSON\. A 2 MiB raw\s*\n?\s*\/\/ image becomes ~2\.8 MiB base64; we cap the route at 3\.5 MiB so a\s*\n?\s*\/\/ legitimate 2 MiB upload \+ JSON envelope fits and anything beyond\s*\n?\s*\/\/ is short-circuited as 413 by Fastify before our handler runs\./,
    );
    expect(body).toMatch(/bodyLimit: 3\.5 \* 1024 \* 1024,/);
    expect(body).toMatch(
      /if \(!r2Public\) \{\s*\n?\s*throw new FeatureUnavailableError\('Avatar uploads are not available on this deployment\.'\);/,
    );
  });

  it('Avatar POST validation: invalid base64 → 400; empty bytes → 400; bytes > AVATAR_MAX_BYTES → 400; R2 putObject failure → FeatureUnavailableError', () => {
    expect(body).toMatch(
      /bytes = Buffer\.from\(parsed\.data\.data_base64, 'base64'\);[\s\S]+?throw new BadRequestError\('data_base64 is not valid base64\.'\);/,
    );
    expect(body).toMatch(
      /if \(bytes\.length === 0\) \{\s*\n?\s*throw new BadRequestError\('Avatar image is empty\.'\);/,
    );
    expect(body).toMatch(
      /if \(bytes\.length > AVATAR_MAX_BYTES\) \{\s*\n?\s*throw new BadRequestError\(`Avatar image is too large\. Max \$\{AVATAR_MAX_BYTES\} bytes\.`\);/,
    );
    expect(body).toMatch(
      /app\.log\.error\(\{ err, key \}, 'avatar upload to R2 failed'\);\s*\n?\s*throw new FeatureUnavailableError\('Avatar storage is temporarily unavailable\.'\);/,
    );
  });

  it('Avatar DELETE: clear avatarR2Key pointer; 204; R2 object left for sweeper rationale ("public bucket already public-readable; stale objects no worse")', () => {
    expect(body).toMatch(
      /\/\/ V-352b — clear the avatar pointer on the account row\. The R2\s*\n?\s*\/\/ object is intentionally left in place: a future sweeper job\s*\n?\s*\/\/ collects orphaned avatar keys \(off the hot path; avatars are\s*\n?\s*\/\/ already public-readable so leaving stale objects is no worse\s*\n?\s*\/\/ than the public bucket already is\)\. Returns 204\./,
    );
    expect(body).toMatch(
      /const updated = await authRepo\.updateAccountBasics\(ctx\.account\.id, \{\s*\n?\s*avatarR2Key: null,\s*\n?\s*\}\);[\s\S]+?reply\.code\(204\);\s*\n?\s*return null;/,
    );
  });

  it('AccountMeRoutesOptions: sessionRepo + profilesRepo + authRepo + optional authCache/r2Public/mfaService with V-352/V-352b/V-353h framing', () => {
    expect(body).toMatch(/export interface AccountMeRoutesOptions \{/);
    expect(body).toMatch(
      /\/\*\* Session count source — same repo SessionsService uses\. \*\/\s*\n?\s*sessionRepo: SessionRepo;/,
    );
    expect(body).toMatch(
      /\/\*\* Profile count source — same repo ProfilesService uses\. \*\/\s*\n?\s*profilesRepo: ProfilesRepo;/,
    );
    expect(body).toMatch(/authRepo: AccountAuthRepo;/);
    expect(body).toMatch(/authCache\?: AuthCache \| null;/);
    expect(body).toMatch(/r2Public\?: R2 \| null;/);
    expect(body).toMatch(/mfaService\?: MfaService \| null;/);
  });

  it('imports: FastifyInstance + AVATAR_MAX_BYTES/PROFILES_PER_TIER/TIER_CONCURRENT_SESSION_LIMITS/UpdateAccountMe/UploadAvatar + AccountAuthRepo/AuthCache/SessionRepo/ProfilesRepo/MfaService + avatarKey/R2 + BadRequest/Conflict/FeatureUnavailable/NotFound errors', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    // Audit emit for proxy lifecycle (proxy.created / proxy.deleted).
    expect(body).toMatch(
      /import type \{ AccountAuditService \} from '\.\.\/services\/account-audit\.js';/,
    );
    expect(body).toMatch(/import \{ readClientIp \} from '\.\.\/lib\/client-ip\.js';/);
    expect(body).toMatch(
      /import \{\s*\n?\s*AccountOrganizationSchema,\s*\n?\s*AccountProxyInputSchema,\s*\n?\s*AccountProxyUpdateSchema,\s*\n?\s*AVATAR_MAX_BYTES,\s*\n?\s*PROFILES_PER_TIER,\s*\n?\s*TIER_CONCURRENT_SESSION_LIMITS,\s*\n?\s*UpdateAccountMeRequestSchema,\s*\n?\s*UploadAvatarRequestSchema,\s*\n?\s*type AccountProxyMetadata,\s*\n?\s*type AccountTier,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ AccountAuthRepo \} from '\.\.\/services\/auth\.js';/);
    expect(body).toMatch(/import type \{ AuthCache \} from '\.\.\/services\/auth-cache\.js';/);
    expect(body).toMatch(/import type \{ SessionRepo \} from '\.\.\/services\/sessions\.js';/);
    expect(body).toMatch(/import type \{ ProfilesRepo \} from '\.\.\/services\/profiles\.js';/);
    expect(body).toMatch(/import type \{ MfaService \} from '\.\.\/services\/mfa\.js';/);
    expect(body).toMatch(/import \{ avatarKey, type R2 \} from '\.\.\/lib\/r2\.js';/);
    expect(body).toMatch(
      /import \{\s*\n?\s*BadRequestError,\s*\n?\s*ConflictError,\s*\n?\s*FeatureUnavailableError,\s*\n?\s*NotFoundError,\s*\n?\s*\} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
