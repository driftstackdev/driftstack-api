// W838 — cross-SDK auth-scheme exclusivity. One-hundred-sixty-
// fourth in the drift-guard series. Pins that no SDK source has
// alternative auth schemes (Basic auth, query-string ?api_key=,
// custom X-API-Key header). Bearer-only is the canonical auth
// contract per W821 + RFC 6750 — drift to alternatives would
// silently break server-side auth or let credentials leak via
// URL query strings (which appear in proxy access logs).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// SDK files that handle outbound auth.
const SDK_AUTH_PATHS = [
  'packages/sdk-typescript/src/client.ts',
  'packages/sdk-typescript/src/http.ts',
  'packages/sdk-python/src/driftstack/client.py',
  'packages/sdk-python/src/driftstack/http.py',
  'packages/sdk-go/client.go',
  // Go inlines its HTTP path in each resource — check the auth pattern
  // via the doRequest helper in client.go.
];

describe('W838 cross-SDK auth-scheme exclusivity parity', () => {
  it('all SDK auth-handling files exist at canonical paths', () => {
    for (const f of SDK_AUTH_PATHS) {
      expect(existsSync(resolve(REPO_ROOT, f)), `${f} must exist`).toBe(true);
    }
  });

  // ─── Bearer auth is present in all 3 SDKs ─────────────────────

  it("CRITICAL all 3 SDKs send 'Authorization: Bearer <apiKey>' header per W821 + RFC 6750. The Bearer-token scheme is the canonical contract — drift would silently break server-side auth.", () => {
    const ts = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/http.ts'));
    const py = read(resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/http.py'));
    const go = read(resolve(REPO_ROOT, 'packages/sdk-go/client.go'));

    expect(ts).toMatch(/authorization: `Bearer \$\{[^}]+\}`/);
    expect(py).toMatch(/"authorization": f"Bearer \{api_key\}"/);
    // Go inlines auth via doRequest helper.
    expect(go).toMatch(/Bearer/);
  });

  // ─── NO Basic auth fallback ───────────────────────────────────

  it("CRITICAL NO SDK has 'Basic <base64>' auth fallback. Basic auth would let customers accidentally store API keys in 1-step-decoded form in logs/cookies. Drift to adding Basic-auth fallback would weaken the security model.", () => {
    for (const f of SDK_AUTH_PATHS) {
      const p = read(resolve(REPO_ROOT, f));
      expect(p, `${f} must not declare a Basic auth fallback`).not.toMatch(
        /authorization\s*[=:]\s*[`'"]Basic /i,
      );
      // Also no btoa(<creds>:<creds>) Basic-style encoding.
      expect(p, `${f} must not encode credentials as Basic auth`).not.toMatch(
        /btoa\([^)]*api_?key[^)]*:[^)]*\)/i,
      );
    }
  });

  // ─── NO query-string auth fallback ────────────────────────────

  it('CRITICAL NO SDK sends api_key in URL query-string. Query-string auth would leak credentials into proxy/CDN access logs (Cloudflare, nginx, etc) — a real privacy/security failure. Drift to ?api_key= or ?token= would be catastrophic.', () => {
    for (const f of SDK_AUTH_PATHS) {
      const p = read(resolve(REPO_ROOT, f));
      // Looking for patterns where api_key is appended to URL.
      expect(p, `${f} must not put api_key in URL query`).not.toMatch(/[?&]api_?key=/i);
      expect(p, `${f} must not append token to URL`).not.toMatch(/[?&]token=\$/i);
    }
  });

  // ─── NO custom X-API-Key header (Bearer-only) ─────────────────

  it("CRITICAL NO SDK uses a non-canonical 'X-API-Key' / 'X-Driftstack-Key' / 'API-Key' header. The Authorization: Bearer scheme is the ONLY supported auth header — drift to custom-header auth would fragment the contract.", () => {
    for (const f of SDK_AUTH_PATHS) {
      const p = read(resolve(REPO_ROOT, f));
      // Look for custom header SET. (Reading these headers is fine
      // — only the auth-injection path matters.)
      for (const wrongHeader of ['X-API-Key', 'X-Api-Key', 'X-Driftstack-Key', 'X-Auth-Token']) {
        expect(p, `${f} must not set custom auth header '${wrongHeader}'`).not.toMatch(
          new RegExp(`['"\`]${wrongHeader}['"\`]\\s*:\\s*[\`'"]`),
        );
      }
    }
  });

  // ─── apiKey input is required ─────────────────────────────────

  it("CRITICAL all 3 SDKs require apiKey to be provided. Python explicitly validates 'api_key is required and must be a string' (W819). TS DriftstackOptions has 'apiKey: string' (required, not optional). Go takes apiKey as the first positional arg to New(). Drift to making apiKey optional would let customers ship unauthenticated requests.", () => {
    const ts = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/client.ts'));
    const py = read(resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/client.py'));
    const go = read(resolve(REPO_ROOT, 'packages/sdk-go/client.go'));

    // TS: apiKey: string (NOT apiKey?: string).
    expect(ts).toMatch(/apiKey: string;/);
    expect(ts).not.toMatch(/apiKey\?: string;/);

    // Python: validates apiKey is required.
    expect(py).toMatch(/raise TypeError\("Driftstack: api_key is required/);

    // Go: New(apiKey string, ...).
    expect(go).toMatch(/New\(apiKey string/);
  });

  // ─── Auth header is on EVERY request (no per-call override) ───

  it('CRITICAL the auth header is injected at the HTTP-layer level on EVERY request — not per-resource-call. Drift to per-call auth would let one method silently omit the header, breaking calls that depend on it.', () => {
    const ts = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/http.ts'));
    const py = read(resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/http.py'));

    // TS: Bearer header in the HTTP-layer headers builder.
    expect(ts).toMatch(/authorization: `Bearer \$\{this\.config\.apiKey\}`,/);
    // Python: _build_headers(api_key) inserts authorization.
    expect(py).toMatch(
      /def _build_headers\(\s*api_key: str, has_body: bool, effective_account: str \| None = None\s*\) -> dict\[str, str\]:/,
    );
    expect(py).toMatch(/"authorization": f"Bearer \{api_key\}"/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-auth-scheme-exclusivity-cross-sdk-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
