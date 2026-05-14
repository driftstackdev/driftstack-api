// W582.A (W641-deepened) — drift guard for packages/sdk-python/src/driftstack/resources/mfa.py.
// V-353b/V-448 MfaResource Python parity.
//
// W641 splits the 4 it() blocks (2 of which crammed all 5 sync verbs
// and all 5 async verbs into one) into 11 focused per-verb blocks +
// pins previously-implicit invariants:
//
//   • V-353e step-up-gated disable + 15-minute step-up window invariant.
//   • Show-ONCE invariants on (a) otpauth URI + base32 secret in
//     enroll, (b) 10 recovery codes in verify + regenerate_recovery_
//     codes. Mirrors the sdk-go W637 deepening.
//   • coerce_body call-sites on the 2 verbs that take a body
//     (verify, disable).
//   • disable returns None (Python's "no useful response" idiom; the
//     server returns 204).
//   • Sync + async parallel surface invariant — every sync verb has a
//     matching async twin with identical wire path + same coerce_body
//     wiring.

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

  it('file exists at canonical path + module docstring V-353b/V-448 framing + auth-pair cross-ref (mfa_challenge + V-353e mfa_step_up) + dict[str, Any]-pending-regen', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(
      /^"""MFA enrollment resource — \/v1\/account\/mfa\/\* \(V-353b \/ V-448\)\.\n/,
    );
    expect(body).toMatch(/Pairs with ``client\.auth\.mfa_challenge`` \(login MFA exchange\) \+/);
    expect(body).toMatch(/``client\.auth\.mfa_step_up`` \(V-353e step-up gate\)\./);
    expect(body).toMatch(/Returns ``dict\[str, Any\]`` pending the next ``scripts\/generate\.sh``/);
    expect(body).toMatch(/regen pass — the rich enrollment shapes will surface as Pydantic/);
    expect(body).toMatch(/models then\./);
  });

  it('MfaResource sync class with HttpClient injection. Same __init__ pattern as other resources so callers can swap transports for tests.', () => {
    expect(body).toMatch(/^class MfaResource:$/m);
    expect(body).toMatch(/"""Synchronous MFA enrollment resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
  });

  it('status (sync) — GET /v1/account/mfa reads enrollment state. No body, no special framing.', () => {
    expect(body).toMatch(
      /def status\(self\) -> dict\[str, Any\]:\s*\n\s*"""Read MFA enrollment state for the calling account\."""\s*\n\s*return self\._http\.request\("GET", "\/v1\/account\/mfa"\)/,
    );
  });

  it('enroll (sync) — POST /v1/account/mfa/enroll with json_body={} (explicit empty dict so the wire body is "{}" not "null"). Returns otpauth URI + base32 secret SHOWN ONCE — load-bearing security claim: customer must persist the secret/scan the QR immediately because the server stores only encrypted at rest.', () => {
    expect(body).toMatch(/def enroll\(self\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""Start TOTP enrollment\. Returns otpauth URI \+ base32 secret/);
    expect(body).toMatch(/\(shown ONCE\)\. Customer scans the URI in their authenticator,/);
    expect(body).toMatch(/then calls :meth:`verify` with the first 6-digit code\."""/);
    expect(body).toMatch(
      /return self\._http\.request\("POST", "\/v1\/account\/mfa\/enroll", json_body=\{\}\)/,
    );
  });

  it("verify (sync) — POST /v1/account/mfa/verify with coerce_body(body). Returns 10 SINGLE-USE recovery codes SHOWN ONCE. Single-use + shown-once + 10-count are all pinned because dropping any silently weakens the MFA-recovery story: customer must persist them now, can't list them later.", () => {
    expect(body).toMatch(/def verify\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""Confirm enrollment with the first code\. Returns 10 single-/);
    expect(body).toMatch(/use recovery codes \(shown ONCE\)\."""/);
    expect(body).toMatch(
      /return self\._http\.request\("POST", "\/v1\/account\/mfa\/verify", json_body=coerce_body\(body\)\)/,
    );
  });

  it('disable (sync) — DELETE /v1/account/mfa with coerce_body(body). RETURNS None (the only verb in the resource that does — Python idiom for "204 No Content, no useful response"). V-353e step-up gate + 15-MINUTE window invariant + "Recovery codes are invalidated" side-effect all pinned because dropping any silently makes MFA-disable easier than intended.', () => {
    expect(body).toMatch(/def disable\(self, body: dict\[str, Any\]\) -> None:/);
    expect(body).toMatch(/"""Disable MFA\. Step-up gated \(V-353e\); call/);
    expect(body).toMatch(/``client\.auth\.mfa_step_up`` first if the 15-minute window is/);
    expect(body).toMatch(/stale\. Recovery codes are invalidated\."""/);
    expect(body).toMatch(
      /self\._http\.request\("DELETE", "\/v1\/account\/mfa", json_body=coerce_body\(body\)\)/,
    );
  });

  it('regenerate_recovery_codes (sync) — POST /v1/account/mfa/recovery-codes/regenerate with json_body={}. Mints 10 fresh recovery codes; OLD CODES INVALIDATED framing pinned so customers know regeneration is a destructive rotation, not an append.', () => {
    expect(body).toMatch(/def regenerate_recovery_codes\(self\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""Mint 10 fresh recovery codes\. Old codes invalidated\."""/);
    expect(body).toMatch(
      /return self\._http\.request\(\s*"POST", "\/v1\/account\/mfa\/recovery-codes\/regenerate", json_body=\{\}\s*\)/,
    );
  });

  it('AsyncMfaResource — class shell + AsyncHttpClient injection. Mirrors the sync class.', () => {
    expect(body).toMatch(/^class AsyncMfaResource:$/m);
    expect(body).toMatch(/"""Async MFA enrollment resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: AsyncHttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
  });

  it('Async status + enroll — awaited GET /v1/account/mfa + awaited POST /v1/account/mfa/enroll. Same wire paths, same json_body={} for enroll, no body for status.', () => {
    expect(body).toMatch(
      /async def status\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/account\/mfa"\)/,
    );
    expect(body).toMatch(
      /async def enroll\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("POST", "\/v1\/account\/mfa\/enroll", json_body=\{\}\)/,
    );
  });

  it('Async verify — awaited POST /v1/account/mfa/verify with coerce_body. Same wire-level contract as sync verify.', () => {
    expect(body).toMatch(
      /async def verify\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\(\s*\n\s*"POST", "\/v1\/account\/mfa\/verify", json_body=coerce_body\(body\)\s*\n\s*\)/,
    );
  });

  it('Async disable + regenerate_recovery_codes — awaited DELETE + awaited POST twins. async disable returns None (just like sync); async regenerate returns the fresh codes dict.', () => {
    expect(body).toMatch(
      /async def disable\(self, body: dict\[str, Any\]\) -> None:\s*\n\s*await self\._http\.request\("DELETE", "\/v1\/account\/mfa", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(
      /async def regenerate_recovery_codes\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\(\s*\n\s*"POST", "\/v1\/account\/mfa\/recovery-codes\/regenerate", json_body=\{\}\s*\n\s*\)/,
    );
  });
});
