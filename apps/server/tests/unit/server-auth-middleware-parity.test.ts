// W712 — server-side auth middleware parity. Thirty-ninth in the
// cross-SDK drift-guard series (W649 + W675-W712).
//
// Pins apps/server/src/middleware/auth.ts as the AUTHORITATIVE
// Fastify auth-gate plugin:
//
//   - decorateRequest('account') as the per-request auth-context
//     anchor (typed via declare-module Fastify augmentation)
//   - 5 decorators on the Fastify instance: requireAuth,
//     requireAuthEventSource (SSE ds_token query fallback), requireScope,
//     requireMfaFresh (V-353e step-up gate), requireOwner
//   - Both bearer-auth entrypoints pass the optional persistent OAuth
//     store into the shared authenticate() authority pipeline
//   - DEFAULT_MFA_FRESHNESS_SECONDS = 15 * 60 (15 minutes per
//     V-353a Q4 verdict) — matches cross-SDK W682
//   - V-353e step-up gate semantics:
//     * No-op when ctx.webSession === null (API-key/machine path)
//     * No-op when MfaService not wired (deploy without MFA)
//     * No-op when account is not enrolled
//     * Throws MfaStepUpRequiredError('never_satisfied') when sat=null
//     * Throws MfaStepUpRequiredError('expired') when ageSec > window
//   - fastify-plugin wrap so decorators are visible globally
//
// CRITICAL invariants:
//   1. Step-up gate respects the bypass-on-API-key invariant. Drift
//      to gating API-key callers would silently break customer
//      automation (machines can't satisfy a TOTP challenge).
//   2. DEFAULT_MFA_FRESHNESS_SECONDS = 900 (15 minutes) matches
//      every cross-SDK W682 assertion.
//   3. 2-reason MfaStepUpRequiredError discriminator pinned
//      ('never_satisfied' on null sat; 'expired' on stale sat).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const AUTH_MIDDLEWARE = resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts');

