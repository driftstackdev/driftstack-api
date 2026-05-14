// W826 — cross-SDK ApiKeysResource methods parity. One-hundred-
// fifty-second in the drift-guard series. Pins the ApiKeysResource
// method set across all 3 SDKs. API keys are the auth root —
// drift would break customer-side key-management code (rotate +
// revoke are the credential-rotation primitives every security-
// conscious customer eventually uses).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/api-keys.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/api_keys.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/api_keys.go');

// 4 shared method names. Go uses APIKeys (initialism) for class name
// but the method names are all PascalCase like other resources.
const REQUIRED_METHODS: Array<[string, string, string]> = [
  ['create', 'create', 'Create'],
  ['list', 'list', 'List'],
  ['revoke', 'revoke', 'Revoke'],
  ['rotate', 'rotate', 'Rotate'],
];

describe('W826 cross-SDK ApiKeysResource methods parity', () => {
  it('all 3 ApiKeysResource files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── 4-required-method set ────────────────────────────────────

  it('CRITICAL all 4 ApiKeysResource methods exist in all 3 SDKs — create + list + revoke + rotate. Drift would break customer key-management code (rotate + revoke are the credential-rotation primitives).', () => {
    const ts = read(TS);
    const py = read(PY);
    const go = read(GO);

    for (const [tsName, pyName, goName] of REQUIRED_METHODS) {
      expect(ts, `TS missing '${tsName}('`).toMatch(new RegExp(`\\b${tsName}\\s*\\(`));
      expect(py, `Python missing 'def ${pyName}('`).toMatch(new RegExp(`def ${pyName}\\(`));
      expect(go, `Go missing 'func (r *APIKeysResource) ${goName}('`).toMatch(
        new RegExp(`func \\(r \\*APIKeysResource\\) ${goName}\\(`),
      );
    }
  });

  // ─── Go API-vs-Api initialism convention ──────────────────────

  it("CRITICAL Go uses 'APIKeysResource' (uppercase initialism per Go style guide) vs TS/Python 'ApiKeysResource'. Drift to renaming would break customer code that imports from go.mod path. The CreateAPIKeyRequest + APIKeyList Go types match the resource-name convention.", () => {
    const p = read(GO);
    expect(p).toMatch(/APIKeysResource/);
    expect(p).toMatch(/CreateAPIKeyRequest/);
    expect(p).toMatch(/CreateAPIKeyResponse/);
    expect(p).toMatch(/APIKeyList/);
    expect(p).toMatch(/RotateAPIKeyResponse/);
  });

  // ─── revoke() returns void cross-SDK ──────────────────────────

  it('CRITICAL revoke() returns void cross-SDK — TS Promise<void> / Python -> None / Go error-only. HTTP 204 per API. Drift to returning the revoked key would let buggy customer code accidentally retry-with-old-key after revoke.', () => {
    expect(read(TS)).toMatch(/revoke\(keyId: string\): Promise<void>/);
    expect(read(PY)).toMatch(/def revoke\(self, key_id: str\) -> None:/);
    expect(read(GO)).toMatch(
      /func \(r \*APIKeysResource\) Revoke\(ctx context\.Context, keyID string\) error/,
    );
  });

  // ─── create returns plaintext key once ────────────────────────

  it('CRITICAL create() returns CreateApiKeyResponse / CreateAPIKeyResponse cross-SDK. The response carries the plaintext key (only shown once per V-NNN convention). Drift to returning only the hashed key would silently break customer key-storage code.', () => {
    expect(read(TS)).toMatch(/create\(body: CreateApiKeyRequest\): Promise<CreateApiKeyResponse>/);
    expect(read(PY)).toMatch(
      /def create\(self, body: CreateApiKeyRequest \| dict\[str, Any\]\) -> CreateApiKeyResponse:/,
    );
    expect(read(GO)).toMatch(
      /Create\(ctx context\.Context, body \*CreateAPIKeyRequest\) \(\*CreateAPIKeyResponse, error\)/,
    );
  });

  // ─── rotate() carries optional name cross-SDK ─────────────────

  it('CRITICAL rotate() accepts optional name cross-SDK. TS: RotateApiKeyOptions = {}; Python: *, name: str | None = None (kwarg-only); Go: *RotateAPIKeyRequest pointer. Lets customers rotate without renaming.', () => {
    expect(read(TS)).toMatch(
      /rotate\(keyId: string, options: RotateApiKeyOptions = \{\}\): Promise<RotateApiKeyResponse>/,
    );
    expect(read(PY)).toMatch(
      /def rotate\(self, key_id: str, \*, name: str \| None = None\) -> RotateApiKeyResponse:/,
    );
    expect(read(GO)).toMatch(
      /Rotate\(ctx context\.Context, keyID string, body \*RotateAPIKeyRequest\) \(\*RotateAPIKeyResponse, error\)/,
    );
  });

  // ─── list returns ApiKeyList/APIKeyList ───────────────────────

  it('CRITICAL list() returns typed list response cross-SDK. TS: ApiKeyList; Python: ApiKeyList; Go: *APIKeyList. Drift to returning raw array would lose the envelope shape (data + next_cursor pattern shared with all list endpoints per W818).', () => {
    expect(read(TS)).toMatch(/list\(\): Promise<ApiKeyList>/);
    expect(read(PY)).toMatch(/def list\(self\) -> ApiKeyList:/);
    expect(read(GO)).toMatch(/List\(ctx context\.Context\) \(\*APIKeyList, error\)/);
  });

  // ─── Python sync + async dual ─────────────────────────────────

  it('CRITICAL Python provides BOTH ApiKeysResource (sync) AND AsyncApiKeysResource (async). Every method has an async counterpart.', () => {
    const p = read(PY);
    for (const [, pyName] of REQUIRED_METHODS) {
      expect(p, `Python AsyncApiKeysResource missing 'async def ${pyName}'`).toMatch(
        new RegExp(`async def ${pyName}\\(`),
      );
    }
  });

  // ─── Python duck-typed body ───────────────────────────────────

  it("CRITICAL Python create() accepts 'CreateApiKeyRequest | dict[str, Any]' duck-typed body. Matches W822-W825 cross-SDK Python duck-typing pattern.", () => {
    expect(read(PY)).toMatch(
      /def create\(self, body: CreateApiKeyRequest \| dict\[str, Any\]\) -> CreateApiKeyResponse:/,
    );
    expect(read(PY)).toMatch(
      /async def create\(self, body: CreateApiKeyRequest \| dict\[str, Any\]\) -> CreateApiKeyResponse:/,
    );
  });

  // ─── Go ctx-first convention ──────────────────────────────────

  it('CRITICAL Go ApiKeysResource methods all take ctx context.Context as first arg. Matches W822-W825 cross-SDK Go convention.', () => {
    const p = read(GO);
    for (const [, , goName] of REQUIRED_METHODS) {
      expect(p, `Go ${goName} must take ctx context.Context as first arg`).toMatch(
        new RegExp(`func \\(r \\*APIKeysResource\\) ${goName}\\(\\s*ctx context\\.Context`),
      );
    }
  });

  // ─── Python __init__ wiring ───────────────────────────────────

  it('CRITICAL Python ApiKeysResource + AsyncApiKeysResource constructors take http client. Matches W822-W825 cross-SDK wiring.', () => {
    const p = read(PY);
    expect(p).toMatch(/def __init__\(self, http: HttpClient\) -> None:/);
    expect(p).toMatch(/def __init__\(self, http: AsyncHttpClient\) -> None:/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-api-keys-resource-cross-sdk-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
