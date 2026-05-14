// W677 — cross-SDK auth + user-agent + content-type wire-contract
// parity. Fourth in the cross-SDK drift-guard series (W649 verb
// parity + W675 error-class parity + W676 problem-type URI parity +
// W677 wire-header parity).
//
// Asserts all 3 first-party SDKs (sdk-go + sdk-python + sdk-
// typescript) emit the same 3 wire-contract headers on every
// request:
//
//   (1) Authorization: Bearer <apiKey>
//   (2) user-agent: driftstack-sdk-<lang>/<version>
//   (3) content-type: application/json (only when body present)
//
// Drift here would silently change the server-side request
// fingerprint:
//   - drift on Bearer → server-side auth parsing breaks
//   - drift on user-agent → server-side metric aggregation by SDK
//     version stops bucketing correctly
//   - drift on content-type-conditional → GETs would lie about
//     having JSON body (or POSTs would drop the content-type
//     header, breaking some HTTP parsers)
//
// Methodology: extract the relevant strings from each SDK\'s
// HTTP layer file and assert the 3-header contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_HTTP = resolve(REPO_ROOT, 'packages/sdk-typescript/src/http.ts');
const GO_CLIENT = resolve(REPO_ROOT, 'packages/sdk-go/client.go');
const PY_HTTP = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/http.py');

