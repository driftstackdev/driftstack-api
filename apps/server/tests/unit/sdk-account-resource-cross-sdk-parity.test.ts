// W829 — cross-SDK AccountResource methods parity. One-hundred-
// fifty-fifth in the drift-guard series. Pins the AccountResource
// method set across all 3 SDKs: V-352/V-352b account self-edit +
// avatar upload, V-NNN web-sessions management, W788 account rate-
// limits. Drift would break customer-dashboard /me + /security +
// /rate-limits flows.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/account.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/account.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/account.go');

// 8 shared method names cross-SDK.
const REQUIRED_METHODS: Array<[string, string, string]> = [
  ['me', 'me', 'Me'],
  ['updateMe', 'update_me', 'UpdateMe'],
  ['uploadAvatar', 'upload_avatar', 'UploadAvatar'],
  ['clearAvatar', 'clear_avatar', 'ClearAvatar'],
  ['listWebSessions', 'list_web_sessions', 'ListWebSessions'],
  ['revokeWebSession', 'revoke_web_session', 'RevokeWebSession'],
  ['revokeAllOtherWebSessions', 'revoke_all_other_web_sessions', 'RevokeAllOtherWebSessions'],
  ['rateLimits', 'rate_limits', 'RateLimits'],
];

describe('W829 cross-SDK AccountResource methods parity', () => {
  it('all 3 AccountResource files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── 8-required-method set ────────────────────────────────────

  it('CRITICAL all 8 AccountResource methods exist in all 3 SDKs — me + updateMe + uploadAvatar + clearAvatar + listWebSessions + revokeWebSession + revokeAllOtherWebSessions + rateLimits. Drift would break customer-dashboard /me + /security + /rate-limits flows.', () => {
    const ts = read(TS);
    const py = read(PY);
    const go = read(GO);

    for (const [tsName, pyName, goName] of REQUIRED_METHODS) {
      expect(ts, `TS missing '${tsName}('`).toMatch(new RegExp(`\\b${tsName}\\s*\\(`));
      expect(py, `Python missing 'def ${pyName}('`).toMatch(new RegExp(`def ${pyName}\\(`));
      expect(go, `Go missing 'func (r *AccountResource) ${goName}('`).toMatch(
        new RegExp(`func \\(r \\*AccountResource\\) ${goName}\\(`),
      );
    }
  });

  // ─── V-352/V-352b avatar upload + clear dual ──────────────────

  it('CRITICAL V-352/V-352b avatar dual pinned cross-SDK — uploadAvatar + clearAvatar. uploadAvatar accepts the UploadAvatarRequest body (base64 image); clearAvatar takes no body. Drift to a single method would conflate the upload-vs-remove semantics.', () => {
    expect(read(TS)).toMatch(
      /uploadAvatar\(body: UploadAvatarRequest\): Promise<UploadAvatarResponse>/,
    );
    expect(read(TS)).toMatch(/clearAvatar\(\): Promise<void>/);
    expect(read(PY)).toMatch(
      /def upload_avatar\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(read(PY)).toMatch(/def clear_avatar\(self\) -> None:/);
    expect(read(GO)).toMatch(
      /UploadAvatar\(ctx context\.Context, body \*UploadAvatarRequest\) \(\*UploadAvatarResponse, error\)/,
    );
    expect(read(GO)).toMatch(
      /func \(r \*AccountResource\) ClearAvatar\(ctx context\.Context\) error/,
    );
  });

  // ─── Web-sessions 3-method set ────────────────────────────────

  it("CRITICAL web-sessions 3-method set pinned cross-SDK — listWebSessions + revokeWebSession(id) + revokeAllOtherWebSessions. The 3 methods cover the customer 'I want to log out other browsers' security flow. Drift to dropping any would break the V-NNN web-sessions UI in customer-dashboard.", () => {
    expect(read(TS)).toMatch(/listWebSessions\(\): Promise<ListWebSessionsResponse>/);
    expect(read(TS)).toMatch(/revokeWebSession\(id: string\): Promise<void>/);
    expect(read(TS)).toMatch(/revokeAllOtherWebSessions\(\): Promise<void>/);
    expect(read(PY)).toMatch(/def revoke_web_session\(self, session_id: str\) -> None:/);
    expect(read(PY)).toMatch(/def revoke_all_other_web_sessions\(self\) -> None:/);
    expect(read(GO)).toMatch(/RevokeWebSession\(ctx context\.Context, sessionID string\) error/);
    expect(read(GO)).toMatch(/RevokeAllOtherWebSessions\(ctx context\.Context\) error/);
  });

  // ─── me() returns AccountSelfProfile ──────────────────────────

  it("CRITICAL me() returns AccountSelfProfile cross-SDK. TS: Promise<AccountSelfProfile>; Go: (*AccountSelfProfile, error). The 'self-profile' shape is V-352 — drift would break customer-dashboard /me page.", () => {
    expect(read(TS)).toMatch(/me\(\): Promise<AccountSelfProfile>/);
    expect(read(GO)).toMatch(/Me\(ctx context\.Context\) \(\*AccountSelfProfile, error\)/);
  });

  // ─── updateMe accepts UpdateAccountMeRequest ──────────────────

  it('CRITICAL updateMe accepts the canonical update body cross-SDK. TS: UpdateAccountMeRequest; Go: UpdateMeRequest (Go drops the Account prefix per typo-prevention convention). Drift to a different shape would break customer self-edit.', () => {
    expect(read(TS)).toMatch(
      /updateMe\(body: UpdateAccountMeRequest\): Promise<AccountSelfProfile>/,
    );
    expect(read(GO)).toMatch(
      /UpdateMe\(ctx context\.Context, body \*UpdateMeRequest\) \(\*AccountSelfProfile, error\)/,
    );
  });

  // ─── rateLimits() returns GetAccountRateLimitsResponse ────────

  it("CRITICAL rateLimits() returns GetAccountRateLimitsResponse cross-SDK. The /v1/account/rate-limits endpoint is the canonical 'what are my current rate-limit buckets' surface per W788 docs. Drift would break customer-dashboard /usage rate-limit-meter (W754).", () => {
    expect(read(TS)).toMatch(/rateLimits\(\): Promise<GetAccountRateLimitsResponse>/);
    expect(read(GO)).toMatch(
      /RateLimits\(ctx context\.Context\) \(\*GetAccountRateLimitsResponse, error\)/,
    );
  });

  // ─── revoke* methods return void ──────────────────────────────

  it('CRITICAL all 3 revoke* + clear* void-returning methods (revokeWebSession + revokeAllOtherWebSessions + clearAvatar) return void cross-SDK. HTTP 204 per API. Drift to returning the revoked item would let buggy customer code accidentally retry-with-revoked-session.', () => {
    expect(read(TS)).toMatch(/clearAvatar\(\): Promise<void>/);
    expect(read(TS)).toMatch(/revokeWebSession\(id: string\): Promise<void>/);
    expect(read(TS)).toMatch(/revokeAllOtherWebSessions\(\): Promise<void>/);
    expect(read(PY)).toMatch(/def clear_avatar\(self\) -> None:/);
    expect(read(PY)).toMatch(/def revoke_web_session\(self, session_id: str\) -> None:/);
    expect(read(PY)).toMatch(/def revoke_all_other_web_sessions\(self\) -> None:/);
    expect(read(GO)).toMatch(/ClearAvatar\(ctx context\.Context\) error/);
    expect(read(GO)).toMatch(/RevokeWebSession\(ctx context\.Context, sessionID string\) error/);
    expect(read(GO)).toMatch(/RevokeAllOtherWebSessions\(ctx context\.Context\) error/);
  });

  // ─── Python sync + async dual ─────────────────────────────────

  it('CRITICAL Python provides BOTH AccountResource (sync) AND AsyncAccountResource (async). Every method has an async counterpart.', () => {
    const p = read(PY);
    for (const [, pyName] of REQUIRED_METHODS) {
      expect(p, `Python AsyncAccountResource missing 'async def ${pyName}'`).toMatch(
        new RegExp(`async def ${pyName}\\(`),
      );
    }
  });

  // ─── Go ctx-first convention ──────────────────────────────────

  it('CRITICAL Go AccountResource methods all take ctx context.Context as first arg. Matches W822-W828 cross-SDK Go convention.', () => {
    const p = read(GO);
    for (const [, , goName] of REQUIRED_METHODS) {
      expect(p, `Go ${goName} must take ctx context.Context as first arg`).toMatch(
        new RegExp(`func \\(r \\*AccountResource\\) ${goName}\\(\\s*ctx context\\.Context`),
      );
    }
  });

  // ─── Python __init__ wiring ───────────────────────────────────

  it('CRITICAL Python AccountResource + AsyncAccountResource constructors take http client. Matches W822-W828 cross-SDK wiring.', () => {
    const p = read(PY);
    expect(p).toMatch(/def __init__\(self, http: HttpClient\) -> None:/);
    expect(p).toMatch(/def __init__\(self, http: AsyncHttpClient\) -> None:/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-account-resource-cross-sdk-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
