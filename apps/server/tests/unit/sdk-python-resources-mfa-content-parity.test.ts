// W582.A — drift guard for packages/sdk-python/src/resources/mfa.py.
// V-353b/V-448 MfaResource Python parity. Drift here either drops
// the V-353e step-up-gated disable or breaks the show-ONCE contract
// for otpauth URI / base32 secret / 10 recovery codes.
//
//   • 5 verbs each: status / enroll / verify / disable / regenerate_
//     recovery_codes.
//   • status() reads MFA enrollment state.
//   • enroll() returns otpauth URI + base32 secret (shown ONCE).
//   • verify() returns 10 single-use recovery codes (shown ONCE).
//   • disable() is V-353e step-up-gated (15min window).
//   • Cross-ref: pairs with client.auth.mfa_challenge + mfa_step_up.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/mfa.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W582.A packages/sdk-python/src/driftstack/resources/mfa.py content parity', () => {
  const body = read(LIB);

  it('Module docstring + V-353b/V-448 framing + auth-pair cross-ref (mfa_challenge + V-353e mfa_step_up) + dict[str, Any]-pending-regen pinned', () => {
    expect(body).toMatch(
      /^"""MFA enrollment resource — \/v1\/account\/mfa\/\* \(V-353b \/ V-448\)\.\n/,
    );
    expect(body).toMatch(/Pairs with ``client\.auth\.mfa_challenge`` \(login MFA exchange\) \+/);
    expect(body).toMatch(/``client\.auth\.mfa_step_up`` \(V-353e step-up gate\)\./);
    expect(body).toMatch(/Returns ``dict\[str, Any\]`` pending the next ``scripts\/generate\.sh``/);
    expect(body).toMatch(/regen pass — the rich enrollment shapes will surface as Pydantic/);
    expect(body).toMatch(/models then\./);
  });

  it('Sync MfaResource: 5 verbs — status / enroll (otpauth URI + base32 secret shown ONCE) / verify (10 recovery codes shown ONCE) / disable (V-353e step-up gated) / regenerate_recovery_codes', () => {
    expect(body).toMatch(/^class MfaResource:$/m);
    expect(body).toMatch(
      /def status\(self\) -> dict\[str, Any\]:\s*\n\s*"""Read MFA enrollment state for the calling account\."""\s*\n\s*return self\._http\.request\("GET", "\/v1\/account\/mfa"\)/,
    );
    expect(body).toMatch(/def enroll\(self\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""Start TOTP enrollment\. Returns otpauth URI \+ base32 secret/);
    expect(body).toMatch(/\(shown ONCE\)\. Customer scans the URI in their authenticator,/);
    expect(body).toMatch(/then calls :meth:`verify` with the first 6-digit code\."""/);
    expect(body).toMatch(
      /return self\._http\.request\("POST", "\/v1\/account\/mfa\/enroll", json_body=\{\}\)/,
    );
    expect(body).toMatch(/def verify\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""Confirm enrollment with the first code\. Returns 10 single-/);
    expect(body).toMatch(/use recovery codes \(shown ONCE\)\."""/);
    expect(body).toMatch(
      /return self\._http\.request\("POST", "\/v1\/account\/mfa\/verify", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(/def disable\(self, body: dict\[str, Any\]\) -> None:/);
    expect(body).toMatch(/"""Disable MFA\. Step-up gated \(V-353e\); call/);
    expect(body).toMatch(/``client\.auth\.mfa_step_up`` first if the 15-minute window is/);
    expect(body).toMatch(/stale\. Recovery codes are invalidated\."""/);
    expect(body).toMatch(
      /self\._http\.request\("DELETE", "\/v1\/account\/mfa", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(/def regenerate_recovery_codes\(self\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""Mint 10 fresh recovery codes\. Old codes invalidated\."""/);
    expect(body).toMatch(
      /return self\._http\.request\("POST", "\/v1\/account\/mfa\/recovery-codes\/regenerate", json_body=\{\}\)/,
    );
  });

  it('Async AsyncMfaResource: mirrored awaited 5-verb surface', () => {
    expect(body).toMatch(/^class AsyncMfaResource:$/m);
    expect(body).toMatch(
      /async def status\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/account\/mfa"\)/,
    );
    expect(body).toMatch(
      /async def enroll\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("POST", "\/v1\/account\/mfa\/enroll", json_body=\{\}\)/,
    );
    expect(body).toMatch(
      /async def disable\(self, body: dict\[str, Any\]\) -> None:\s*\n\s*await self\._http\.request\("DELETE", "\/v1\/account\/mfa", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(
      /async def regenerate_recovery_codes\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\(\s*\n\s*"POST", "\/v1\/account\/mfa\/recovery-codes\/regenerate", json_body=\{\}\s*\n\s*\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
