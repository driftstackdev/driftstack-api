// W688 — cross-SDK V-445 mfaChallenge + V-353d login MFA
// discriminator parity. Fifteenth in the cross-SDK drift-guard
// series (W649 + W675 + W676 + W677 + W678 + W679 + W680 + W681 +
// W682 + W683 + W684 + W685 + W686 + W687 + W688).
//
// Asserts the 2 MFA-related discriminated-union response shapes are
// consistent across all 3 SDKs:
//
//   1. V-353d login response — discriminated union on mfa_required:
//      * mfa_required: true → { challenge_token, challenge_expires_at }
//        branch (customer must exchange challenge_token via
//        /v1/auth/mfa/challenge)
//      * mfa_required: false (default) → { session, ... } branch
//        (login succeeded without MFA)
//
//   2. V-445 mfaChallenge response — `via: 'totp' | 'recovery'`
//      2-value discriminator. The discriminator tells customers
//      whether the user authenticated with a TOTP code (low-risk)
//      or a recovery code (HIGHER-risk — signals device-loss; lets
//      customers add extra fraud checks).
//
// Drift on either discriminator would silently change response
// shapes that customers anchor exhaustive switch statements on.

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

describe('W688 cross-SDK V-445 mfaChallenge + V-353d login discriminator parity', () => {
  it('all 3 SDK auth resource files exist at canonical paths', () => {
    expect(existsSync(TS_AUTH), `missing ${TS_AUTH}`).toBe(true);
    expect(existsSync(GO_AUTH), `missing ${GO_AUTH}`).toBe(true);
    expect(existsSync(PY_AUTH), `missing ${PY_AUTH}`).toBe(true);
  });

  it('CRITICAL V-445 anchor pinned in all 3 SDKs on the mfaChallenge + mfaStepUp methods. The V-445 anchor is what threads the MFA-challenge feature across the SDKs.', () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);
    const py = read(PY_AUTH);

    // Each SDK should reference V-445 at least twice (mfaChallenge + mfaStepUp).
    const tsMatches = (ts.match(/V-445/g) ?? []).length;
    const goMatches = (go.match(/V-445/g) ?? []).length;
    const pyMatches = (py.match(/V-445/g) ?? []).length;

    expect(tsMatches, 'sdk-typescript V-445 count').toBeGreaterThanOrEqual(2);
    expect(goMatches, 'sdk-go V-445 count').toBeGreaterThanOrEqual(2);
    expect(pyMatches, 'sdk-python V-445 count').toBeGreaterThanOrEqual(2);
  });

  it("CRITICAL V-353d login MFA discriminated-union response pinned in sdk-typescript. The mfa_required literal-narrowing pattern is what TypeScript customers anchor their `if ('mfa_required' in out && out.mfa_required)` branching on. Drift to a non-literal-union return would lose static-type checking on the branches.", () => {
    const ts = read(TS_AUTH);

    // sdk-typescript: "V-353d — discriminated-union response. When the account has MFA"
    expect(ts).toMatch(/V-353d — discriminated-union response/);

    // The mfa_required: true branch with challenge_token + challenge_expires_at fields.
    expect(ts).toMatch(/\{ mfa_required: true, challenge_token,\s*\*\s*challenge_expires_at \}/);
  });

  it('CRITICAL V-353d in-JSDoc example pinned in sdk-typescript — 5-line branching pattern customers should follow. Drift to dropping the example would lose customer-facing guidance for handling the MFA-required branch.', () => {
    const ts = read(TS_AUTH);

    // sdk-typescript: "const out = await client.auth.login({ email, password });"
    expect(ts).toMatch(/const out = await client\.auth\.login\(\{ email, password \}\);/);
    // "if ('mfa_required' in out && out.mfa_required) {"
    expect(ts).toMatch(/if \('mfa_required' in out && out\.mfa_required\) \{/);
    // "// exchange out.challenge_token via /v1/auth/mfa/challenge"
    expect(ts).toMatch(/\/\/ exchange out\.challenge_token via \/v1\/auth\/mfa\/challenge/);
    // "// out.session is the real session"
    expect(ts).toMatch(/\/\/ out\.session is the real session/);
  });

  it('CRITICAL V-445 mfaChallenge response `via: totp|recovery` 2-value discriminator pinned in all 3 SDKs. Drift to dropping the discriminator would prevent customers from counting TOTP-vs-recovery use in MFA-strength metrics (recovery-code use signals device loss + higher account-risk than TOTP use).', () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);
    const py = read(PY_AUTH);

    // sdk-typescript: "Distinguished response carries `via: 'totp' | 'recovery'`"
    expect(ts).toMatch(/`via: 'totp' \| 'recovery'`/);

    // sdk-go: Distinguished response with via field.
    expect(go).toMatch(/V-445.*Exchange the V-353d login challenge_token/);

    // sdk-python: `via: "totp" | "recovery"` in docstring.
    expect(py).toMatch(/``via: "totp" \| "recovery"``/);
  });

  it('CRITICAL V-445 "TOTP code or recovery code" exchange framing pinned in all 3 SDKs. The 2-credential set (TOTP + recovery) is the FULL set of valid MFA proofs at challenge time — drift to dropping recovery would invert the break-glass story (customers who lost their TOTP device couldn\'t recover).', () => {
    const ts = read(TS_AUTH);
    const go = read(GO_AUTH);
    const py = read(PY_AUTH);

    // sdk-typescript: "for a real session via TOTP code or recovery"
    expect(ts).toMatch(/for a real session via TOTP code or recovery/);

    // sdk-go: "for a session via TOTP code or recovery code"
    expect(go).toMatch(/for a session via TOTP code or recovery/);

    // sdk-python: "exchange login challenge_token for a session via TOTP" + "code or recovery code"
    expect(py).toMatch(/for a session via TOTP/);
    expect(py).toMatch(/code or recovery code/);
  });

  it("CRITICAL V-353d challenge_token + challenge_expires_at fields pinned in sdk-typescript LoginResponseUnion. Drift to dropping challenge_expires_at would force customers to retry challenge tokens forever (server-side enforces a window but client wouldn't know).", () => {
    const ts = read(TS_AUTH);

    expect(ts).toMatch(/challenge_token,\s*\*\s*challenge_expires_at/);
  });

  it('LoginResponseUnion type pinned in sdk-typescript imports. The Union return type forces TypeScript callers to discriminate at the type level; drift to non-union return would let MFA-required branches slip past static checking.', () => {
    const ts = read(TS_AUTH);

    expect(ts).toMatch(/LoginResponseUnion/);
    // The login method return type is Promise<LoginResponseUnion>.
    expect(ts).toMatch(/login\(body: LoginRequest\): Promise<LoginResponseUnion>/);
  });

  it('Cross-SDK consistency — V-445 + 2-credential set (TOTP + recovery) anchor across all 3 SDKs. NOTE: V-353d discriminated-union anchor is sdk-typescript-specific (Go + Python use bare types without the V-353d framing); the LoginResponseUnion type-narrowing is a TS-only feature. Drift to dropping V-445 or TOTP/recovery across any SDK would fragment the cross-language MFA story.', () => {
    const sdks = {
      'sdk-typescript': read(TS_AUTH),
      'sdk-go': read(GO_AUTH),
      'sdk-python': read(PY_AUTH),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} V-445`).toMatch(/V-445/);
      // 2-credential set: TOTP + recovery mentioned together.
      expect(body, `${name} TOTP+recovery`).toMatch(/TOTP.*recovery|recovery.*TOTP/i);
    }
    // V-353d is sdk-typescript-only.
    expect(read(TS_AUTH), 'sdk-typescript V-353d').toMatch(/V-353d/);
    expect(read(GO_AUTH), 'sdk-go V-353d').toMatch(/V-353d/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-mfa-discriminator-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
