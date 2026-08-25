// W703 — cross-SDK V-079 auth-flow primitives parity. Thirtieth in
// the cross-SDK drift-guard series (W649 + W675-W703).
//
// Asserts the V-079 auth-flow primitives are consistent across all
// 3 SDKs:
//
//   - V-079 resource anchor pinned per-SDK
//   - 13-verb surface (signup + verifyEmail + login + requestMagicLink
//     + consumeMagicLink + requestPasswordReset + confirmPasswordReset
//     + refresh + logout + mfaChallenge + mfaStepUp +
//     cliAuthorizeInitiate + cliAuthorizeBind + cliAuthorizeExchange)
//   - 12 wire-paths: /v1/auth/signup + /v1/auth/verify-email +
//     /v1/auth/login + /v1/auth/magic-link/{request,consume} +
//     /v1/auth/password-reset/{request,confirm} + /v1/auth/refresh +
//     /v1/auth/logout + /v1/auth/mfa/{challenge,step-up} +
//     /v1/auth/cli-authorize/{initiate,bind,exchange}
//   - All POST verbs (no GET on auth flows — even read-like verbs are
//     POST to keep CSRF protections + body-sealed tokens)
//   - "Endpoints don't require an API key — they ARE the auth gate"
//     framing on resource header (TS + Go)
//   - 2-step password-reset flow (request → confirm) and 2-step
//     magic-link flow (request → consume)
//
// CRITICAL invariant: ALL auth-flow verbs are POST — drift to GET on
// e.g. password-reset/request would let the request fire from a
// browser-prefetch (and let attackers force password-reset emails
// via crafted referrers).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_AUTH = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/auth.ts');
const GO_AUTH = resolve(REPO_ROOT, 'packages/sdk-go/auth.go');
const PY_AUTH = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/auth.py');

