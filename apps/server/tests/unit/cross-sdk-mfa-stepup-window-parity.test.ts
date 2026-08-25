// W682 — cross-SDK V-353e MFA step-up 15-minute window parity. Ninth
// in the cross-SDK drift-guard series (W649 verb + W675 error class
// + W676 problem-type URI + W677 auth/UA + W678 webhook sig + W679
// retry + W680 grace window + W681 plaintext-once + W682 step-up
// window).
//
// Asserts the V-353e 15-minute MFA step-up freshness window framing
// is consistent across all 3 SDKs in 3 SECURITY-CRITICAL places:
//
//   1. mfa.disable docstring — "Customer should call mfaStepUp first
//      if the 15-min window is stale" (step-up GATED destructive op)
//   2. auth.mfaStepUp docstring — "refresh mfa_satisfied_at on the
//      calling web session (V-353e step-up gate; 15-minute
//      freshness window). No new session issued"
//   3. MfaStepUpRequiredError docstring — "operation requires fresh
//      MFA proof (15-minute step-up window)" + remediation hint
//
// Drift to a different window (5min / 30min / 60min) in ANY SDK
// would silently change the auth-gate freshness contract that
// V-353e relies on for destructive operations like MFA disable.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_MFA = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/mfa.ts');
const TS_AUTH = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/auth.ts');
const TS_ERRORS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts');
const GO_MFA = resolve(REPO_ROOT, 'packages/sdk-go/mfa.go');
const GO_AUTH = resolve(REPO_ROOT, 'packages/sdk-go/auth.go');
const PY_MFA = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/mfa.py');
const PY_AUTH = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/auth.py');

