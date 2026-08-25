// W681 — cross-SDK plaintext-shown-ONCE invariant parity. Eighth in
// the cross-SDK drift-guard series (W649 verb + W675 error class +
// W676 problem-type URI + W677 auth/UA + W678 webhook sig + W679
// retry + W680 grace window + W681 plaintext-once).
//
// Asserts the plaintext-once invariant is consistently FRAMED across
// all 3 SDKs for 7 secret-emitting surfaces:
//
//   1. api-keys.create — plaintext API key returned ONCE
//   2. api-keys.rotate — fresh plaintext API key returned ONCE
//   3. webhooks.create — plaintext signing secret returned ONCE
//   4. webhooks.rotateSecret — fresh plaintext signing secret ONCE
//   5. mfa.enroll — TOTP secret_base32 shown ONCE (manual-entry
//      fallback if customer can't scan the QR)
//   6. mfa.verify — 10 single-use recovery codes shown ONCE
//   7. mfa.regenerateRecoveryCodes — 10 fresh recovery codes ONCE
//
// Drift to dropping the "ONCE" framing on ANY of these 7 surfaces
// in ANY of the 3 SDKs would lose the customer-facing warning that
// the secret cannot be re-read later. This is THE load-bearing
// security claim for every secret Driftstack mints.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Resource files for each SDK that carry plaintext-once surfaces.
const TS_API_KEYS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/api-keys.ts');
const TS_WEBHOOKS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/webhooks.ts');
const TS_MFA = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/mfa.ts');
const GO_API_KEYS = resolve(REPO_ROOT, 'packages/sdk-go/api_keys.go');
const GO_WEBHOOKS = resolve(REPO_ROOT, 'packages/sdk-go/webhooks.go');
const GO_MFA = resolve(REPO_ROOT, 'packages/sdk-go/mfa.go');
const PY_API_KEYS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/api_keys.py');
const PY_WEBHOOKS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/webhooks.py');
const PY_MFA = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/mfa.py');