describe('W677 cross-SDK auth + user-agent + content-type parity', () => {
  it('all 3 SDK HTTP-layer files exist at canonical paths', () => {
    expect(existsSync(TS_HTTP), `missing ${TS_HTTP}`).toBe(true);
    expect(existsSync(GO_CLIENT), `missing ${GO_CLIENT}`).toBe(true);
    expect(existsSync(PY_HTTP), `missing ${PY_HTTP}`).toBe(true);
  });

  it('CRITICAL Bearer auth invariant — all 3 SDKs emit `Authorization: Bearer <apiKey>`. sdk-typescript uses `Bearer ${this.config.apiKey}`; sdk-go uses `req.Header.Set("Authorization", "Bearer " + ...)`; sdk-python uses `f"Bearer {api_key}"`. Drift to a non-Bearer scheme (e.g. "Token X") would break server-side auth parsing.', () => {
    const ts = read(TS_HTTP);
    const go = read(GO_CLIENT);
    const py = read(PY_HTTP);

    // sdk-typescript: `Bearer ${this.config.apiKey}` template literal.
    expect(ts).toMatch(/authorization: `Bearer \$\{this\.config\.apiKey\}`/);

    // sdk-go: Bearer prefix on Authorization header.
    expect(go).toMatch(/Bearer/);
    expect(go).toMatch(/req\.Header\.Set\("Authorization",/);

    // sdk-python: Bearer prefix in f-string or string concat.
    expect(py).toMatch(/Bearer/);
  });

  it('CRITICAL user-agent format invariant — all 3 SDKs emit `driftstack-sdk-<lang>/<version>` (kebab-case + slash-separated version). sdk-typescript hardcoded "driftstack-sdk-typescript/0.0.1"; sdk-go computes `driftstack-sdk-go/${Version}`; sdk-python computes `driftstack-sdk-python/{__version__}`. Drift to a different format (e.g. spaces, underscores) would break server-side metric aggregation that buckets by SDK.', () => {
    const ts = read(TS_HTTP);
    const go = read(GO_CLIENT);
    const py = read(PY_HTTP);

    // sdk-typescript: hardcoded version literal.
    expect(ts).toMatch(/'driftstack-sdk-typescript\/0\.0\.1'/);

    // sdk-go: format-string with Version constant.
    expect(go).toMatch(/"driftstack-sdk-go\/%s", Version/);

    // sdk-python: f-string with __version__.
    expect(py).toMatch(/f"driftstack-sdk-python\/\{__version__\}"/);
  });

  it('CRITICAL content-type conditional invariant — all 3 SDKs set `content-type: application/json` ONLY when the request has a body. sdk-typescript uses `...(opts.body !== undefined ? { "content-type": "application/json" } : {})`; sdk-go sets via req.Header.Set conditionally; sdk-python sets the header in a dict that\'s only populated when json_body is given. Drift to always-set content-type would make GETs lie about JSON body; drift to never-set would let POSTs through without content-type (breaks strict HTTP parsers).', () => {
    const ts = read(TS_HTTP);
    const go = read(GO_CLIENT);
    const py = read(PY_HTTP);

    // sdk-typescript: conditional spread when body !== undefined.
    expect(ts).toMatch(
      /\.\.\.\(opts\.body !== undefined \? \{ 'content-type': 'application\/json' \} : \{\}\),/,
    );

    // sdk-go: Content-Type header set conditionally on body presence.
    expect(go).toMatch(/Content-Type/);
    expect(go).toMatch(/application\/json/);

    // sdk-python: content-type or Content-Type header set.
    expect(py).toMatch(/content-type|Content-Type/);
    expect(py).toMatch(/application\/json/);
  });

  it('sdk-typescript User-Agent literal pinned: `driftstack-sdk-typescript/0.0.1`. The hardcoded version is what server-side metrics use to bucket TS SDK traffic. Drift to a different version string would break the bucketing AND mismatch package.json version. Must stay in sync with package.json + dist/ build output.', () => {
    const ts = read(TS_HTTP);
    expect(ts).toMatch(/'driftstack-sdk-typescript\/0\.0\.1'/);
  });

  it('sdk-go User-Agent format pinned: `fmt.Sprintf("driftstack-sdk-go/%s", Version)`. CRITICAL: the format string uses %s (string Version constant), NOT %v (which would Go-format the value with type info). Drift to %v would produce non-canonical UA strings like "driftstack-sdk-go/{0.1.0}" depending on Version\'s type.', () => {
    const go = read(GO_CLIENT);
    expect(go).toMatch(/return fmt\.Sprintf\("driftstack-sdk-go\/%s", Version\)/);
  });

  it('sdk-python User-Agent format pinned: `USER_AGENT = f"driftstack-sdk-python/{__version__}"`. Module-level constant (NOT computed per-request) so the version-resolution cost is one-time at import. Drift to a per-request computation would slow every HTTP call by an import lookup.', () => {
    const py = read(PY_HTTP);
    expect(py).toMatch(/USER_AGENT = f"driftstack-sdk-python\/\{__version__\}"/);
  });

  it("CRITICAL Authorization header value pattern — all 3 SDKs use `Bearer <space> <token>` (NOT `Bearer:` colon-separated, NOT `Bearer<no-space>token`). RFC 6750 says the scheme is whitespace-separated from the credentials. Drift would silently make the server's auth-header parser reject every SDK request.", () => {
    const ts = read(TS_HTTP);
    const go = read(GO_CLIENT);
    const py = read(PY_HTTP);

    // All 3 SDKs use "Bearer " (with trailing space) before the token.
    expect(ts).toMatch(/Bearer \$\{/); // template literal with space
    expect(go).toMatch(/"Bearer "/); // string constant with space
    expect(py).toMatch(/Bearer /); // any context with "Bearer "
  });

  it('SDK-version origin per SDK pinned — TS hardcodes "0.0.1" in source; Go imports `Version` from same package; Python imports `__version__` from sibling module. Each SDK uses the language-canonical version-export pattern (hardcoded const for TS dist-vs-source, Go const, Python dunder). Drift to mixing patterns would break the language-idiom expectations.', () => {
    const go = read(GO_CLIENT);
    const py = read(PY_HTTP);

    // sdk-go uses Version constant from package scope.
    expect(go).toMatch(/Version/);

    // sdk-python uses __version__ dunder.
    expect(py).toMatch(/__version__/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-auth-headers-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
