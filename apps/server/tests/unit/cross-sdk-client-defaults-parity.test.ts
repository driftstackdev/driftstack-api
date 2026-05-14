// W706 — cross-SDK Client defaults + HTTP layer parity. Thirty-third
// in the cross-SDK drift-guard series (W649 + W675-W706).
//
// Asserts the SDK Client/HTTP-layer defaults are consistent across
// all 3 SDKs:
//
//   - DEFAULT_BASE_URL = https://api.driftstack.dev (TS const +
//     Go const + Python const)
//   - DEFAULT_TIMEOUT = 30 seconds (TS 30_000ms + Go 30s + Python
//     30.0s)
//   - User-Agent format: driftstack-sdk-<lang>/<version>
//   - Authorization: Bearer <apiKey> on every non-auth-flow request
//   - Accept: application/json (Go pins explicit; TS+Python rely on
//     fetch/httpx default)
//   - Content-Type: application/json on body-bearing requests
//   - Trailing-slash stripping on baseUrl (TS strips with regex; Go
//     uses strings.TrimRight; Python uses .rstrip)
//   - Per-request timeout override
//
// CRITICAL invariants:
//   1. Same DEFAULT_BASE_URL across all 3 SDKs — drift to e.g. .com
//      vs .dev would silently route every customer's SDK to a
//      non-existent host.
//   2. Same DEFAULT_TIMEOUT (30s) — drift would silently change how
//      long the SDK hangs on slow networks.
//   3. User-Agent format matches `driftstack-sdk-<lang>/<version>` so
//      server-side telemetry can attribute traffic per SDK language.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_CLIENT = resolve(REPO_ROOT, 'packages/sdk-typescript/src/client.ts');
const TS_HTTP = resolve(REPO_ROOT, 'packages/sdk-typescript/src/http.ts');
const GO_CLIENT = resolve(REPO_ROOT, 'packages/sdk-go/client.go');
const PY_CLIENT = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/client.py');
const PY_HTTP = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/http.py');

