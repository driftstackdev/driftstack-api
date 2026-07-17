// W764 — apps/docs api/auth.md content parity. Ninetieth in the
// cross-SDK drift-guard series.
//
// /api/auth is the canonical reference for customer-dashboard
// authentication. Drift to the discriminated-union login shape, the
// no-enumeration semantics on magic-link/password-reset, or the
// CLI-authorize 3-step flow would let SDK consumers' security
// expectations diverge from server enforcement.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/auth.md');

describe('W764 docs /api/auth content parity', () => {
  it('api/auth.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned. The description threads the full 8-flow set (signup/login/verify-email/MFA challenge+step-up/magic-link/password-reset/refresh/logout) + the API-key-bearer-distinct framing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Authentication flows\n/,
    );
    expect(p).toMatch(
      /description: Sign up, log in, verify email, MFA challenge \+ step-up, magic link, password reset, refresh, and logout for the customer dashboard\. Distinct from API-key bearer auth used by SDK consumers\./,
    );
  });

  it('CRITICAL three-auth-surfaces framing pins paid customer keys, dashboard sessions and restricted browser-authorized desktop credentials.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Driftstack has three auth surfaces:/);
    expect(p).toMatch(/\*\*Customer API-key bearer auth\*\* for SDK consumers on any paid/);
    expect(p).toMatch(/\*\*Web-session auth\*\* for the customer dashboard — covered here\./);
    expect(p).toMatch(/\*\*Browser-authorized device credentials\*\* for the desktop app/);
    expect(p).toMatch(/Email \+ password \(or magic link\), optional TOTP, exchanged for an/);
    expect(p).toMatch(/opaque session token stored in the dashboard's local storage\./);
  });

  it('CRITICAL bearer framing distinguishes paid ds_live keys, restricted Free ds_test device credentials, and opaque dashboard sessions.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/All three use the same `Authorization: Bearer <token>` header\./);
    expect(p).toMatch(/customer keys use `ds_live_…`/);
    expect(p).toMatch(/`ds_test_…` on Free/);
    expect(p).toMatch(/web sessions are\s*\n?opaque base64 tokens/);
    expect(p).toMatch(/They resume after an upgrade unless separately revoked or expired/);
    expect(p).toMatch(/The "apiAccess" feature is not available on the "free" tier/);
    expect(p).not.toMatch(/feature_not_available/);
  });

  it('CRITICAL signup 12-char-min password pinned. Matches W737 dashboard signup-form minlength=12 + W736 reset-password.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"password": "<min 12 chars>"/);
  });

  it("CRITICAL signup unverified→active transition framing pinned. The 'The account exists in unverified status until the customer clicks the verification link emailed to email' + 'Verifying email also marks the account active' is the load-bearing onboarding state-machine framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The account exists in `unverified` status until the customer clicks\s*\n?the verification link emailed to `email`\./,
    );
    expect(p).toMatch(/Verifying email\s*\n?also marks the account `active`/);
  });

  it('CRITICAL signup 409 on duplicate-email pinned. Drift to a different status code would let SDK consumers misclassify the failure.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`409 Conflict` is returned when `email` is already registered\./);
  });

  it("CRITICAL login discriminated-union return type pinned. The 'Returns a **discriminated union**' framing + the mfa_required branch matches W737 dashboard login V-353d branch handler.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Returns a \*\*discriminated union\*\*:/);
    expect(p).toMatch(/\*\*No MFA enrolled\*\* — same shape as `verify-email`:/);
    expect(p).toMatch(
      /\*\*MFA enrolled\*\* — challenge token returned; the dashboard drops\s*\n?\s+into the second-factor UI:/,
    );
  });

  it("CRITICAL MFA challenge_token 5-minute TTL pinned. The '<one-time, expires in 5 minutes>' wording is the load-bearing TTL bound — drift would let MFA-enrolled customers stuck on stale challenges.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/"challenge_token": "<one-time, expires in 5 minutes>"/);
  });

  it("CRITICAL login do-not-store-on-mfa_required framing pinned. The 'Branch on the mfa_required literal. When it\\'s present + true, do not store anything — wait for the customer to enter their TOTP code and call the challenge endpoint below' wording is the load-bearing security contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Branch on the `mfa_required` literal\. When it's present \+ true, do\s*\n?not store anything — wait for the customer to enter their TOTP/,
    );
  });

  it("CRITICAL SDK type-narrowing anchor pinned: '**SDK usage** (type narrowing + MFA exchange):' — threads the TS discriminated-union typing + the SDK exchange method. The previous skip pinned `(V-423/V-441/V-445 ...)` with the inline internal version anchors; the V-NNN anchors were removed from the customer-rendered copy as a UX cleanup (internal V-anchors should not bleed into docs.driftstack.dev pages); the substantive framing survives without them.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*SDK usage\*\* \(type narrowing \+ MFA exchange\):/);
    // Drift-guard: the internal V-423/V-441/V-445 anchors MUST NOT
    // bleed back into the customer-rendered "SDK usage" line.
    expect(p).not.toMatch(/V-423\/V-441\/V-445/);
  });

  it('CRITICAL MFA challenge 2-factor input — code (TOTP) OR recovery_code. Drift to forcing one would lose the recovery-fallback path.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"code": "123456" \/\/ OR "recovery_code": "ABCDE-FGHJK"/);
  });

  it("CRITICAL MFA challenge via discriminator pinned — 'totp' | 'recovery'. The 'via: \"totp\" | \"recovery\" indicates which factor was used' wording lets SDK consumers audit the path.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/The\s*\n?discriminator `via: "totp" \| "recovery"` indicates which factor/);
  });

  it('CRITICAL recovery_code consumption updates unused_recovery_codes + emits audit event pinned. Matches W755 /audit-log account.recovery_code_used + V-353b lifecycle.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`recovery_code` consumption decrements\s*\n?`unused_recovery_codes` on the account and is recorded as\s*\n?`account\.recovery_code_used` in the audit log with\s*\n?`payload\.remaining`\./,
    );
  });

  it("CRITICAL MFA step-up 15-minute freshness window pinned. The 'requires re-asserting the second factor within a 15-minute freshness window' wording matches W759 dashboard /settings step-up flow.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Used by\s*\n?the dashboard when a sensitive operation \(disable MFA, regenerate\s*\n?recovery codes, delete account\) requires re-asserting the second\s*\n?factor within a 15-minute freshness window\./,
    );
  });

  it('CRITICAL MFA step-up issues no new session, only refreshes mfa_satisfied_at framing pinned. Drift to issuing a new session would let SDK consumers double-sessions.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Returns `200`; no new session issued — the existing session row\s*\n?gets `mfa_satisfied_at = now\(\)`\./,
    );
  });

  it("CRITICAL magic-link + password-reset no-enumeration pinned. The 'Always returns 200 regardless of whether the address matches an account (no account-enumeration signal)' wording is the load-bearing privacy contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Always\s*\n?returns `200` regardless of whether the address matches an account\s*\n?\(no account-enumeration signal\)\./,
    );
    expect(p).toMatch(/Same no-enumeration semantics as magic-link: always `200`\./);
  });

  it('CRITICAL magic-link consume returns the login union and withholds a session until enrolled MFA succeeds', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`POST \/v1\/auth\/magic-link\/consume`[\s\S]+?returns the same discriminated union as password login/,
    );
    expect(p).toMatch(
      /The enrolled branch mints no session until\s*\n?the caller completes `POST \/v1\/auth\/mfa\/challenge`/,
    );
    expect(p).toMatch(/mailbox access is\s*\n?the first factor, not a bypass/);
  });

  it('CRITICAL password reset retires every predecessor and only mints a successor after the MFA branch is satisfied', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Changes the password and invalidates ALL prior sessions for the\s*\n?account/,
    );
    expect(p).toMatch(
      /with enrolled MFA, `mfa_required` is returned and \*\*no replacement\s*\n?session\*\* is minted until `POST \/v1\/auth\/mfa\/challenge` succeeds/,
    );
    expect(p).toMatch(/Every prior device must re-authenticate\./);
    expect(p).toMatch(
      /The reset-confirming device\s*\n?is logged in only after it receives the no-MFA session branch or\s*\n?successfully exchanges the MFA challenge\./,
    );
  });

  it("CRITICAL refresh invalidates previous token framing pinned. The 'Issues a fresh session token with a new expires_at. The previous token is invalidated' wording is the rotation-on-refresh contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Issues a fresh session token with a new `expires_at`\. The previous\s*\n?token is invalidated\./,
    );
  });

  it('CRITICAL logout 200 { ok } + subsequent-401 framing pinned. The route + LogoutResponseSchema + all 3 SDKs use 200 with a { ok: true } body (NOT 204 — the doc said 204 No Content once, which contradicted the SDK response type).', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Returns `200` with `\{ "ok": true \}`\. Subsequent requests with that\s*\n?token return `401 Unauthorized`\./,
    );
  });

  it('CRITICAL desktop activation 3-step flow pinned — initiate / bind / exchange for the device credential.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/^## Initiate activation$/m);
    expect(p).toMatch(/^## Bind activation \(dashboard\)$/m);
    expect(p).toMatch(/^## Exchange for the device credential$/m);
    expect(p).toMatch(/\[Exchange\]\(#exchange-for-the-device-credential\)/);
    expect(p).toMatch(/Step 1 — \*\*Initiate\*\* — the desktop app generates a CSRF nonce/);
    expect(p).toMatch(/Step 2 — \*\*Bind\*\* — the user signs in to the dashboard/);
    expect(p).toMatch(/Step 3 — \*\*Exchange\*\* — the desktop app polls/);
  });

  it('CRITICAL desktop bind stores only an encrypted provenance-bound device credential envelope under a hashed identifier', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /the server mints a provenance-bound device credential\s*\n?on the calling account and stores only its encrypted envelope under a hashed code\s*\n?identifier \(Redis, 2-minute post-bind TTL\)\./,
    );
  });

  it('CRITICAL desktop exchange status state-machine pinned — pending / bound / expired. The 3-state transition is what the polling device client drives off. (S27 re-pin: same sentence, unindented paragraph instead of list-item continuation.)', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`\{ status: "pending" \}` to\s*\n?\s*`\{ status: "bound", api_key, account_id \}`/,
    );
    expect(p).toMatch(/`\{ status: "expired" \}`/);
    // The code is deleted on delivery, so a re-poll returns expired
    // (HTTP 200) — NOT a 404 (cli-authorize.ts exchange() :226).
    expect(p).toMatch(/Bound is one-shot:[\s\S]*?`\{ status: "expired" \}` \(HTTP `200`\)/);
  });

  it("CRITICAL CSRF state 16-128 char nonce + dashboard-echo framing pinned. The 'The state parameter is a client-supplied 16-128 character random nonce. The dashboard echoes it back; the server verifies it matches on bind' wording is the load-bearing CSRF defense.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The `state` parameter is a client-supplied 16-128 character random\s*\n?nonce\. The dashboard echoes it back; the server verifies it matches\s*\n?on `bind` — defends against the dashboard being tricked into binding\s*\n?a code that wasn't issued in the same session\./,
    );
  });

  it('CRITICAL desktop activation default scope `account_owner` + read-only override pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The minted device credential carries `\["account_owner"\]` scope by default\./,
    );
    expect(p).toMatch(
      /Device\s*\n?clients that only need read access should pass `scopes: \["read"\]` on the\s*\n?`bind` call to follow least-privilege/,
    );
    expect(p).toMatch(
      /On Free, the server additionally restricts\s*\n?this credential to the registered desktop route allowlist/,
    );
    expect(p).toMatch(/does not turn it into a general-purpose customer API key/);
  });

  it("CRITICAL /v1/auth/* does NOT honor X-Driftstack-Account header pinned. The 'None of /v1/auth/* honors the team-RBAC X-Driftstack-Account header — auth is always per-credential, not per-team-context' wording is the load-bearing scope-discrimination framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /None of `\/v1\/auth\/\*` honors the team-RBAC\s*\n?`X-Driftstack-Account` header — auth is always per-credential, not\s*\n?per-team-context\./,
    );
    expect(p).toMatch(
      /The team header is only consulted on `\/v1\/\*`\s*\n?endpoints that operate on resources/,
    );
  });

  it('CRITICAL 8-endpoint canonical action set pinned — signup/verify-email/login/mfa/challenge/mfa/step-up/magic-link/password-reset/refresh/logout.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`POST \/v1\/auth\/signup`/);
    expect(p).toMatch(/`POST \/v1\/auth\/verify-email`/);
    expect(p).toMatch(/`POST \/v1\/auth\/login`/);
    expect(p).toMatch(/`POST \/v1\/auth\/mfa\/challenge`/);
    expect(p).toMatch(/`POST \/v1\/auth\/mfa\/step-up`/);
    expect(p).toMatch(/`POST \/v1\/auth\/magic-link\/request`/);
    expect(p).toMatch(/`POST \/v1\/auth\/magic-link\/consume`/);
    expect(p).toMatch(/`POST \/v1\/auth\/password-reset\/request`/);
    expect(p).toMatch(/`POST \/v1\/auth\/password-reset\/confirm`/);
    expect(p).toMatch(/`POST \/v1\/auth\/refresh`/);
    expect(p).toMatch(/`POST \/v1\/auth\/logout`/);
  });

  it('CRITICAL 3-step desktop activation endpoint set pinned — initiate/bind/exchange.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`POST \/v1\/auth\/cli-authorize\/initiate`/);
    expect(p).toMatch(/`POST \/v1\/auth\/cli-authorize\/bind-device-code`/);
    expect(p).toMatch(/`POST \/v1\/auth\/cli-authorize\/exchange`/);
  });

  it('CRITICAL 3-language SDK examples for both login + desktop activation. TypeScript + Python + Go each have a code block in the login + device-activation sections.', () => {
    const p = read(PAGE);

    // Login section: TypeScript discriminated-union narrowing.
    expect(p).toMatch(/\/\/ TypeScript — discriminated-union return type narrows automatically\./);
    // Login section: Python dict-shape.
    expect(p).toMatch(/# Python — dict-shape, branch on the same key\./);
    // Login section: Go.
    expect(p).toMatch(/\/\/ Go — LoginResponse carries both branches; check MfaRequired\./);

    // Device activation section: TypeScript.
    expect(p).toMatch(/await client\.auth\.cliAuthorizeInitiate\(/);
    // Device activation section: Python.
    expect(p).toMatch(/client\.auth\.cli_authorize_initiate\(/);
    // Device activation section: Go.
    expect(p).toMatch(/client\.Auth\.CliAuthorizeInitiate\(ctx,/);
  });

  it("CRITICAL active-sign-ins management cross-reference pinned. The 'see Account and the /v1/account/web-sessions endpoints' wording threads W759 /settings V-355 sessions-list-revoke flow.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /see \[Account\]\(\/api\/account\/\) and\s*\n?the `\/v1\/account\/web-sessions` endpoints/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/docs-pages-api-auth-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
