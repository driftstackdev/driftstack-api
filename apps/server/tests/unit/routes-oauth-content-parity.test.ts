// W438.B — drift guard for apps/server/src/routes/oauth.ts.
// V-667.B OAuth 2.0 Fastify route layer (PKCE + client_secret + code).
// Drift here either drops PKCE S256 literal validation (downgrade to
// 'plain' opens prefix-attack class) or drops client-bound token
// introspection/revocation (metadata disclosure / cross-client revoke).
//
//   • V-667.B framing pinned: admin, public provider, and interactive
//     dashboard-consent surfaces have distinct authentication gates.
//   • Admin: register/list/get-one/delete/V-667.E rotate-secret.
//   • Provider: authorize / token / introspect / V-667.C RFC 7009
//     revoke. Token lifecycle calls authenticate the confidential client.
//   • PKCE: code_challenge 43..128 + code_challenge_method literal
//     S256; code_verifier 43..128.
//   • state 8..256 (CSRF token min length).
//   • V-667.D single-client lookup: 404 if not exist; hashed secret
//     never exposed to admin UI; revoked_at shown for "who/when
//     revoked" ops audit.
//   • V-667.E rotate-secret: returns new plaintext ONCE; store keeps
//     only hash; existing access tokens NOT invalidated (bearer-auth;
//     secret only consulted on /token exchange).
//   • V-667.C revoke: authenticated clients get 200 for own, unknown,
//     and foreign tokens, but only their own token is mutated.
//   • introspect: authenticated foreign/unknown tokens collapse to false;
//     owned live tokens return client/account/scope/exp metadata.
//   • oauthErrorToHttp: invalid_client/unauthorized_client → 401;
//     invalid_request/_scope/_grant/access_denied → 400.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W438.B apps/server/src/routes/oauth.ts content parity', () => {
  const body = read(LIB);

  it('V-667.B framing pins separate admin, public provider, and interactive dashboard-consent surfaces', () => {
    expect(body).toMatch(/\/\/ V-667\.B — OAuth 2\.0 Fastify route layer\./);
    expect(body).toMatch(
      /\/\/\s*\* Admin \(auth-gated\):\s*\n?\s*\/\/\s*- POST\s+\/v1\/admin\/oauth\/clients\s+— register\s*\n?\s*\/\/\s*- GET\s+\/v1\/admin\/oauth\/clients\s+— list\s*\n?\s*\/\/\s*- DELETE \/v1\/admin\/oauth\/clients\/:id\s+— revoke/,
    );
    expect(body).toMatch(
      /\/\/\s*\* OAuth provider surface \(no account auth; client credentials protect\s*\n?\s*\/\/\s*token exchange, introspection, and revocation\):\s*\n?\s*\/\/\s*- GET\s+\/v1\/oauth\/authorize\s+— stage authorization\s*\n?\s*\/\/\s*- POST\s+\/v1\/oauth\/token\s+— code → access_token\s*\n?\s*\/\/\s*- POST\s+\/v1\/oauth\/introspect\s+— token validation/,
    );
    expect(body).toMatch(
      /\/\/\s*\* Interactive dashboard consent \(web-session \+ account-rate-limit gated\):\s*\n?\s*\/\/\s*- POST\s+\/v1\/oauth\/authorize\/complete\s+— approve staged authorization/,
    );
    expect(body).toMatch(
      /\/\/ Account context for \/authorize\/complete comes only from the dashboard's\s*\n?\s*\/\/ interactive web session\. General API keys are rejected so they cannot mint\s*\n?\s*\/\/ independently-lived OAuth tokens or outlive their own revocation\./,
    );
  });

  it('imports: FastifyInstance/Request + zod + ApiKeyScopeSchema from api-types + OAuthError/OAuthService + typed request errors', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(/import \{ ApiKeyScopeSchema \} from '@driftstack\/api-types';/);
    expect(body).toMatch(
      /import \{ OAuthError, type OAuthService \} from '\.\.\/services\/oauth\.js';/,
    );
    expect(body).toMatch(
      /import \{\s*BadRequestError,\s*ForbiddenError,\s*NotFoundError,\s*UnauthorizedError,\s*\} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(/import \{ requireTierFeature \} from '\.\.\/lib\/errors-helpers\.js';/);
  });

  it('RegisterClientBody: label 1..120 + redirect_uris array of URL min 1 max 10 + account_id uuid nullable optional', () => {
    expect(body).toMatch(
      /const RegisterClientBody = z\.object\(\{\s*\n?\s*label: z\.string\(\)\.min\(1\)\.max\(120\),\s*\n?\s*redirect_uris: z\.array\(z\.string\(\)\.max\(2048\)\.url\(\)\)\.min\(1\)\.max\(10\),\s*\n?\s*account_id: z\.string\(\)\.uuid\(\)\.nullable\(\)\.optional\(\),\s*\n?\s*\}\);/,
    );
    expect(body.match(/redirect_uri: z\.string\(\)\.max\(2048\)\.url\(\),/g)).toHaveLength(2);
  });

  it('PKCE AuthorizeQuery framing pinned: code_challenge 43..128 + code_challenge_method LITERAL S256 (no plain downgrade); state 8..256 CSRF; scope optional (≤1024 chars per slice 117 cap)', () => {
    expect(body).toMatch(
      /const AuthorizeQuery = z\.object\(\{\s*\n?\s*client_id: z\.string\(\)\.min\(1\)\.max\(128\),\s*\n?\s*redirect_uri: z\.string\(\)\.max\(2048\)\.url\(\),\s*\n?\s*state: z\.string\(\)\.min\(8\)\.max\(256\),\s*\n?\s*code_challenge: z\.string\(\)\.min\(43\)\.max\(128\),\s*\n?\s*code_challenge_method: z\.literal\('S256'\),\s*\n?\s*scope: z\.string\(\)\.max\(1024\)\.optional\(\),\s*\n?\s*\}\);/,
    );
  });

  it("ApproveAuthorization body: authorization_id ONLY (account_id removed — bound to the authed caller, cross-account-takeover guard); ExchangeCode body: grant_type literal 'authorization_code' + code + code_verifier 43..128 + client_id + client_secret + redirect_uri. Slice 117 added defensive max-length caps on previously-unbounded fields", () => {
    expect(body).toMatch(
      /const ApproveAuthorizationBody = z\.object\(\{\s*\n?\s*authorization_id: z\.string\(\)\.min\(1\)\.max\(128\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /const ExchangeCodeBody = z\.object\(\{\s*\n?\s*grant_type: z\.literal\('authorization_code'\),\s*\n?\s*code: z\.string\(\)\.min\(1\)\.max\(256\),\s*\n?\s*code_verifier: z\.string\(\)\.min\(43\)\.max\(128\),\s*\n?\s*client_id: z\.string\(\)\.min\(1\)\.max\(128\),\s*\n?\s*client_secret: z\.string\(\)\.min\(1\)\.max\(256\),\s*\n?\s*redirect_uri: z\.string\(\)\.max\(2048\)\.url\(\),\s*\n?\s*\}\);/,
    );
  });

  it('RFC 7662/7009 bodies require bounded client credentials; revoke retains optional token_type_hint', () => {
    expect(body).toMatch(
      /\/\/ V-667\.C — RFC 7009 revoke\. token_type_hint is informational\s*\n?\s*\/\/ \(access_token \| refresh_token\); we ignore it but accept it so\s*\n?\s*\/\/ off-the-shelf OAuth clients can post unchanged\./,
    );
    expect(body).toMatch(
      /const IntrospectBody = z\.object\(\{\s*token: z\.string\(\)\.min\(1\)\.max\(2048\),\s*client_id: z\.string\(\)\.min\(1\)\.max\(128\),\s*client_secret: z\.string\(\)\.min\(1\)\.max\(256\),\s*\}\);/,
    );
    expect(body).toMatch(
      /const RevokeBody = z\.object\(\{\s*token: z\.string\(\)\.min\(1\)\.max\(2048\),\s*client_id: z\.string\(\)\.min\(1\)\.max\(128\),\s*client_secret: z\.string\(\)\.min\(1\)\.max\(256\),\s*token_type_hint: z\.enum\(\['access_token', 'refresh_token'\]\)\.optional\(\),\s*\}\);/,
    );
  });

  it('Admin register: driftstack_internal_admin scope; registerClient with redirect_uris + account_id default null; 201 response', () => {
    expect(body).toMatch(
      /app\.post\(\s*\n?\s*'\/v1\/admin\/oauth\/clients',\s*\n?\s*\{ preHandler: \[app\.requireScope\('driftstack_internal_admin'\)\] \},/,
    );
    expect(body).toMatch(
      /const result = await deps\.service\.registerClient\(\{\s*\n?\s*label: body\.label,\s*\n?\s*redirect_uris: body\.redirect_uris,\s*\n?\s*account_id: body\.account_id \?\? null,\s*\n?\s*\}\);\s*\n?\s*return reply\.code\(201\)\.send\(result\);/,
    );
  });

  it('Admin list: never exposes hashed secret to admin UI (internal); maps client_id + label + redirect_uris + account_id + created_at ISO + revoked_at nullable ISO', () => {
    expect(body).toMatch(/\/\/ Never expose the hashed secret to the admin UI; it's internal\./);
    expect(body).toMatch(
      /clients: clients\.map\(\(c\) => \(\{\s*\n?\s*client_id: c\.client_id,\s*\n?\s*label: c\.label,\s*\n?\s*redirect_uris: c\.redirect_uris,\s*\n?\s*account_id: c\.account_id,\s*\n?\s*created_at: new Date\(c\.created_at\)\.toISOString\(\),\s*\n?\s*revoked_at: c\.revoked_at !== null \? new Date\(c\.revoked_at\)\.toISOString\(\) : null,\s*\n?\s*\}\)\),/,
    );
  });

  it('V-667.D single-client lookup framing pinned: founder admin UI; 404 if not exist; full envelope minus hashed secret when exists; revoked clients returned with revoked_at populated so ops can audit who/when revoked', () => {
    expect(body).toMatch(
      /\/\/ V-667\.D — single-client lookup for the founder admin UI\. Returns\s*\n?\s*\/\/ 404 when the client doesn't exist, the full envelope \(minus the\s*\n?\s*\/\/ hashed secret\) when it does\. Revoked clients are returned with\s*\n?\s*\/\/ their revoked_at populated so ops can audit "who\/when revoked\."/,
    );
    expect(body).toMatch(
      /if \(c === null\) \{\s*\n?\s*throw new NotFoundError\(`OAuth client "\$\{req\.params\.id\}" not found\.`\);\s*\n?\s*\}/,
    );
  });

  it('V-667.E rotate-secret keeps bearer tokens valid but requires the successor secret on every client-authenticated lifecycle call', () => {
    expect(body).toMatch(
      /\/\/ V-667\.E — rotate the client_secret in place\. Returns the new\s*\n?\s*\/\/ plaintext ONCE \(the store keeps only the hash\)\. Existing access\s*\n?\s*\/\/ tokens are NOT invalidated \(they remain bearer-authenticated\), but\s*\n?\s*\/\/ the new secret is required for token exchange\/introspection\/revoke\./,
    );
    expect(body).toMatch(
      /app\.post<\{ Params: \{ id: string \} \}>\(\s*\n?\s*'\/v1\/admin\/oauth\/clients\/:id\/rotate-secret',/,
    );
  });

  it('GET /v1/oauth/authorize: scope split on whitespace + ApiKeyScopeSchema.parse each; service.authorize wires PKCE fields; catches OAuthError → oauthErrorToHttp', () => {
    expect(body).toMatch(
      /const scope = query\.scope\s*\n?\s*\? query\.scope\s*\n?\s*\.split\(\/\\s\+\/\)\s*\n?\s*\.filter\(Boolean\)\s*\n?\s*\.map\(\(s\) => ApiKeyScopeSchema\.parse\(s\)\)\s*\n?\s*: \[\];/,
    );
    expect(body).toMatch(
      /const result = await deps\.service\.authorize\(\{\s*\n?\s*client_id: query\.client_id,\s*\n?\s*redirect_uri: query\.redirect_uri,\s*\n?\s*state: query\.state,\s*\n?\s*code_challenge: query\.code_challenge,\s*\n?\s*code_challenge_method: query\.code_challenge_method,\s*\n?\s*scope,\s*\n?\s*\}\);/,
    );
  });

  it('POST /authorize/complete: web-session + account-rate-limit gated before parsing; account bound to the authenticated caller and scope restricted to their effective scopes', () => {
    expect(body).toMatch(
      /app\.post\(\s*\n?\s*'\/v1\/oauth\/authorize\/complete',\s*\n?\s*\{ preHandler: \[app\.requireAuth, app\.rateLimit\('global'\)\] \},/,
    );
    expect(body).toMatch(
      /if \(ctx\.webSession === null\) \{\s*\n?\s*throw new ForbiddenError\('OAuth authorization requires an interactive dashboard session\.'\);\s*\n?\s*\}[\s\S]*?requireTierFeature\(ctx\.account\.tier, 'apiAccess'\);\s*\n?\s*const body = parseOrThrow\(ApproveAuthorizationBody, req\.body\);/,
    );
    // SECURITY (cross-account-takeover guard): the approving account is derived from the
    // authenticated caller, NEVER the request body; the granted scope is the approver's own.
    expect(body).toContain('account_id: ctx.account.id,');
    expect(body).toContain('approverScopes: ctx.apiKey.scopes,');
    expect(body).toMatch(
      /const result = await deps\.service\.exchangeCode\(\{\s*\n?\s*code: body\.code,\s*\n?\s*code_verifier: body\.code_verifier,\s*\n?\s*client_id: body\.client_id,\s*\n?\s*client_secret: body\.client_secret,\s*\n?\s*redirect_uri: body\.redirect_uri,\s*\n?\s*\}\);/,
    );
  });

  it('introspect authenticates/binds the client before returning minimal inactive or owned metadata', () => {
    expect(body).toMatch(/await deps\.service\.introspectForClient\(body\)/);
    expect(body).toMatch(
      /if \(token === null\) \{\s*\n?\s*return reply\.send\(\{ active: false \}\);\s*\n?\s*\}\s*\n?\s*return reply\.send\(\{\s*\n?\s*active: true,\s*\n?\s*client_id: token\.client_id,\s*\n?\s*account_id: token\.account_id,\s*\n?\s*scope: token\.scope,\s*\n?\s*exp: Math\.floor\(token\.expires_at \/ 1000\),\s*\n?\s*\}\);/,
    );
  });

  it('RFC 7009 revoke authenticates/binds the client and preserves authorized always-200 anti-enumeration', () => {
    expect(body).toMatch(
      /\/\/ V-667\.C — RFC 7009\. Once client authentication succeeds, always\s*\n?\s*\/\/ return 200 for owned, foreign, and unknown tokens/,
    );
    expect(body).toMatch(
      /await deps\.service\.revokeTokenForClient\(body\);\s*\n?\s*return reply\.code\(200\)\.send\(\{\}\);/,
    );
  });

  it('parseOrThrow → BadRequestError(err.message); oauthErrorToHttp: invalid_client/unauthorized_client → UnauthorizedError (401); invalid_request/_scope/_grant/access_denied → BadRequestError (400)', () => {
    expect(body).toMatch(
      /function parseOrThrow<T>\(schema: z\.ZodSchema<T>, input: unknown\): T \{\s*\n?\s*const result = schema\.safeParse\(input\);\s*\n?\s*if \(!result\.success\) \{\s*\n?\s*throw new BadRequestError\(result\.error\.message\);\s*\n?\s*\}\s*\n?\s*return result\.data;\s*\n?\s*\}/,
    );
    // V-737 — the code now also travels as an RFC 6749 §5.2 `error` extension on
    // the problem body. It used to select the status and then be discarded, and
    // the messages do not contain it either, so the code reached the client
    // NOWHERE. Dropping the extension silently restores that, which is why the
    // status mapping and the extension are pinned together.
    expect(body).toMatch(
      /function oauthErrorToHttp\(err: unknown\): Error \{\s*if \(!\(err instanceof OAuthError\)\) return err as Error;\s*switch \(err\.code\) \{\s*case 'invalid_client':\s*case 'unauthorized_client':\s*return new UnauthorizedError\(err\.message, \{ error: err\.code \}\);\s*case 'invalid_request':\s*case 'invalid_scope':\s*case 'invalid_grant':\s*case 'access_denied':\s*return new BadRequestError\(err\.message, \{ error: err\.code \}\);\s*\}\s*\}/,
    );
  });

  it('rate-limit gates cover the 4 unauthenticated provider routes and the account-authenticated consent mutation', () => {
    // Imports for the gate wiring.
    expect(body).toMatch(
      /import \{ ipRateLimit, AUTH_IP_LIMITS \} from '\.\.\/middleware\/ip-rate-limit\.js';/,
    );
    expect(body).toMatch(/import type \{ RateLimitStore \} from '\.\.\/services\/rate-limit\.js';/);
    // Required (never-silently-omitted) dep.
    expect(body).toMatch(/rateLimitStore: RateLimitStore;/);
    // Four per-route buckets (separate prefixes → per-route isolation).
    expect(body).toMatch(/bucketPrefix: 'oauth_provider_authorize',/);
    expect(body).toMatch(/bucketPrefix: 'oauth_provider_token',/);
    expect(body).toMatch(/bucketPrefix: 'oauth_provider_introspect',/);
    expect(body).toMatch(/bucketPrefix: 'oauth_provider_revoke',/);
    // Each public route carries its gate preHandler (whitespace-flexible
    // for prettier's multi-line wrap of the >100-char signatures).
    expect(body).toMatch(
      /app\.get\(\s*\n?\s*'\/v1\/oauth\/authorize',\s*\n?\s*\{ preHandler: \[authorizeGate\] \}/,
    );
    expect(body).toMatch(
      /app\.post\(\s*\n?\s*'\/v1\/oauth\/token',\s*\n?\s*\{ preHandler: \[tokenGate\] \}/,
    );
    expect(body).toMatch(
      /app\.post\(\s*\n?\s*'\/v1\/oauth\/introspect',\s*\n?\s*\{ preHandler: \[introspectGate\] \}/,
    );
    expect(body).toMatch(
      /app\.post\(\s*\n?\s*'\/v1\/oauth\/revoke',\s*\n?\s*\{ preHandler: \[revokeGate\] \}/,
    );
    expect(body).toMatch(
      /app\.post\(\s*\n?\s*'\/v1\/oauth\/authorize\/complete',\s*\n?\s*\{ preHandler: \[app\.requireAuth, app\.rateLimit\('global'\)\] \}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