describe('W706 cross-SDK Client defaults + HTTP layer parity', () => {
  it('all 5 SDK client + http files exist at canonical paths', () => {
    expect(existsSync(TS_CLIENT), `missing ${TS_CLIENT}`).toBe(true);
    expect(existsSync(TS_HTTP), `missing ${TS_HTTP}`).toBe(true);
    expect(existsSync(GO_CLIENT), `missing ${GO_CLIENT}`).toBe(true);
    expect(existsSync(PY_CLIENT), `missing ${PY_CLIENT}`).toBe(true);
    expect(existsSync(PY_HTTP), `missing ${PY_HTTP}`).toBe(true);
  });

  it('CRITICAL DEFAULT_BASE_URL = "https://api.driftstack.dev" pinned per-SDK. Drift to e.g. .com vs .dev would silently route every customer\'s SDK to a non-existent host. The 3 SDKs MUST converge on the same default.', () => {
    const ts = read(TS_CLIENT);
    const go = read(GO_CLIENT);
    const py = read(PY_CLIENT);

    // sdk-typescript: const DEFAULT_BASE_URL = 'https://api.driftstack.dev';
    expect(ts).toMatch(/const DEFAULT_BASE_URL = 'https:\/\/api\.driftstack\.dev'/);

    // sdk-go: const DefaultBaseURL = "https://api.driftstack.dev"
    expect(go).toMatch(/const DefaultBaseURL = "https:\/\/api\.driftstack\.dev"/);

    // sdk-python: DEFAULT_BASE_URL = "https://api.driftstack.dev"
    expect(py).toMatch(/DEFAULT_BASE_URL = "https:\/\/api\.driftstack\.dev"/);
  });

  it('CRITICAL DEFAULT_TIMEOUT = 30 seconds pinned per-SDK (TS 30_000ms + Go 30*time.Second + Python 30.0s). Drift would silently change how long the SDK hangs on slow networks — too short = false-positive timeouts; too long = customer dashboard freezes.', () => {
    const tsHttp = read(TS_HTTP);
    const go = read(GO_CLIENT);
    const pyHttp = read(PY_HTTP);

    // sdk-typescript: const DEFAULT_TIMEOUT_MS = 30_000;
    expect(tsHttp).toMatch(/DEFAULT_TIMEOUT_MS = 30_000/);

    // sdk-go: DefaultTimeout = 30 * time.Second
    expect(go).toMatch(/DefaultTimeout = 30 \* time\.Second/);

    // sdk-python: DEFAULT_TIMEOUT_S = 30.0
    expect(pyHttp).toMatch(/DEFAULT_TIMEOUT_S = 30\.0/);
  });

  it('CRITICAL User-Agent format pinned per-SDK — "driftstack-sdk-<lang>/<version>". Server-side telemetry attributes traffic per SDK language. Drift to a different shape would break the per-SDK breakdown.', () => {
    const tsHttp = read(TS_HTTP);
    const go = read(GO_CLIENT);
    const pyHttp = read(PY_HTTP);

    // sdk-typescript: 'user-agent': 'driftstack-sdk-typescript/0.0.1'
    expect(tsHttp).toMatch(/'user-agent':\s*'driftstack-sdk-typescript\/[\d.]+'/);

    // sdk-go: fmt.Sprintf("driftstack-sdk-go/%s", Version)
    expect(go).toMatch(/"driftstack-sdk-go\/%s"/);

    // sdk-python: USER_AGENT = f"driftstack-sdk-python/{__version__}"
    expect(pyHttp).toMatch(/USER_AGENT = f"driftstack-sdk-python\/\{__version__\}"/);
  });

  it('CRITICAL Authorization Bearer header set per-SDK on every request. The `Bearer <apiKey>` format is what the server-side auth gate matches against. Drift to a different scheme would silently break authentication.', () => {
    const tsHttp = read(TS_HTTP);
    const go = read(GO_CLIENT);
    const pyHttp = read(PY_HTTP);

    // sdk-typescript: authorization: `Bearer ${this.config.apiKey}`
    expect(tsHttp).toMatch(/authorization: `Bearer \$\{this\.config\.apiKey\}`/);

    // sdk-go: req.Header.Set("Authorization", "Bearer "+c.apiKey)
    expect(go).toMatch(/req\.Header\.Set\("Authorization", "Bearer "\+c\.apiKey\)/);

    // sdk-python: Bearer header in default headers dict.
    expect(pyHttp).toMatch(/"authorization":[\s\S]{0,40}Bearer/);
  });

  it('CRITICAL Content-Type: application/json set on body-bearing requests in all 3 SDKs. Drift to dropping would force the server to guess content-encoding from body bytes.', () => {
    const tsHttp = read(TS_HTTP);
    const go = read(GO_CLIENT);

    // sdk-typescript: conditional content-type on body presence.
    expect(tsHttp).toMatch(/'content-type':\s*'application\/json'/);

    // sdk-go: req.Header.Set("Content-Type", "application/json") inside if body
    expect(go).toMatch(/req\.Header\.Set\("Content-Type", "application\/json"\)/);
  });

  it("CRITICAL Accept: application/json pinned in sdk-go (explicit). TS + Python rely on fetch/httpx defaults; sdk-go must explicitly set it because Go's net/http doesn't default to JSON-friendly Accept.", () => {
    const go = read(GO_CLIENT);
    expect(go).toMatch(/req\.Header\.Set\("Accept", "application\/json"\)/);
  });

  it('CRITICAL trailing-slash strip on baseUrl pinned per-SDK. The strip prevents double-slash bugs when concatenating paths. Drift to NOT stripping would let `baseUrl="https://api.driftstack.dev/"` + path `/v1/profiles` produce `https://api.driftstack.dev//v1/profiles`.', () => {
    const ts = read(TS_CLIENT);
    const go = read(GO_CLIENT);
    const pyHttp = read(PY_HTTP);

    // sdk-typescript: baseUrl.replace(/\/+$/, '')
    expect(ts).toMatch(/\.replace\(\/\\\/\+\$\/, ''\)/);

    // sdk-go: strings.TrimRight(baseURL, "/")
    expect(go).toMatch(/strings\.TrimRight\(baseURL, "\/"\)/);

    // sdk-python: base_url.rstrip("/")
    expect(pyHttp).toMatch(/base_url\.rstrip\("\/"\)/);
  });

  it('CRITICAL retry policy applied to every call in all 3 SDKs. The retry policy is what handles transient 5xx + transport errors. Drift to dropping would let every transient network blip surface as a SessionsError to customers.', () => {
    const tsHttp = read(TS_HTTP);
    const go = read(GO_CLIENT);

    // sdk-typescript: withRetry wraps the request.
    expect(tsHttp).toMatch(/return withRetry\(/);

    // sdk-go: withRetry inside c.do.
    expect(go).toMatch(/return withRetry\(ctx, c\.retry,/);
  });

  it('CRITICAL per-request timeout override pinned per-SDK. The `timeoutMs` / per-request timeout lets callers tune individual slow operations (e.g. browser-session capture which takes longer than default 30s).', () => {
    const tsHttp = read(TS_HTTP);
    expect(tsHttp).toMatch(/timeoutMs\?:\s*number;?/);
    expect(tsHttp).toMatch(/opts\.timeoutMs \?\? this\.config\.timeoutMs \?\? DEFAULT_TIMEOUT_MS/);
  });

  it('CRITICAL sdk-go functional-options pattern pinned (Option type + WithBaseURL/WithHTTPClient/WithRetry/WithTimeout). The functional-options pattern is Go-idiomatic for SDK configuration; drift to a struct-config would break callers using these options.', () => {
    const go = read(GO_CLIENT);

    expect(go).toMatch(/type Option func\(\*Client\)/);
    expect(go).toMatch(/func WithBaseURL\(baseURL string\) Option/);
    expect(go).toMatch(/func WithHTTPClient\(h \*http\.Client\) Option/);
    expect(go).toMatch(/func WithRetry\(cfg RetryConfig\) Option/);
    expect(go).toMatch(/func WithTimeout\(d time\.Duration\) Option/);
  });

  it("CRITICAL sdk-go 16-resource roster pinned on Client struct. The full resource set is what makes `client.Sessions` / `client.AuditLog` etc. work; drift to dropping any field would break the SDK's resource-access surface.", () => {
    const go = read(GO_CLIENT);

    const resources = [
      'Sessions',
      'APIKeys',
      'Usage',
      'Webhooks',
      'Profiles',
      'ProfileSnapshots',
      'Billing',
      'CryptoOrders',
      'Auth',
      'Account',
      'Mfa',
      'AuditLog',
      'EmailPreferences',
      'Legal',
      'Team',
    ];

    for (const resource of resources) {
      const re = new RegExp(`\\b${resource}\\s+\\*${resource}Resource`);
      expect(go, `sdk-go resource ${resource}`).toMatch(re);
    }
  });

  it('CRITICAL sdk-go 8 MiB max-body cap pinned on response. Prevents a hostile server from OOMing the SDK by streaming an unbounded response. Drift to higher would silently widen the OOM-attack surface.', () => {
    const go = read(GO_CLIENT);
    expect(go).toMatch(/const maxBodyBytes = 8 \* 1024 \* 1024/);
  });

  it("CRITICAL ctx.Err() honoring in sdk-go transport — context.Canceled + context.DeadlineExceeded surface directly to the caller (not wrapped in TransportError). The plain-ctx-error semantic is what lets Go callers' `select { case <-ctx.Done() }` patterns work consistently.", () => {
    const go = read(GO_CLIENT);
    expect(go).toMatch(/errors\.Is\(err, context\.Canceled\)/);
    expect(go).toMatch(/errors\.Is\(err, context\.DeadlineExceeded\)/);
  });

  it('CRITICAL sdk-typescript Problem-doc validator pinned in http.ts. The isProblem() function gates whether to throw a typed DriftstackError (good) vs TransportError (fallback). Drift to dropping the type/title/status checks would let malformed problem-docs slip through.', () => {
    const tsHttp = read(TS_HTTP);

    expect(tsHttp).toMatch(/function isProblem\(x: unknown\): x is Problem/);
    expect(tsHttp).toMatch(/typeof r\.type === 'string'/);
    expect(tsHttp).toMatch(/typeof r\.title === 'string'/);
    expect(tsHttp).toMatch(/typeof r\.status === 'number'/);
  });

  it('Cross-SDK Client 5-invariant cluster — DEFAULT_BASE_URL + DEFAULT_TIMEOUT-30s + User-Agent format + Bearer auth + Content-Type application/json. Drift on any would fragment the cross-language Client contract.', () => {
    const tsClient = read(TS_CLIENT);
    const tsHttp = read(TS_HTTP);
    const go = read(GO_CLIENT);
    const pyClient = read(PY_CLIENT);
    const pyHttp = read(PY_HTTP);

    // All 3 SDKs converge on api.driftstack.dev default.
    expect(tsClient).toMatch(/api\.driftstack\.dev/);
    expect(go).toMatch(/api\.driftstack\.dev/);
    expect(pyClient).toMatch(/api\.driftstack\.dev/);

    // All 3 SDKs reference Bearer auth.
    expect(tsHttp).toMatch(/Bearer/);
    expect(go).toMatch(/Bearer/);
    expect(pyHttp).toMatch(/Bearer/);

    // All 3 SDKs reference driftstack-sdk-* user agent.
    expect(tsHttp).toMatch(/driftstack-sdk-typescript/);
    expect(go).toMatch(/driftstack-sdk-go/);
    expect(pyHttp).toMatch(/driftstack-sdk-python/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-client-defaults-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
