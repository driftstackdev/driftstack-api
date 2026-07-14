// W404.B — drift guard for apps/server/src/services/auth.ts.
// Authentication entrypoint — dual-path (API key + V-168 web
// session). Drift here either breaks the V-247 cache fast path
// (revocation cache-window regression) or weakens the V-174 scope
// alias (cross-tenant admin exposure).
//
//   • Repo-decoupled framing pinned: AccountAuthRepo interface for
//     Drizzle-prod + in-memory tests.
//   • CACHE_TTL_SEC = 30.
//   • V-168 dual-path: ds_-prefix → API key (prefix lookup + scrypt
//     verify); else → web session (sha256 lookup against
//     web_sessions row).
//   • Cache fast path: re-check expiresAt on every read; exact live
//     PostgreSQL authority on every web-session hit; API-key hits
//     retain their DB/scrypt bypass; cache.get/set wrapped in
//     try/catch for graceful degradation.
//   • Slow-path API key: 5 failure modes (no row → InvalidKey;
//     hash mismatch → InvalidKey; revoked → RevokedKey; expired →
//     ExpiredKey; account suspended → Forbidden; account deleted →
//     InvalidKey).
//   • V-168 slow-path web session: synthetic ApiKeyRow with id=
//     wsk_<sessionId> + V-174 scopes ['read','write','account_owner']
//     (NOT 'admin' — closes cross-account admin exposure).
//   • Web session known-gap framing: pre-V-168 admin-customer-key
//     cross-account risk acknowledged + operationally mitigated by
//     V-135 admin.driftstack.dev Cloudflare-Access gate.
//   • requireScope: V-174 admin compat alias (admin satisfies
//     account_owner + driftstack_internal_admin) + V-481 broad-
//     satisfies-granular (read:X from read|account_owner;
//     write:X from write|account_owner; admin:X from admin|
//     account_owner).
//   • V-326 resolveEffectiveAccount: X-Driftstack-Account header
//     resolution; 403 on cross-account; self short-circuit when
//     requested = ctx.account.id.
//   • AccountRow: 11 fields with V-352 timezone + V-352b
//     avatarR2Key + V-298a slug + V-298b region all nullable;
//     status 3-literal ('active'|'suspended'|'deleted').
//   • V-353d/e WebSessionAuthRow.mfaSatisfiedAt: step-up gates
//     check now - mfaSatisfiedAt < 15min.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W404.B apps/server/src/services/auth.ts content parity', () => {
  const body = read(LIB);

  it('Repo-decoupled framing pinned + CACHE_TTL_SEC = 30', () => {
    expect(body).toMatch(
      /The service is decoupled from Drizzle via an `AccountAuthRepo` interface\s*\n?\s*\/\/\s*so unit tests can use an in-memory fake\. The real implementation lives in\s*\n?\s*\/\/\s*`apps\/server\/src\/db\/auth-repo\.ts`\./,
    );
    expect(body).toMatch(/const CACHE_TTL_SEC = 30;/);
  });

  it('AccountRow: 11 fields with V-352 timezone + V-352b avatarR2Key + V-298a slug + V-298b region nullable; status 3-literal', () => {
    expect(body).toMatch(/export interface AccountRow \{/);
    expect(body).toMatch(/status: 'active' \| 'suspended' \| 'deleted';/);
    expect(body).toMatch(
      /\/\*\* V-352 — IANA timezone name \(e\.g\. "Europe\/Amsterdam"\)\. null = UTC fallback\. \*\/\s*\n?\s*timezone: string \| null;/,
    );
    expect(body).toMatch(
      /\/\*\* V-352b — R2 object key for the customer's uploaded avatar\.[\s\S]+?avatarR2Key: string \| null;/,
    );
    expect(body).toMatch(
      /\/\*\* V-298a — readable account handle \(lowercase a-z \+ 0-9 \+ hyphen,[\s\S]+?slug: string \| null;/,
    );
    expect(body).toMatch(
      /\/\*\* V-298b — Stripe-style data-residency region preference: 'us',[\s\S]+?region: 'us' \| 'eu' \| 'apac' \| null;/,
    );
  });

  it('V-168 WebSessionAuthRow: 7 fields with V-353d/e mfaSatisfiedAt step-up gate (15-min freshness window)', () => {
    expect(body).toMatch(/V-168 — minimal web-session shape needed by authenticate\(\)\./);
    expect(body).toMatch(/export interface WebSessionAuthRow \{/);
    expect(body).toMatch(/expiresAt: Date;/);
    expect(body).toMatch(/revokedAt: Date \| null;/);
    expect(body).toMatch(
      /\/\*\* V-353d\/e — most recent successful MFA challenge on this session,\s*\n?\s*\*\s*or null if never satisfied\. Step-up gates check\s*\n?\s*\*\s*`now - mfaSatisfiedAt < 15min`\. \*\/\s*\n?\s*mfaSatisfiedAt: Date \| null;/,
    );
  });

  it('AccountAuthRepo: 7 methods — findApiKeyByPrefix + getAccount + touchApiKeyLastUsed + findActiveRateLimitOverrides + V-168 findActiveWebSession + touchWebSessionLastUsed + V-326 findTeamMemberships + V-352 updateAccountBasics', () => {
    expect(body).toMatch(/export interface AccountAuthRepo \{/);
    expect(body).toMatch(/findApiKeyByPrefix\(prefix: string\): Promise<ApiKeyRow \| null>;/);
    expect(body).toMatch(/getAccount\(id: string\): Promise<AccountRow \| null>;/);
    expect(body).toMatch(/touchApiKeyLastUsed\(id: string, at: Date\): Promise<void>;/);
    expect(body).toMatch(
      /findActiveRateLimitOverrides\(accountId: string, now: Date\): Promise<RateLimitOverride\[\]>;/,
    );
    expect(body).toMatch(
      /findActiveWebSession\(args: \{ tokenHash: string; now: Date \}\): Promise<WebSessionAuthRow \| null>;/,
    );
    expect(body).toMatch(/touchWebSessionLastUsed\(id: string, at: Date\): Promise<void>;/);
    expect(body).toMatch(
      /findTeamMemberships\(memberAccountId: string\): Promise<TeamMembership\[\]>;/,
    );
    expect(body).toMatch(
      /updateAccountBasics\([\s\S]+?id: string,[\s\S]+?patch: \{[\s\S]+?name\?: string \| null;[\s\S]+?timezone\?: string \| null;[\s\S]+?avatarR2Key\?: string \| null;[\s\S]+?slug\?: string \| null;[\s\S]+?region\?: 'us' \| 'eu' \| 'apac' \| null;/,
    );
  });

  it('extractBearerToken: BEARER_RE regex + 2 error paths (missing header + malformed)', () => {
    expect(body).toMatch(/const BEARER_RE = \/\^Bearer\\s\+\(\\S\+\)\\s\*\$\/i;/);
    expect(body).toMatch(
      /if \(!authorizationHeader\) \{\s*\n?\s*throw new UnauthorizedError\('Missing Authorization header\.'\);/,
    );
    expect(body).toMatch(
      /throw new UnauthorizedError\('Malformed Authorization header\. Expected "Bearer <key>"\.'\);/,
    );
  });

  it('authenticate: plaintext.length < 24 → InvalidKey; cache fast path with expiresAt re-check on read', () => {
    expect(body).toMatch(/if \(plaintext\.length < 24\) throw new InvalidKeyError\(\);/);
    expect(body).toMatch(
      /\/\/ Expiry is clock-bound, so re-check it on every cache read even when\s*\n?\s*\/\/ the backing authority has not changed\./,
    );
    expect(body).toMatch(
      /if \(cached\.apiKey\.expiresAt !== null && cached\.apiKey\.expiresAt\.getTime\(\) <= now\.getTime\(\)\) \{\s*\n?\s*throw new ExpiredKeyError\(\);/,
    );
  });

  it('positive web-session cache hits revalidate exact live PostgreSQL authority and refresh MFA state', () => {
    expect(body).toMatch(/if \(cached\.webSession !== null\) \{/);
    expect(body).toMatch(
      /const liveSession = await repo\.findActiveWebSession\(\{ tokenHash: sha, now \}\);/,
    );
    expect(body).toMatch(/liveSession\.id !== cached\.webSession\.id/);
    expect(body).toMatch(/liveSession\.accountId !== cached\.account\.id/);
    expect(body).toMatch(/liveSession\.accountId !== cached\.apiKey\.accountId/);
    expect(body).toMatch(/cached\.apiKey\.id !== `wsk_\$\{liveSession\.id\}`/);
    expect(body).toMatch(/mfaSatisfiedAt: liveSession\.mfaSatisfiedAt/);
    expect(body).toMatch(
      /API-key cache hits intentionally\s*\n?\s*\/\/ retain their existing DB\/scrypt bypass\./,
    );
  });

  it('V-168 isApiKeyShape: ds_-prefix dispatch (API key path) else web session path', () => {
    expect(body).toMatch(
      /V-168 — distinguish API keys from web session tokens by the `ds_`\s*\n?\s*\*\s*prefix that \{@link generateApiKey\} stamps on every key\./,
    );
    expect(body).toMatch(
      /function isApiKeyShape\(plaintext: string\): boolean \{\s*\n?\s*return plaintext\.startsWith\('ds_'\);\s*\n?\s*\}/,
    );
    // C4 — a ds_-shaped token with no matching API-key prefix falls through
    // to the web-session path instead of failing (chance ds_ session token).
    expect(body).toMatch(
      /const viaApiKey = await slowPathApiKey\(repo, plaintext, sha, cache, now, \{\s*\n?\s*fallThroughOnPrefixMiss: true,\s*\n?\s*\}\);\s*\n?\s*if \(viaApiKey !== null\) return viaApiKey;/,
    );
  });

  it('slowPathApiKey: 5-failure-mode cascade (InvalidKey × 3 + RevokedKey + ExpiredKey + Forbidden suspended + deleted=InvalidKey)', () => {
    expect(body).toMatch(/let apiKey = await repo\.findApiKeyByPrefix\(prefix\);/);
    // C4 — prefix miss returns null (dispatcher falls through to the web
    // session) when the caller allows it, else throws InvalidKeyError.
    expect(body).toMatch(
      /if \(!apiKey\) \{\s*\n?[\s\S]*?if \(opts\.fallThroughOnPrefixMiss\) return null;\s*\n?\s*throw new InvalidKeyError\(\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(/const matches = await verifyApiKey\(plaintext, apiKey\.keyHash\);/);
    expect(body).toMatch(/if \(!matches\) throw new InvalidKeyError\(\);/);
    expect(body).toMatch(/if \(apiKey\.revokedAt !== null\) throw new RevokedKeyError\(\);/);
    expect(body).toMatch(
      /if \(apiKey\.expiresAt !== null && apiKey\.expiresAt\.getTime\(\) <= now\.getTime\(\)\) \{\s*\n?\s*throw new ExpiredKeyError\(\);/,
    );
    expect(body).toMatch(
      /if \(!account\) throw new InvalidKeyError\(\); \/\/ FK invariant — treat as invalid/,
    );
    expect(body).toMatch(
      /if \(account\.status === 'suspended'\) \{\s*\n?\s*throw new ForbiddenError\('Account is suspended\.'\);/,
    );
    expect(body).toMatch(
      /if \(account\.status === 'deleted'\) \{\s*\n?\s*throw new InvalidKeyError\(\);/,
    );
  });

  it('slowPathApiKey captures cache generations, then revalidates exact key authority before caching', () => {
    expect(body).toMatch(
      /capturedVersions = await cache\.captureVersions\(apiKey\.accountId, apiKey\.id\)/,
    );
    expect(body).toMatch(/const revalidated = await repo\.findApiKeyByPrefix\(prefix\);/);
    expect(body).toMatch(
      /revalidated\.id !== apiKey\.id \|\| revalidated\.keyHash !== apiKey\.keyHash/,
    );
    expect(body).toMatch(/if \(revalidated\.revokedAt !== null\) throw new RevokedKeyError\(\);/);
    expect(body).toMatch(/ctx, ttl, capturedVersions/);
  });

  it('Cache write: TTL capped at expiresAt remaining seconds (min 1); try/catch swallow for graceful degradation', () => {
    expect(body).toMatch(
      /\/\/ Cap TTL at expiresAt so the cache entry can never outlive the key\./,
    );
    expect(body).toMatch(
      /if \(apiKey\.expiresAt !== null\) \{\s*\n?\s*const remaining = Math\.floor\(\(apiKey\.expiresAt\.getTime\(\) - now\.getTime\(\)\) \/ 1000\);\s*\n?\s*if \(remaining < ttl\) ttl = Math\.max\(1, remaining\);/,
    );
  });

  it('V-168 slowPathWebSession: synthetic ApiKeyRow with id=wsk_<sessionId> + V-174 baseScopes [read,write,account_owner] + 2026-05-19 DRIFTSTACK_STAFF_EMAILS adds driftstack_internal_admin when the dashboard user is on the allowlist', () => {
    expect(body).toMatch(/id: `wsk_\$\{session\.id\}`,/);
    expect(body).toMatch(/keyPrefix: 'web_session',/);
    expect(body).toMatch(
      /const baseScopes: ApiKeyRow\['scopes'\] = \['read', 'write', 'account_owner'\];/,
    );
    expect(body).toMatch(
      /const scopes: ApiKeyRow\['scopes'\] = staffEmails\.has\(accountEmail\)\s*\n?\s*\? \[\.\.\.baseScopes, 'driftstack_internal_admin'\]\s*\n?\s*: baseScopes;/,
    );
  });

  it('Web session V-174 framing: legacy admin scope removed (cross-account exposure closed), /v1/admin/* requires driftstack_internal_admin + V-135 Cloudflare-Access defense-in-depth', () => {
    expect(body).toMatch(
      /V-174 \(shipped\) closed the prior cross-account exposure: web sessions\s*\n?\s*\*\s*no longer carry the legacy `admin` scope/,
    );
    expect(body).toMatch(
      /`\/v1\/admin\/\*` now requires\s*\n?\s*\*\s*`driftstack_internal_admin`, granted only to staff-allowlisted/,
    );
    expect(body).toMatch(
      /`admin\.driftstack\.dev` remains a separate Cloudflare-Access-\s*\n?\s*\*\s*gated origin \(V-135\) as defense-in-depth\./,
    );
  });

  it('requireScope: V-174 admin alias + V-481 broad-satisfies-granular (read:X / write:X / admin:X)', () => {
    expect(body).toMatch(/V-174 \+ V-481 — scope check with backwards-compat aliases\./);
    expect(body).toMatch(/if \(scopes\.includes\(required\)\) return;/);
    expect(body).toMatch(
      /\/\/ V-174 admin alias\.\s*\n?\s*if \(\s*\n?\s*\(required === 'account_owner' \|\| required === 'driftstack_internal_admin'\) &&\s*\n?\s*scopes\.includes\('admin'\)\s*\n?\s*\) \{\s*\n?\s*return;/,
    );
    expect(body).toMatch(
      /\(verb === 'read' && \(scopes\.includes\('read'\) \|\| scopes\.includes\('account_owner'\)\)\) \|\|\s*\n?\s*\(verb === 'write' && \(scopes\.includes\('write'\) \|\| scopes\.includes\('account_owner'\)\)\) \|\|\s*\n?\s*\(verb === 'admin' && \(scopes\.includes\('admin'\) \|\| scopes\.includes\('account_owner'\)\)\)/,
    );
    expect(body).toMatch(
      /throw new ForbiddenError\(`This action requires the "\$\{required\}" scope\.`\);/,
    );
  });

  it('V-326 resolveEffectiveAccount: missing-header → kind:self; bad-prefix → ForbiddenError; non-member uuid → ForbiddenError; self-uuid → kind:self', () => {
    expect(body).toMatch(
      /export function resolveEffectiveAccount\(\s*\n?\s*ctx: AccountContext,\s*\n?\s*requestedAccountIdHeader: string \| undefined,\s*\n?\s*\): EffectiveAccount \{/,
    );
    expect(body).toMatch(
      /if \(!requestedAccountIdHeader \|\| requestedAccountIdHeader\.length === 0\) \{\s*\n?\s*return \{ kind: 'self', accountId: ctx\.account\.id \};/,
    );
    expect(body).toMatch(/const PREFIX = 'acc_';/);
    expect(body).toMatch(
      /if \(!requestedAccountIdHeader\.startsWith\(PREFIX\)\) \{\s*\n?\s*throw new ForbiddenError\(\s*\n?\s*'Invalid X-Driftstack-Account header\. Expected an account id of shape "acc_<uuid>"\.',/,
    );
    expect(body).toMatch(
      /if \(requestedUuid === ctx\.account\.id\) \{\s*\n?\s*return \{ kind: 'self', accountId: ctx\.account\.id \};\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /if \(!membership\) \{\s*\n?\s*throw new ForbiddenError\('X-Driftstack-Account references an account you are not a member of\.'\);/,
    );
  });

  it('EffectiveAccount: 2-kind union (self {accountId} | team {accountId, role, membership})', () => {
    expect(body).toMatch(
      /export type EffectiveAccount =\s*\n?\s*\| \{ kind: 'self'; accountId: string \}\s*\n?\s*\| \{\s*\n?\s*kind: 'team';\s*\n?\s*accountId: string;\s*\n?\s*role: 'member' \| 'admin';\s*\n?\s*membership: TeamMembership;\s*\n?\s*\};/,
    );
  });

  it('AccountContext: 5 fields with V-353e webSession nullable + V-326 teams always-present array', () => {
    expect(body).toMatch(/export interface AccountContext \{/);
    expect(body).toMatch(/account: AccountRow;/);
    expect(body).toMatch(/apiKey: ApiKeyRow;/);
    expect(body).toMatch(/rateLimitOverrides: Record<string, RateLimitOverride>;/);
    expect(body).toMatch(
      /\/\*\*[\s\S]+?V-326 — owner accounts this account is a member of, with role\.[\s\S]+?\*\/\s*\n?\s*teams: TeamMembership\[\];/,
    );
    expect(body).toMatch(
      /V-353e — populated when the request authenticated via a web\s*\n?\s*\*\s*session \(dashboard \/ GUI bearer\); null for API-key callers\./,
    );
    expect(body).toMatch(/webSession: \{ id: string; mfaSatisfiedAt: Date \| null \} \| null;/);
  });

  it('imports: errors (5 types) + api-keys helpers + AuthCache + sha256Hex + AuthCoalescer + ApiKeyScope + AccountTier', () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*ExpiredKeyError,\s*\n?\s*ForbiddenError,\s*\n?\s*InvalidKeyError,\s*\n?\s*RevokedKeyError,\s*\n?\s*UnauthorizedError,\s*\n?\s*\} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(
      /import \{ keyPrefixFromPlaintext, verifyApiKey \} from '\.\.\/lib\/api-keys\.js';/,
    );
    expect(body).toMatch(
      /import type \{ AuthCache, AuthCacheVersions \} from '\.\/auth-cache\.js';/,
    );
    expect(body).toMatch(/import \{ sha256Hex \} from '\.\/auth-cache\.js';/);
    expect(body).toMatch(/import type \{ AuthCoalescer \} from '\.\/auth-coalescer\.js';/);
    expect(body).toMatch(/import type \{ ApiKeyScope \} from '@driftstack\/api-types';/);
    expect(body).toMatch(/import type \{ AccountTier \} from '@driftstack\/api-types';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
