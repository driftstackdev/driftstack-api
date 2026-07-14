// W394.B — drift guard for apps/server/src/middleware/auth.ts.
// Auth plugin: validates Authorization header, attaches account
// context to request.account, and provides 4 decorators on the
// Fastify instance — requireAuth, requireAuthEventSource, requireScope,
// requireMfaFresh.
// V-353e step-up MFA gate is the load-bearing addition; drift here
// either always-blocks legitimate fresh sessions or always-allows
// stale ones.
//
//   • requireAuth: extractBearerToken → authenticate → set
//     request.account.
//   • requireAuthEventSource: like requireAuth but ALSO accepts the
//     bearer token from a `?ds_token=` query param (SSE/EventSource
//     can't set headers); header wins. Opt-in per-route.
//   • requireScope: optional preHandler factory; calls requireAuth
//     if request.account null.
//   • V-353e requireMfaFresh: 4 bypass cases (no MfaService wired /
//     not enrolled / API-key path / web session with mfaSatisfiedAt
//     in window) + 2 throw cases (never_satisfied / expired).
//   • DEFAULT_MFA_FRESHNESS_SECONDS = 15*60 (V-353e + V-353a Q4
//     verdict).
//   • Plugin name='auth'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const MW = resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W394.B apps/server/src/middleware/auth.ts content parity', () => {
  const body = read(MW);

  it('Module framing pinned: validates Authorization header + attaches account + problem+json reject', () => {
    expect(body).toMatch(
      /Auth middleware: validates the Authorization header, attaches the\s*\n?\s*\/\/\s*account context to `request\.account`, and rejects with the appropriate\s*\n?\s*\/\/\s*problem\+json error if the key is missing\/invalid\/revoked\/expired/,
    );
  });

  it('FastifyRequest type augmentation: account: AccountContext | null', () => {
    expect(body).toMatch(
      /declare module 'fastify' \{\s*\n?\s*interface FastifyRequest \{\s*\n?\s*account: AccountContext \| null;\s*\n?\s*\}/,
    );
  });

  it('FastifyInstance type augmentation: requireAuth + requireAuthEventSource + requireScope (factory) + requireMfaFresh (factory)', () => {
    expect(body).toMatch(
      /requireAuth: \(request: FastifyRequest, reply: FastifyReply\) => Promise<void>;/,
    );
    expect(body).toMatch(
      /requireAuthEventSource: \(request: FastifyRequest, reply: FastifyReply\) => Promise<void>;/,
    );
    expect(body).toMatch(
      /requireScope: \(\s*\n?\s*scope: ApiKeyScope,\s*\n?\s*\) => \(request: FastifyRequest, reply: FastifyReply\) => Promise<void>;/,
    );
    expect(body).toMatch(
      /requireMfaFresh: \(opts\?: \{\s*\n?\s*freshnessSeconds\?: number;\s*\n?\s*\}\) => \(request: FastifyRequest, reply: FastifyReply\) => Promise<void>;/,
    );
  });

  it('V-353e requireMfaFresh framing pinned: 403 when never-satisfied or older than freshness window; API-key bypass; per-route override', () => {
    expect(body).toMatch(
      /V-353e — step-up MFA gate\. Throws MfaStepUpRequiredError \(403\)\s*\n?\s*\*\s*when the calling web session's `mfa_satisfied_at` is null or\s*\n?\s*\*\s*older than the freshness window \(default 15 min per V-353a Q4\)\./,
    );
    expect(body).toMatch(
      /No-ops when the calling account is NOT MFA-enrolled \(gate\s*\n?\s*\*\s*empty\), or when the caller is API-key-authed \(machine path,\s*\n?\s*\*\s*MFA is a human-factor concept\)/,
    );
    expect(body).toMatch(
      /Configure the window per-route\s*\n?\s*\*\s*if you want shorter \(e\.g\. 5 min for billing-tier change\)/,
    );
  });

  it('AuthPluginOptions: authRepo + authCache (nullable) + authCoalescer (nullable) + mfaService? (nullable)', () => {
    expect(body).toMatch(/export interface AuthPluginOptions \{/);
    expect(body).toMatch(/authRepo: AccountAuthRepo;/);
    expect(body).toMatch(/authCache: AuthCache \| null;/);
    expect(body).toMatch(/authCoalescer: AuthCoalescer \| null;/);
    expect(body).toMatch(/mfaService\?: MfaService \| null;/);
  });

  it('DEFAULT_MFA_FRESHNESS_SECONDS = 15 * 60 (V-353e + V-353a Q4 verdict)', () => {
    expect(body).toMatch(/V-353e — default step-up freshness window per V-353a Q4 verdict\./);
    expect(body).toMatch(/export const DEFAULT_MFA_FRESHNESS_SECONDS = 15 \* 60;/);
  });

  it('decorateRequest("account", null) — initial value', () => {
    expect(body).toMatch(/app\.decorateRequest\('account', null\);/);
  });

  it('requireAuth + requireAuthEventSource: authenticate with negative cache and OAuth bearer store, then assign request.account', () => {
    expect(body).toMatch(
      /const requireAuth = async \(request: FastifyRequest, _reply: FastifyReply\): Promise<void> => \{\s*\n?\s*try \{\s*\n?\s*const token = extractBearerToken\(request\.headers\.authorization\);\s*\n?\s*const ctx = await authenticate\(\s*\n?\s*opts\.authRepo,\s*\n?\s*token,\s*\n?\s*opts\.authCache,\s*\n?\s*new Date\(\),\s*\n?\s*opts\.authCoalescer,\s*\n?\s*opts\.staffEmails \?\? new Set\(\),\s*\n?\s*opts\.negativeAuthCache \?\? null,\s*\n?\s*opts\.oauthStore \?\? null,\s*\n?\s*\);\s*\n?\s*request\.account = ctx;/,
    );
    expect(body).toMatch(
      /const requireAuthEventSource = async \(\s*\n?\s*request: FastifyRequest,\s*\n?\s*_reply: FastifyReply,\s*\n?\s*\): Promise<void> => \{[\s\S]*?const ctx = await authenticate\(\s*\n?\s*opts\.authRepo,\s*\n?\s*token,\s*\n?\s*opts\.authCache,\s*\n?\s*new Date\(\),\s*\n?\s*opts\.authCoalescer,\s*\n?\s*opts\.staffEmails \?\? new Set\(\),\s*\n?\s*opts\.negativeAuthCache \?\? null,\s*\n?\s*opts\.oauthStore \?\? null,\s*\n?\s*\);\s*\n?\s*request\.account = ctx;/,
    );
  });

  it('requireScope decorator: calls requireAuth if request.account null, then services/auth.requireScope(ctx, scope)', () => {
    expect(body).toMatch(
      /app\.decorate\('requireScope', \(scope: ApiKeyScope\) => \{\s*\n?\s*return async \(request: FastifyRequest, reply: FastifyReply\): Promise<void> => \{\s*\n?\s*if \(!request\.account\) \{\s*\n?\s*await requireAuth\(request, reply\);\s*\n?\s*\}\s*\n?\s*if \(request\.account\) requireScope\(request\.account, scope\);/,
    );
  });

  it('requireMfaFresh: 4 bypass branches (no webSession / no MfaService / not enrolled / fresh) + 2 throw branches', () => {
    expect(body).toMatch(
      /const window = gateOpts\?\.freshnessSeconds \?\? DEFAULT_MFA_FRESHNESS_SECONDS;/,
    );
    expect(body).toMatch(
      /\/\/ API-key callers \(no web session\) bypass — MFA is a human-\s*\n?\s*\/\/\s*factor gate, not a machine-to-machine concept\./,
    );
    expect(body).toMatch(/if \(ctx\.webSession === null\) return;/);
    expect(body).toMatch(
      /\/\/ No MfaService wired = MFA disabled in this deploy → no gate\.\s*\n?\s*if \(!opts\.mfaService\) return;/,
    );
    expect(body).toMatch(/if \(!status\.enrolled\) return;/);
    expect(body).toMatch(/const sat = ctx\.webSession\.mfaSatisfiedAt;/);
    expect(body).toMatch(
      /if \(sat === null\) \{\s*\n?\s*throw new MfaStepUpRequiredError\('never_satisfied'\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(/const ageSec = \(Date\.now\(\) - sat\.getTime\(\)\) \/ 1000;/);
    expect(body).toMatch(
      /if \(ageSec > window\) \{\s*\n?\s*throw new MfaStepUpRequiredError\('expired'\);\s*\n?\s*\}/,
    );
  });

  it('export: default fp(authPlugin, { name: "auth" })', () => {
    expect(body).toMatch(/export default fp\(authPlugin, \{ name: 'auth' \}\);/);
  });

  it('imports: services/auth (3 named) + AuthCache + AuthCoalescer + MfaService + MfaStepUpRequiredError + ApiKeyScope', () => {
    expect(body).toMatch(
      /import \{ authenticate, extractBearerToken, requireScope \} from '\.\.\/services\/auth\.js';/,
    );
    expect(body).toMatch(/import type \{ AuthCache \} from '\.\.\/services\/auth-cache\.js';/);
    expect(body).toMatch(
      /import type \{ AuthCoalescer \} from '\.\.\/services\/auth-coalescer\.js';/,
    );
    expect(body).toMatch(/import type \{ MfaService \} from '\.\.\/services\/mfa\.js';/);
    // Errors are imported as a multi-line group with sibling error
    // classes (ExpiredKeyError + ForbiddenError + InvalidKeyError +
    // MfaStepUpRequiredError + RevokedKeyError + UnauthorizedError).
    expect(body).toMatch(
      /import \{[\s\S]*?MfaStepUpRequiredError,[\s\S]*?\} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(/import type \{ ApiKeyScope \} from '@driftstack\/api-types';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(MW)).toBe(true);
  });
});