describe('W712 server-side auth middleware parity', () => {
  it('auth.ts middleware file exists', () => {
    expect(existsSync(AUTH_MIDDLEWARE), `missing ${AUTH_MIDDLEWARE}`).toBe(true);
  });

  it('CRITICAL Fastify type augmentation pinned — declare module fastify adds `account` to FastifyRequest + 5 decorator methods to FastifyInstance. The augmentation is what gives TypeScript route handlers visibility into the account context without per-route generics.', () => {
    const src = read(AUTH_MIDDLEWARE);

    expect(src).toMatch(/declare module 'fastify' \{/);
    expect(src).toMatch(/interface FastifyRequest \{\s*account: AccountContext \| null;/);
    expect(src).toMatch(/interface FastifyInstance \{/);
    expect(src).toMatch(/requireAuth:/);
    // SSE/EventSource auth variant — accepts the bearer token from a
    // `?ds_token=` query param (EventSource can't set headers).
    expect(src).toMatch(/requireAuthEventSource:/);
    expect(src).toMatch(/requireScope:/);
    expect(src).toMatch(/requireMfaFresh:/);
    expect(src).toMatch(/requireOwner:/);
  });

  it('CRITICAL V-353e default step-up freshness pinned at 15 minutes (15 * 60 seconds). Matches cross-SDK W682 and api-types W709 documentation; drift to a different bound would let stale MFA proofs satisfy step-up checks.', () => {
    const src = read(AUTH_MIDDLEWARE);
    expect(src).toMatch(/DEFAULT_MFA_FRESHNESS_SECONDS = 15 \* 60/);
    expect(src).toMatch(/V-353a Q4 verdict/);
  });

  it('CRITICAL extractBearerToken pinned on requireAuth — `extractBearerToken(request.headers.authorization)`. The Bearer-token extraction is what threads the Authorization header through to the auth service. Drift to bypassing extraction would let raw keys flow into authenticate() without scheme validation.', () => {
    const src = read(AUTH_MIDDLEWARE);
    expect(src).toMatch(/extractBearerToken\(request\.headers\.authorization\)/);
  });

  it('CRITICAL both bearer entrypoints call authenticate() with 8 args: auth/cache/coalescer/staff/negative-cache plus the OAuth authority store. Dropping the OAuth store would make issued OAuth tokens unusable; dropping cache/coalescer controls would reintroduce stampedes and repeated bogus-token work.', () => {
    const src = read(AUTH_MIDDLEWARE);

    const authenticateCalls = src.match(/await authenticate\([\s\S]*?\);/g) ?? [];
    expect(authenticateCalls).toHaveLength(2);
    for (const call of authenticateCalls) {
      expect(call).toMatch(
        /await authenticate\(\s*opts\.authRepo,\s*token,\s*opts\.authCache,\s*new Date\(\),\s*opts\.authCoalescer,\s*opts\.staffEmails \?\? new Set\(\),\s*opts\.negativeAuthCache \?\? null,\s*opts\.oauthStore \?\? null,\s*\)/,
      );
    }
  });

  it('CRITICAL requireAuth decorator + decorateRequest("account", null) initialization pinned. The null-init on every request is what prevents stale account contexts from leaking across requests (Fastify shares request prototypes by default).', () => {
    const src = read(AUTH_MIDDLEWARE);
    expect(src).toMatch(/app\.decorateRequest\('account', null\)/);
    expect(src).toMatch(/app\.decorate\('requireAuth', requireAuth\)/);
    expect(src).toMatch(/app\.decorate\('requireAuthEventSource', requireAuthEventSource\)/);
  });

  it("CRITICAL requireScope decorator factory pinned — returns a per-route hook that calls requireAuth first (if needed) then requireScope on the context. The 2-step shape is what lets routes compose `app.requireScope('admin')` directly in route options without manual auth chaining.", () => {
    const src = read(AUTH_MIDDLEWARE);
    expect(src).toMatch(/app\.decorate\('requireScope', \(scope: ApiKeyScope\) => \{/);
    expect(src).toMatch(/if \(!request\.account\) \{\s*await requireAuth\(request, reply\);/);
    expect(src).toMatch(/if \(request\.account\) requireScope\(request\.account, scope\)/);
  });

  it('CRITICAL V-353e step-up bypass-on-API-key invariant pinned. The `if (ctx.webSession === null) return;` is what prevents machine-to-machine API-key callers from being forced through TOTP. Drift to dropping would silently break customer automation.', () => {
    const src = read(AUTH_MIDDLEWARE);
    expect(src).toMatch(
      /API-key callers \(no web session\) bypass[\s\S]{0,200}if \(ctx\.webSession === null\) return;/,
    );
  });

  it("CRITICAL V-353e bypass-when-MfaService-not-wired pinned — when MFA is disabled in the deploy (no MfaService injected), the gate becomes a no-op. Drift to throwing without an MfaService would break test fixtures + deploys that haven't wired MFA yet.", () => {
    const src = read(AUTH_MIDDLEWARE);
    expect(src).toMatch(
      /No MfaService wired = MFA disabled in this deploy.*\s*if \(!opts\.mfaService\) return;/,
    );
  });

  it("CRITICAL V-353e bypass-when-not-enrolled pinned — `if (!status.enrolled) return;`. The bypass is what lets the gate apply only to accounts that have completed enrollment; drift to gating non-enrolled would force a chicken-and-egg flow (can't enroll because not enrolled).", () => {
    const src = read(AUTH_MIDDLEWARE);
    expect(src).toMatch(
      /const status = await opts\.mfaService\.getStatus\(ctx\.account\.id\);\s*if \(!status\.enrolled\) return;/,
    );
  });

  it("CRITICAL V-353e MfaStepUpRequiredError 2-reason discriminator pinned — `'never_satisfied'` when mfaSatisfiedAt is null; `'expired'` when ageSec > window. Matches the W710 server-side error class + W709 problem-type framing.", () => {
    const src = read(AUTH_MIDDLEWARE);

    // never_satisfied on null sat.
    expect(src).toMatch(
      /if \(sat === null\) \{\s*throw new MfaStepUpRequiredError\('never_satisfied'\);/,
    );

    // expired on ageSec > window.
    expect(src).toMatch(
      /const ageSec = \(Date\.now\(\) - sat\.getTime\(\)\) \/ 1000;\s*if \(ageSec > window\) \{\s*throw new MfaStepUpRequiredError\('expired'\);/,
    );
  });

  it('CRITICAL requireMfaFresh accepts per-route freshness override — `gateOpts?.freshnessSeconds ?? DEFAULT_MFA_FRESHNESS_SECONDS`. Lets sensitive routes (e.g. billing-tier change) require a SHORTER freshness window (5 min) without changing the global default. Drift to dropping the override would force every route to use 15 min.', () => {
    const src = read(AUTH_MIDDLEWARE);
    expect(src).toMatch(/gateOpts\?\.freshnessSeconds \?\? DEFAULT_MFA_FRESHNESS_SECONDS/);
  });

  it("CRITICAL fastify-plugin wrapping pinned — `export default fp(authPlugin, { name: 'auth' });`. The fp wrapper is what makes decorators visible to OUTER scopes (not just the encapsulated plugin context). Drift to bare export would silently break route definitions that expect `app.requireAuth` outside the plugin scope.", () => {
    const src = read(AUTH_MIDDLEWARE);
    expect(src).toMatch(/export default fp\(authPlugin, \{ name: 'auth' \}\)/);
  });

  it('CRITICAL imports pinned — MfaStepUpRequiredError from ../lib/errors.js (NOT inline-defined). Matches W710 canonical taxonomy single-source. Drift to inline-defining would let server-side errors diverge from the canonical roster. (May be bundled with sibling error imports — single grouped import block.)', () => {
    const src = read(AUTH_MIDDLEWARE);
    expect(src).toMatch(/MfaStepUpRequiredError,?[\s\S]*?from '\.\.\/lib\/errors\.js'/);
  });

  it('CRITICAL AuthPluginOptions authority dependencies pinned — authRepo + authCache + authCoalescer + optional oauthStore and mfaService. The fields let production wire persistent OAuth, Redis-backed controls and MFA while fixtures inject bounded alternatives.', () => {
    const src = read(AUTH_MIDDLEWARE);
    expect(src).toMatch(/export interface AuthPluginOptions \{/);
    expect(src).toMatch(/authRepo: AccountAuthRepo;/);
    expect(src).toMatch(/authCache: AuthCache \| null;/);
    expect(src).toMatch(/authCoalescer: AuthCoalescer \| null;/);
    expect(src).toMatch(/oauthStore\?: OAuthStore \| null;/);
    expect(src).toMatch(/mfaService\?: MfaService \| null;/);
  });

  it('Server auth-middleware invariant cluster — 5 decorators, OAuth-aware shared authentication, 15-min DEFAULT_MFA_FRESHNESS, Bearer extraction and bypass-on-API-key. Drift on any would fragment the canonical auth gate.', () => {
    const src = read(AUTH_MIDDLEWARE);

    expect(src).toMatch(/requireAuth/);
    expect(src).toMatch(/requireAuthEventSource/);
    expect(src).toMatch(/requireScope/);
    expect(src).toMatch(/requireMfaFresh/);
    expect(src).toMatch(/requireOwner/);
    expect(src).toMatch(/15 \* 60/);
    expect(src).toMatch(/extractBearerToken/);
    expect(src).toMatch(/webSession === null/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/server-auth-middleware-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