describe('W682 cross-SDK V-353e MFA step-up 15-min window parity', () => {
  it('all 7 SDK resource files (mfa + auth × 3 SDKs + TS errors) exist at canonical paths', () => {
    for (const p of [TS_MFA, TS_AUTH, TS_ERRORS, GO_MFA, GO_AUTH, PY_MFA, PY_AUTH]) {
      expect(existsSync(p), `missing ${p}`).toBe(true);
    }
  });

  it('CRITICAL mfa.disable 15-min window framing pinned in all 3 SDKs. Drift to a shorter window (5min) would force customers to step-up RIGHT BEFORE disable; drift to a longer window (60min) would let stolen sessions disable MFA up to an hour later.', () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);
    const py = read(PY_MFA);

    // sdk-typescript: "(15-minute freshness window) — call `client.auth.mfaStepUp(...)`"
    expect(ts).toMatch(/15-minute freshness window/);

    // sdk-go: "the 15-min" (abbreviated form)
    expect(go).toMatch(/15-min/);

    // sdk-python: "the 15-minute window is stale"
    expect(py).toMatch(/15-minute window/);
  });

  it('CRITICAL auth.mfaStepUp 15-min window framing pinned in all 3 SDKs. CRITICAL "No new session issued; the existing session row\'s mfa timestamp advances" invariant: drift to issuing a new session would force cookie rotation mid-flow (breaks the "same session identity, just freshly MFA-proved" contract).', () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);
    const py = read(PY_AUTH);

    // sdk-typescript: "(V-353e step-up gate; 15-minute freshness window). No new session"
    expect(ts).toMatch(/V-353e step-up gate; 15-minute freshness window\)\. No new session/);

    // sdk-go: same framing.
    expect(go).toMatch(/V-353e step-up gate; 15-minute freshness window\)\. No new/);

    // sdk-python: "(V-353e step-up gate; 15-minute freshness window). No new session"
    expect(py).toMatch(/V-353e step-up gate; 15-minute freshness window\)\. No new session/);
  });

  it('CRITICAL sdk-typescript MfaStepUpRequiredError JSDoc pinned: "(15-minute step-up window)" + remediation hint "Customer should call `client.auth.mfaStepUp({ code })` and retry." Drift to dropping the remediation hint would lose the customer-facing guidance for recovering from a stale-step-up error.', () => {
    const ts = read(TS_ERRORS);
    expect(ts).toMatch(/V-353e — operation requires fresh MFA proof \(15-minute step-up window\)/);
    expect(ts).toMatch(/Customer should call `client\.auth\.mfaStepUp\(\{ code \}\)` and retry/);
  });

  it('CRITICAL "No new session issued" invariant pinned in all 3 SDKs. The "the existing session row\'s mfa timestamp advances" wording is what tells customers step-up is an UPDATE-IN-PLACE on the session, NOT a new login. Drift to forcing new session creation would break long-lived sessions across step-ups.', () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);
    const py = read(PY_AUTH);

    // sdk-typescript: "No new session\n   * issued; the existing session row's mfa timestamp advances"
    expect(ts).toMatch(
      /No new session\s*\*\s*issued; the existing session row's mfa timestamp advances/,
    );

    // sdk-go uses a slightly shorter form: "No new\n// session issued;
    // returns the new mfa_satisfied_at timestamp."
    expect(go).toMatch(/No new\s*\/\/ session issued; returns the new mfa_satisfied_at timestamp/);

    // sdk-python: "No new session\n        issued; the existing session's mfa timestamp advances"
    expect(py).toMatch(/No new session\s*issued; the existing session's mfa timestamp advances/);
  });

  it("Cross-flow consistency — mfa.disable + auth.mfaStepUp + MfaStepUpRequiredError all reference the SAME 15-min window. Drift to different windows across the 3 surfaces would fragment the customer's mental model (e.g. customer steps up because mfaStepUp says 15min, but then mfa.disable enforces 5min and the second call fails immediately).", () => {
    // Each SDK MUST reference 15-minute (or 15-min) somewhere across
    // mfa.disable + auth.mfaStepUp framing.
    const tsMfa = read(TS_MFA);
    const tsAuth = read(TS_AUTH);
    const goMfa = read(GO_MFA);
    const goAuth = read(GO_AUTH);
    const pyMfa = read(PY_MFA);
    const pyAuth = read(PY_AUTH);

    // All 6 files reference the 15-min window (in some form).
    for (const [name, body] of [
      ['tsMfa', tsMfa],
      ['tsAuth', tsAuth],
      ['goMfa', goMfa],
      ['goAuth', goAuth],
      ['pyMfa', pyMfa],
      ['pyAuth', pyAuth],
    ] as const) {
      expect(body, `${name} should reference 15-min(ute) window`).toMatch(/15-min(ute)?/);
    }
  });

  it('CRITICAL "Recovery codes are invalidated" side-effect on mfa.disable pinned in all 3 SDKs. The destructive side-effect IS load-bearing — drift to NOT invalidating recovery codes on disable would leave them valid for a future re-enroll (defeating the disable-as-reset semantic). Plus, an attacker who disables MFA but somehow has recovery codes from before could re-enable + use them.', () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);
    const py = read(PY_MFA);

    expect(ts).toMatch(/Recovery codes are invalidated/);
    expect(go).toMatch(/Recovery codes are invalidated/);
    expect(py).toMatch(/Recovery codes are invalidated/);
  });

  it("Per-SDK MfaStepUp call-site reference — mfa.disable docstring tells customers WHERE to call to refresh the gate. sdk-typescript: `client.auth.mfaStepUp(...)`. sdk-go: `MfaStepUp(ctx, ...)`. sdk-python: `client.auth.mfa_step_up`. Each follows the SDK's naming convention (camelCase / PascalCase-public / snake_case) — drift to inconsistent names would break customer code that follows the docstring hint.", () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);
    const py = read(PY_MFA);

    // sdk-typescript: `client.auth.mfaStepUp(...)`
    expect(ts).toMatch(/client\.auth\.mfaStepUp\(\.\.\.\)/);

    // sdk-go: `MfaStepUp(ctx, ...)`
    expect(go).toMatch(/MfaStepUp\(ctx, \.\.\.\)/);

    // sdk-python: `client.auth.mfa_step_up`
    expect(py).toMatch(/client\.auth\.mfa_step_up/);
  });

  it('Anchor consistency — V-353e (lowercase e suffix) pinned exactly across the 3 SDKs. The V-353e is the changelog anchor for the step-up window feature; drift to V-353 (no suffix) would conflate with the broader MFA anchor.', () => {
    const tsMfa = read(TS_MFA);
    const tsAuth = read(TS_AUTH);
    const tsErrors = read(TS_ERRORS);
    const goAuth = read(GO_AUTH);
    const pyAuth = read(PY_AUTH);

    // All references use V-353e (lowercase e suffix).
    expect(tsMfa).toMatch(/V-353e/);
    expect(tsAuth).toMatch(/V-353e/);
    expect(tsErrors).toMatch(/V-353e/);
    expect(goAuth).toMatch(/V-353e/);
    expect(pyAuth).toMatch(/V-353e/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-mfa-stepup-window-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
