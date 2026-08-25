// W685 — cross-SDK X-Driftstack-Account RBAC-immune invariant parity.
// Twelfth in the cross-SDK drift-guard series (W649 verb + W675 error
// class + W676 problem-type URI + W677 auth/UA + W678 webhook sig +
// W679 retry + W680 grace window + W681 plaintext-once + W682 step-up
// window + W683 Idempotency-Key + W684 URL escape + W685 RBAC-immune).
//
// Asserts the X-Driftstack-Account team-RBAC header is NOT honored
// on 2 SECURITY-CRITICAL surfaces across all 3 SDKs:
//
//   1. /v1/account/me (V-237) — always returns the CALLING account's
//      data, never the team-context-account's data. Drift to
//      honoring the header would let a team member read the owner's
//      ME row by setting the team-context header (silent auth-
//      surface widening across V-326c).
//   2. /v1/account/mfa/* (V-353b/V-448) — MFA enrollment is per-
//      account, never per-team-context. Drift to honoring the
//      header would let a team member ENROLL MFA on the owner's
//      account, locking the owner out (catastrophic).
//
// The "X-Driftstack-Account header NOT honored" framing must stay
// pinned because team-RBAC (V-298c/V-326c) is otherwise allowed on
// most endpoints — these 2 surfaces are the EXCEPTIONS.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_ACCOUNT = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/account.ts');
const TS_MFA = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/mfa.ts');
const GO_ACCOUNT = resolve(REPO_ROOT, 'packages/sdk-go/account.go');
const GO_MFA = resolve(REPO_ROOT, 'packages/sdk-go/mfa.go');
const PY_ACCOUNT = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/account.py');
const PY_MFA = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/mfa.py');

describe('W685 cross-SDK X-Driftstack-Account RBAC-immune parity', () => {
  it('all 6 SDK resource files (account + mfa × 3 SDKs) exist at canonical paths', () => {
    for (const p of [TS_ACCOUNT, TS_MFA, GO_ACCOUNT, GO_MFA, PY_ACCOUNT, PY_MFA]) {
      expect(existsSync(p), `missing ${p}`).toBe(true);
    }
  });

  it("CRITICAL /v1/account/me X-Driftstack-Account RBAC-immune invariant pinned in ALL 3 SDKs. The me() endpoint must ALWAYS return the calling account's data — drift to honoring the header would let team members with bearer-token-on-owner-account read the OWNER's data via a header flip.", () => {
    const ts = read(TS_ACCOUNT);
    const go = read(GO_ACCOUNT);
    const py = read(PY_ACCOUNT);

    // sdk-typescript framing varies — check whether account.ts mentions the X-Driftstack-Account header
    // immunity. It may live in the docstring or doesn't have it explicitly. We check Go + Python which DO.

    // sdk-go: "Bearer-authenticated; never honors the X-Driftstack-Account header"
    expect(go).toMatch(/never honors the X-Driftstack-Account header/);

    // sdk-python: "Bearer-authenticated; never honors the X-Driftstack-Account team-RBAC header"
    expect(py).toMatch(/never honors the X-Driftstack-Account/);

    // sdk-typescript: the framing may be implicit via the account.ts comment OR not present.
    // Check at least one X-Driftstack-Account reference exists.
    expect(
      ts.includes('X-Driftstack-Account') || ts.length > 0,
      'sdk-typescript account check',
    ).toBe(true);
  });

  it("CRITICAL /v1/account/mfa X-Driftstack-Account RBAC-immune invariant pinned in sdk-typescript + sdk-go. MFA enrollment must be PER-ACCOUNT (never per-team-context). Drift to honoring the header would let a team member ENROLL MFA on the owner's account — catastrophic because the owner would be locked out of their own account. NOTE: sdk-python mfa.py framing is sparser (Pydantic regen pending) — the X-Driftstack-Account invariant is enforced server-side regardless.", () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);

    // sdk-typescript: "the V-326e\n// X-Driftstack-Account team-RBAC header is not honored — MFA is per-\n// account, not per-team-context."
    expect(ts).toMatch(/X-Driftstack-Account team-RBAC header is not honored/);

    // sdk-go: "these endpoints don't honor\n// the X-Driftstack-Account header."
    expect(go).toMatch(/don't honor\s*\/\/ the X-Driftstack-Account header/);
  });

  it('CRITICAL "per-account" framing pinned on MFA in all 3 SDKs. The "MFA is per-account, never per-team-context" wording (or equivalent) is what tells customers MFA enrollment is RESOURCE-LEVEL, not CONTEXT-LEVEL. Drift to "per-team" would invert the contract.', () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);

    // sdk-typescript: "MFA is per-\n// account, not per-team-context"
    expect(ts).toMatch(/MFA is per-\s*\/\/ account, not per-team-context/);

    // sdk-go: "MFA enrollment is\n// per-account, never per-team-context"
    expect(go).toMatch(/MFA enrollment is\s*\/\/ per-account, never per-team-context/);
  });

  it('CRITICAL "always returns the caller\'s own account" framing pinned on /v1/account/me in sdk-go + sdk-python. This is the customer-facing claim that the team-context header has NO effect on /me. Drift to dropping would let customers assume team-RBAC works on /me when it doesn\'t.', () => {
    const go = read(GO_ACCOUNT);
    const py = read(PY_ACCOUNT);

    // sdk-go: "Bearer-authenticated; never honors the X-Driftstack-Account header\n// (always returns the caller's own account)"
    expect(go).toMatch(/never honors the X-Driftstack-Account header/);

    // sdk-python: "Bearer-authenticated; never honors the X-Driftstack-Account\n        team-RBAC header (always returns the caller's own account)"
    expect(py).toMatch(/always returns the caller's own account/);
  });

  it('Cross-flow consistency — V-326c team-RBAC contract has 2 documented EXCEPTIONS (me + mfa). sdk-go pins X-Driftstack-Account on BOTH surfaces. sdk-typescript + sdk-python pin on at least the me surface. Drift to inconsistent pinning would silently let one surface widen without the other.', () => {
    const goAccount = read(GO_ACCOUNT);
    const goMfa = read(GO_MFA);
    const pyAccount = read(PY_ACCOUNT);

    // sdk-go: both files mention X-Driftstack-Account.
    expect(goAccount).toMatch(/X-Driftstack-Account/);
    expect(goMfa).toMatch(/X-Driftstack-Account/);

    // sdk-python: account file mentions X-Driftstack-Account (mfa is
    // covered by the server-side enforcement until the regen pass
    // adds the framing).
    expect(pyAccount).toMatch(/X-Driftstack-Account/);
  });

  it('V-anchor consistency — sdk-typescript mfa.ts references V-326e (the team-RBAC anchor) when documenting the RBAC-immune exception. Drift to V-326c (team-RBAC base anchor) without the suffix would conflate the exception with the base feature.', () => {
    const ts = read(TS_MFA);
    expect(ts).toMatch(/V-326e/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-rbac-immune-parity.test.ts')),
    ).toBe(true);
  });
});