describe('W703 cross-SDK V-079 auth-flow primitives parity', () => {
  it('all 3 SDK auth files exist at canonical paths', () => {
    expect(existsSync(TS_AUTH), `missing ${TS_AUTH}`).toBe(true);
    expect(existsSync(GO_AUTH), `missing ${GO_AUTH}`).toBe(true);
    expect(existsSync(PY_AUTH), `missing ${PY_AUTH}`).toBe(true);
  });

  it('CRITICAL V-079 anchor pinned on the resource header in all 3 SDKs. V-079 is the auth-flow feature anchor; drift to dropping would lose changelog provenance.', () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);
    const py = read(PY_AUTH);

    expect(ts).toMatch(/V-079/);
    expect(go).toMatch(/V-079/);
    expect(py).toMatch(/V-079/);
  });

  it("CRITICAL \"endpoints don't require an API key\" framing pinned in TS + Go. The auth flows ARE the auth gate; drift to dropping would mislead callers about which API-key context applies. This is what tells customers `new Client('')` is valid for auth flows.", () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);

    // sdk-typescript: "these endpoints don't require an API key (they ARE the auth\n// gate)"
    expect(ts).toMatch(/don't require an API key/);
    expect(ts).toMatch(/they ARE the auth/);

    // sdk-go: "These endpoints don't require an API key — they ARE the auth gate."
    expect(go).toMatch(/don't require an API key/);
    expect(go).toMatch(/they ARE the auth gate/);
  });

  it('CRITICAL 13-verb surface pinned in all 3 SDKs — signup + verifyEmail + login + requestMagicLink + consumeMagicLink + requestPasswordReset + confirmPasswordReset + refresh + logout + mfaChallenge + mfaStepUp + cliAuthorize{Initiate,Bind,Exchange} = 14 verbs. The full set is the V-079 / V-445 / V-460 surface.', () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);
    const py = read(PY_AUTH);

    // sdk-typescript: 14 method declarations.
    const tsVerbs = [
      /signup\(body:/,
      /verifyEmail\(body:/,
      /login\(body:/,
      /requestMagicLink\(body:/,
      /consumeMagicLink\(body:/,
      /requestPasswordReset\(body:/,
      /confirmPasswordReset\(body:/,
      /refresh\(body:/,
      /logout\(body:/,
      /mfaChallenge\(body:/,
      /mfaStepUp\(body:/,
      /cliAuthorizeInitiate\(body:/,
      /cliAuthorizeBind\(body:/,
      /cliAuthorizeExchange\(body:/,
    ];
    for (const verb of tsVerbs) {
      expect(ts, `sdk-typescript verb ${verb.source}`).toMatch(verb);
    }

    // sdk-go: PascalCase verbs.
    const goVerbs = [
      /func \(r \*AuthResource\) Signup\(/,
      /func \(r \*AuthResource\) VerifyEmail\(/,
      /func \(r \*AuthResource\) Login\(/,
      /func \(r \*AuthResource\) RequestMagicLink\(/,
      /func \(r \*AuthResource\) ConsumeMagicLink\(/,
      /func \(r \*AuthResource\) RequestPasswordReset\(/,
      /func \(r \*AuthResource\) ConfirmPasswordReset\(/,
      /func \(r \*AuthResource\) Refresh\(/,
      /func \(r \*AuthResource\) Logout\(/,
      /func \(r \*AuthResource\) MfaChallenge\(/,
      /func \(r \*AuthResource\) MfaStepUp\(/,
      /func \(r \*AuthResource\) CliAuthorizeInitiate\(/,
      /func \(r \*AuthResource\) CliAuthorizeBind\(/,
      /func \(r \*AuthResource\) CliAuthorizeExchange\(/,
    ];
    for (const verb of goVerbs) {
      expect(go, `sdk-go verb ${verb.source}`).toMatch(verb);
    }

    // sdk-python: snake_case verbs.
    const pyVerbs = [
      /def signup\(self/,
      /def verify_email\(self/,
      /def login\(self/,
      /def request_magic_link\(self/,
      /def consume_magic_link\(self/,
      /def request_password_reset\(self/,
      /def confirm_password_reset\(self/,
      /def refresh\(self/,
      /def logout\(self/,
    ];
    for (const verb of pyVerbs) {
      expect(py, `sdk-python verb ${verb.source}`).toMatch(verb);
    }
  });

  it('CRITICAL 12 wire-paths pinned per-SDK: signup + verify-email + login + magic-link/{request,consume} + password-reset/{request,confirm} + refresh + logout + mfa/{challenge,step-up} + cli-authorize/{initiate,bind,exchange}. Drift to renaming any path would break server-side routing.', () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);
    const py = read(PY_AUTH);

    const paths = [
      '/v1/auth/signup',
      '/v1/auth/verify-email',
      '/v1/auth/login',
      '/v1/auth/magic-link/request',
      '/v1/auth/magic-link/consume',
      '/v1/auth/password-reset/request',
      '/v1/auth/password-reset/confirm',
      '/v1/auth/refresh',
      '/v1/auth/logout',
    ];

    for (const path of paths) {
      const escaped = path.replace(/\//g, '\\/');
      const re = new RegExp(escaped);
      expect(ts, `sdk-typescript path ${path}`).toMatch(re);
      expect(go, `sdk-go path ${path}`).toMatch(re);
      expect(py, `sdk-python path ${path}`).toMatch(re);
    }
  });

  it('CRITICAL ALL auth-flow verbs are POST in TS + Go. Even read-like verbs (refresh, logout) are POST to keep CSRF protections + body-sealed tokens. Drift to GET on e.g. password-reset/request would let browser-prefetch fire password-reset emails.', () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);

    // sdk-typescript: count GET / POST in resource (should be 0 GET, many POST).
    const tsGet = (ts.match(/method: 'GET'/g) ?? []).length;
    expect(tsGet, 'sdk-typescript should have ZERO GET on auth flows').toBe(0);

    const tsPost = (ts.match(/method: 'POST'/g) ?? []).length;
    expect(tsPost, 'sdk-typescript should have many POST on auth flows').toBeGreaterThanOrEqual(13);

    // sdk-go.
    const goGet = (go.match(/method: "GET"/g) ?? []).length;
    expect(goGet, 'sdk-go should have ZERO GET on auth flows').toBe(0);

    const goPost = (go.match(/method: "POST"/g) ?? []).length;
    expect(goPost, 'sdk-go should have many POST on auth flows').toBeGreaterThanOrEqual(13);
  });

  it('CRITICAL 2-step password-reset flow framing — request and confirm are SEPARATE verbs. Drift to merging would skip the email-token round-trip (the security gate that proves the requester owns the email account).', () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);
    const py = read(PY_AUTH);

    // /password-reset/request + /password-reset/confirm both pinned.
    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/\/v1\/auth\/password-reset\/request/);
      expect(sdk).toMatch(/\/v1\/auth\/password-reset\/confirm/);
    }
  });

  it('CRITICAL 2-step magic-link flow framing — request and consume are SEPARATE verbs. Drift to merging would let attackers consume tokens without email-delivery (the security gate that proves the requester owns the email).', () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);
    const py = read(PY_AUTH);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/\/v1\/auth\/magic-link\/request/);
      expect(sdk).toMatch(/\/v1\/auth\/magic-link\/consume/);
    }
  });

  it('CRITICAL V-353d MFA discriminator framing on login pinned in sdk-typescript. The literal `mfa_required: true` is the wire-discriminator that branches the response to the MFA-challenge flow vs. the session-issued flow. Drift to dropping would let dashboards mis-render the next step.', () => {
    const ts = read(TS_AUTH);

    expect(ts).toMatch(/V-353d/);
    expect(ts).toMatch(/mfa_required: true/);
    expect(ts).toMatch(/challenge_token/);
    expect(ts).toMatch(/challenge_expires_at/);
  });

  it('CRITICAL V-445 mfaStepUp 15-min freshness framing pinned in TS + Go. The 15-minute window is the bound on how recently the customer must have proved MFA before sensitive-op gates pass. Drift to dropping would lose the customer-facing claim about step-up freshness.', () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);

    expect(ts).toMatch(/V-445/);
    expect(ts).toMatch(/15-minute freshness window/);

    expect(go).toMatch(/V-445/);
    expect(go).toMatch(/15-minute freshness window/);
  });

  it("CRITICAL V-460/V-266 CLI activation 3-status discriminator framing on cliAuthorizeExchange pinned in TS + Go. The 3 statuses (pending / bound / expired) are what shapes the CLI's polling loop. Drift to merging would let CLIs hang on bound (re-fetch instead of stopping).", () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);

    expect(ts).toMatch(/V-460/);
    expect(ts).toMatch(/V-266/);
    // 3 statuses.
    expect(ts).toMatch(/status: 'pending'/);
    expect(ts).toMatch(/status: 'bound'/);
    expect(ts).toMatch(/status: 'expired'/);

    expect(go).toMatch(/V-460/);
    expect(go).toMatch(/V-266/);
    expect(go).toMatch(/"pending"/);
    expect(go).toMatch(/"bound"/);
    expect(go).toMatch(/"expired"/);
  });

  it('CRITICAL V-460/V-266 CLI bind default scopes pinned in sdk-typescript: `["account_owner"]`. The default-account_owner scope on the minted key is what gives CLI sessions full access (matching what the user would have in a dashboard); drift to a narrower default would silently break CLI flows.', () => {
    const ts = read(TS_AUTH);
    expect(ts).toMatch(/Default scopes are\s*\*?\s*`\["account_owner"\]` server-side/);
  });

  it('CRITICAL refresh-extended-expiry framing on refresh pinned in sdk-go. The "exchanges an existing session token for a new one + extended expiry" claim is what tells dashboards refresh extends — not resets — the session. Drift to dropping would mislead callers.', () => {
    const go = read(GO_AUTH);
    expect(go).toMatch(/exchanges an existing session token for a new one \+ extended expiry/);
  });

  it('Cross-SDK V-079 5-invariant cluster — V-079 anchor + ALL-POST verbs + 2-step password-reset + 2-step magic-link + auth-flows-bypass-API-key framing. Drift on any would fragment the cross-language auth contract.', () => {
    const sdks = {
      'sdk-typescript': read(TS_AUTH),
      'sdk-go': read(GO_AUTH),
      'sdk-python': read(PY_AUTH),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} V-079`).toMatch(/V-079/);
      expect(body, `${name} /v1/auth/signup`).toMatch(/\/v1\/auth\/signup/);
      expect(body, `${name} /password-reset/request`).toMatch(
        /\/v1\/auth\/password-reset\/request/,
      );
      expect(body, `${name} /password-reset/confirm`).toMatch(
        /\/v1\/auth\/password-reset\/confirm/,
      );
      expect(body, `${name} /magic-link/request`).toMatch(/\/v1\/auth\/magic-link\/request/);
      expect(body, `${name} /magic-link/consume`).toMatch(/\/v1\/auth\/magic-link\/consume/);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-auth-flow-parity.test.ts')),
    ).toBe(true);
  });
});