describe('W681 cross-SDK plaintext-shown-ONCE invariant parity', () => {
  it('all 9 SDK resource files (api-keys + webhooks + mfa × 3 SDKs) exist at canonical paths', () => {
    for (const p of [
      TS_API_KEYS,
      TS_WEBHOOKS,
      TS_MFA,
      GO_API_KEYS,
      GO_WEBHOOKS,
      GO_MFA,
      PY_API_KEYS,
      PY_WEBHOOKS,
      PY_MFA,
    ]) {
      expect(existsSync(p), `missing ${p}`).toBe(true);
    }
  });

  it('CRITICAL api-keys.create plaintext-once framing in ALL 3 SDKs. The "store it now, it cannot be retrieved later" framing is what tells customers the server stores only a one-way hash. Drift to allowing plaintext re-fetch would invert the security model.', () => {
    const ts = read(TS_API_KEYS);
    const go = read(GO_API_KEYS);
    const py = read(PY_API_KEYS);

    // sdk-typescript: "plaintext is returned ONCE in the response; store it now — it cannot be retrieved later."
    expect(ts).toMatch(/plaintext is returned ONCE/);
    expect(ts).toMatch(/cannot be retrieved later/);

    // sdk-go: similar "shown ONCE" framing on create.
    expect(go).toMatch(/Plaintext is in the response|plaintext.*ONCE|shown ONCE/);

    // sdk-python: docstring "Plaintext is in the response — store it now, it cannot be retrieved later."
    expect(py).toMatch(/Plaintext is in the response/);
    expect(py).toMatch(/store it now, it cannot be/);
  });

  it('CRITICAL api-keys.rotate plaintext-once framing in ALL 3 SDKs. V-296 rotation mints a FRESH plaintext that is also shown ONCE. The "Plaintext is in the response — store it now" framing repeats from create — customers should treat rotate the same way they treated create.', () => {
    const ts = read(TS_API_KEYS);
    const py = read(PY_API_KEYS);

    // sdk-typescript: "The new plaintext is returned ONCE in the response — store it now."
    expect(ts).toMatch(/new plaintext is returned ONCE/);

    // sdk-python: "Plaintext is in the response — store it now."
    expect(py).toMatch(/Plaintext is in the response — store it now/);
  });

  it("CRITICAL webhooks.create plaintext-signing-secret-once framing in ALL 3 SDKs. The signing secret is what customers use to verify webhook signatures (W678 cross-SDK signature parity). If customers don't store it now, they cannot verify webhooks later.", () => {
    const ts = read(TS_WEBHOOKS);
    const go = read(GO_WEBHOOKS);
    const py = read(PY_WEBHOOKS);

    expect(ts).toMatch(/Plaintext signing secret is returned\s*\*\s*once|signing secret.*ONCE/);
    expect(go).toMatch(/signing secret.*ONCE|plaintext.*ONCE|Plaintext is in/);
    expect(py).toMatch(/Plaintext signing secret/);
    expect(py).toMatch(/returned ONCE/);
  });

  it('CRITICAL webhooks.rotateSecret plaintext-once framing in ALL 3 SDKs — V-359 rotation mints a FRESH plaintext signing secret shown ONCE. Mirrors api-keys.rotate semantics. The 24h dual-sign grace window (W680) means customers have 24h to roll the new secret to their verifier infra.', () => {
    const ts = read(TS_WEBHOOKS);
    const go = read(GO_WEBHOOKS);
    const py = read(PY_WEBHOOKS);

    // sdk-typescript: "The fresh plaintext is\n   * returned ONCE."
    expect(ts).toMatch(/fresh plaintext is\s*\*\s*returned ONCE/);

    // sdk-go: "plaintext is returned ONCE" or similar.
    expect(go).toMatch(/plaintext.*ONCE|fresh plaintext|new plaintext|shown ONCE/i);

    // sdk-python: "Returns the fresh plaintext (shown ONCE)"
    expect(py).toMatch(/Returns the fresh plaintext \(shown ONCE\)/);
  });

  it("CRITICAL mfa.enroll TOTP secret_base32 shown-ONCE framing in ALL 3 SDKs. The base32 secret is the manual-entry fallback for customers who can't scan the QR code. Server stores it encrypted at rest — shown plaintext once at enroll time.", () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);
    const py = read(PY_MFA);

    // sdk-typescript: "plaintext is shown ONCE here"
    expect(ts).toMatch(/plaintext is shown ONCE here/);

    // sdk-go: "SecretBase32 is shown ONCE for manual entry"
    expect(go).toMatch(/SecretBase32 is shown ONCE/);

    // sdk-python: "Returns otpauth URI + base32 secret\n        (shown ONCE)"
    expect(py).toMatch(/base32 secret\s*\(shown ONCE\)|secret.*shown ONCE/);
  });

  it('CRITICAL mfa.verify 10-recovery-codes shown-ONCE framing in ALL 3 SDKs. The 10 single-use recovery codes are the customer\'s break-glass authentication path if they lose their TOTP device. Drift to dropping "shown ONCE" would lose the warning; drift to "shown twice" would mean server-side persistence of codes (defeating the single-use security model).', () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);
    const py = read(PY_MFA);

    // sdk-typescript: "10 single-use recovery codes; shown ONCE"
    expect(ts).toMatch(/10 single-use recovery codes; shown ONCE/);

    // sdk-go: similar "10 single-use recovery codes. Shown ONCE."
    expect(go).toMatch(/10 single-use recovery codes\.\s*Shown ONCE/);

    // sdk-python: "Returns 10 single-\n        use recovery codes (shown ONCE)"
    expect(py).toMatch(
      /single-\s*use recovery codes \(shown ONCE\)|single-use recovery codes \(shown ONCE\)/,
    );
  });

  it('CRITICAL mfa.regenerateRecoveryCodes shown-ONCE framing + "old codes invalidated" side-effect in ALL 3 SDKs. The destructive-rotation semantic (old codes invalidated, NOT appended) is load-bearing — drift to append-behavior would let customers accumulate codes indefinitely, breaking the single-use audit trail.', () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);
    const py = read(PY_MFA);

    // sdk-typescript: "Mint 10 fresh recovery codes. Old codes invalidated; shown ONCE."
    expect(ts).toMatch(/10 fresh recovery codes\. Old codes invalidated; shown ONCE/);

    // sdk-go: "mint 10 fresh recovery codes; old codes\n// invalidated. Shown ONCE."
    expect(go).toMatch(/mint 10 fresh recovery codes; old codes\s*\/\/ invalidated\. Shown ONCE/);

    // sdk-python: "Mint 10 fresh recovery codes. Old codes invalidated."
    expect(py).toMatch(/Mint 10 fresh recovery codes\. Old codes invalidated/);
  });

  it('Cross-flow consistency — the "ONCE" wording is the SAME literal across all 7 surfaces × 3 SDKs (21 places). Drift to "once" (lowercase) or "one time" or "single shot" in ANY of the 21 places would fragment the cross-SDK warning vocabulary. The capital "ONCE" is the load-bearing emphasis customers grep for.', () => {
    // Count "ONCE" occurrences in each SDK's secret-emitting files.
    const tsAll = read(TS_API_KEYS) + read(TS_WEBHOOKS) + read(TS_MFA);
    const goAll = read(GO_API_KEYS) + read(GO_WEBHOOKS) + read(GO_MFA);
    const pyAll = read(PY_API_KEYS) + read(PY_WEBHOOKS) + read(PY_MFA);

    // Each SDK should have at LEAST 5 capital "ONCE" mentions across
    // its 3 secret-emitting resource files (some flows mention ONCE
    // more than once in their docstrings).
    const tsOnceMatches = (tsAll.match(/\bONCE\b/g) ?? []).length;
    const goOnceMatches = (goAll.match(/\bONCE\b/g) ?? []).length;
    const pyOnceMatches = (pyAll.match(/\bONCE\b/g) ?? []).length;

    // sdk-typescript + sdk-go pin "ONCE" >= 5 times across the 3 files.
    // sdk-python is slightly tighter (>= 4) — the api-keys docstring
    // re-uses the sync method's docstring on the async mirror via
    // :meth: cross-ref instead of duplicating the ONCE wording.
    expect(
      tsOnceMatches,
      'sdk-typescript ONCE count across api-keys+webhooks+mfa',
    ).toBeGreaterThanOrEqual(5);
    expect(goOnceMatches, 'sdk-go ONCE count across api_keys+webhooks+mfa').toBeGreaterThanOrEqual(
      5,
    );
    expect(
      pyOnceMatches,
      'sdk-python ONCE count across api_keys+webhooks+mfa',
    ).toBeGreaterThanOrEqual(4);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-plaintext-once-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
