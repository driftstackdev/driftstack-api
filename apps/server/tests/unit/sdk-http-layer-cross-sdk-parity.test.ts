// W821 — cross-SDK HTTP layer parity. One-hundred-forty-seventh in
// the drift-guard series. Pins TS http.ts + Python http.py request-
// layer wrappers. Drift in auth header injection, RFC 7807 error
// mapping, or timeout/retry delegation would silently change cross-
// SDK customer-observable behavior under failure conditions.
//
// Note: Go inlines its HTTP path inside client.go + resource methods
// (no separate http.go), so it's pinned via W819 client constructor
// parity + per-resource parity tests.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/http.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/http.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/client.go');

describe('W821 cross-SDK HTTP layer parity', () => {
  it('both HTTP layer files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
  });

  // ─── Header framing: thin wrapper + 3 responsibilities ────────

  it("CRITICAL TS header framing pinned. The 'thin wrapper over the global fetch. Injects the Authorization header, parses RFC 7807 problem responses into typed DriftstackError subclasses, and applies the retry policy from ./retry.ts to every call' wording is the load-bearing 3-responsibility contract.", () => {
    const p = read(TS);
    expect(p).toMatch(
      /\/\/ HTTP layer — thin wrapper over the global `fetch`\. Injects the\s*\n\/\/ Authorization header, parses RFC 7807 problem responses into typed\s*\n\/\/ `DriftstackError` subclasses, and applies the retry policy from\s*\n\/\/ `\.\/retry\.ts` to every call\./,
    );
  });

  it("CRITICAL Python header framing pinned. The 4-bullet responsibility list (Bearer auth + RFC 7807 problem-json error mapping + per-request timeout + retry policy delegation) matches TS's 3-responsibility contract.", () => {
    const p = read(PY);
    expect(p).toMatch(/\* Bearer auth header injection/);
    expect(p).toMatch(/\* RFC 7807 problem-json → typed error mapping \(``error_from_response``\)/);
    expect(p).toMatch(/\* Per-request timeout/);
    expect(p).toMatch(/\* Retry policy delegation \(see :mod:`driftstack\.retry`\)/);
  });

  it("CRITICAL Python sync+async dual share error-mapping framing pinned. 'Both sync and async variants share the same problem-mapping logic in _error_from_response_data, so a future shape change to the server's error envelope updates both paths in one place'.", () => {
    expect(read(PY)).toMatch(
      /Both sync and async variants share the same problem-mapping logic in\s*\n:func:`_error_from_response_data`, so a future shape change to the\s*\nserver's error envelope updates both paths in one place\./,
    );
  });

  // ─── 30-second default timeout ────────────────────────────────

  it('CRITICAL both SDKs declare a 30-second default request timeout. TS: DEFAULT_TIMEOUT_MS = 30_000; Python: DEFAULT_TIMEOUT_S = 30.0. Matches W819 client-constructor parity (DEFAULT_TIMEOUT = 30s cross-SDK).', () => {
    expect(read(TS)).toMatch(/const DEFAULT_TIMEOUT_MS = 30_000;/);
    expect(read(PY)).toMatch(/^DEFAULT_TIMEOUT_S = 30\.0$/m);
  });

  it('CRITICAL all three SDKs cap decoded API responses at 8 MiB before JSON parsing; TS/Python stream and cancel/close on overflow while Go reads one byte past the ceiling to detect truncation', () => {
    expect(read(TS)).toMatch(/const MAX_RESPONSE_BODY_BYTES = 8 \* 1024 \* 1024;/);
    expect(read(TS)).toMatch(/bytesRead \+= value\.byteLength;/);
    expect(read(PY)).toMatch(/^MAX_RESPONSE_BODY_BYTES = 8 \* 1024 \* 1024$/m);
    expect(read(PY)).toMatch(/response\.iter_bytes\(chunk_size=_RESPONSE_CHUNK_BYTES\)/);
    expect(read(PY)).toMatch(/response\.aiter_bytes\(chunk_size=_RESPONSE_CHUNK_BYTES\)/);
    expect(read(GO)).toMatch(/const maxBodyBytes = 8 \* 1024 \* 1024/);
    expect(read(GO)).toMatch(/io\.LimitReader\(resp\.Body, maxBodyBytes\+1\)/);
  });

  // ─── Bearer Authorization header ──────────────────────────────

  it("CRITICAL both SDKs inject 'authorization: Bearer <apiKey>' on every request. The Bearer-token scheme is RFC 6750 — drift to a different scheme (Basic, custom-header) would break every customer immediately.", () => {
    expect(read(TS)).toMatch(/authorization: `Bearer \$\{this\.config\.apiKey\}`,/);
    expect(read(PY)).toMatch(/"authorization": f"Bearer \{api_key\}"/);
  });

  // ─── User-agent header ────────────────────────────────────────

  it("CRITICAL both SDKs send a 'driftstack-sdk-{lang}/{version}' user-agent header. TS: 'driftstack-sdk-typescript/0.0.1' (gated on !isBrowserContext per 1f3a927b — Tauri WebKit's forbidden-header rule trips CORS preflight if JS sets it; node + non-browser callers still send it). Python: f'driftstack-sdk-python/{__version__}' dynamic from _version.py. Drift to dropping the user-agent on the node path would break server-side per-SDK telemetry.", () => {
    // 1f3a927b — TS skip user-agent in browser context (Tauri WKWebView
    // adds JS-set UA to CORS preflight which server doesn't allow).
    // Pin BOTH the literal header value AND the browser-context gate
    // so a refactor can't silently drop either half.
    expect(read(TS)).toMatch(/'user-agent': 'driftstack-sdk-typescript\/0\.0\.1'/);
    expect(read(TS)).toMatch(/isBrowserContext/);
    expect(read(PY)).toMatch(/^USER_AGENT = f"driftstack-sdk-python\/\{__version__\}"$/m);
    expect(read(PY)).toMatch(/"user-agent": USER_AGENT,/);
  });

  // ─── content-type only when body present ──────────────────────

  it("CRITICAL both SDKs send 'content-type: application/json' ONLY when body is present (conditional). TS uses spread + ternary; Python uses if has_body. Drift to always-sending content-type would let some servers reject GETs with content-type set.", () => {
    expect(read(TS)).toMatch(
      /\.\.\.\(opts\.body !== undefined \? \{ 'content-type': 'application\/json' \} : \{\}\),/,
    );
    expect(read(PY)).toMatch(/if has_body:\s*\n\s+headers\["content-type"\] = "application\/json"/);
  });

  // ─── Python accept: application/json ──────────────────────────

  it("CRITICAL Python sends 'accept: application/json' header on every request. Drift to dropping accept would let server return a different content-type on Accept-negotiation (rare but real).", () => {
    expect(read(PY)).toMatch(/"accept": "application\/json"/);
  });

  // ─── RFC 7807 problem-json parsing ────────────────────────────

  it("CRITICAL Python _problem_from_text parses RFC 7807 problem+json with JSONDecodeError fallback. The 'Return None on parse fail' framing prevents server-side garbage from crashing customer code.", () => {
    const p = read(PY);
    expect(p).toMatch(
      /def _problem_from_text\(text: str, status: int\) -> dict\[str, Any\] \| None:\s*\n\s+"""Parse a response body as RFC 7807 problem\+json\. Return None on parse fail\."""/,
    );
    expect(p).toMatch(/except \(json\.JSONDecodeError, ValueError\):/);
    expect(p).toMatch(/return None/);
  });

  it('CRITICAL TS imports errorFromProblem helper from errors.ts. The single-helper pattern keeps the problem-json → typed-error mapping in one place. Drift to scattering the mapping across resources would re-introduce the bug class W797 exists to defend against.', () => {
    expect(read(TS)).toMatch(
      /import \{ errorFromProblem, TransportError \} from '\.\/errors\.js';/,
    );
  });

  it('CRITICAL Python imports PROBLEM_TYPE_TO_ERROR mapping dict + specialized error classes. The dict-based mapping keeps the problem-type → exception-class lookup table-driven (vs a long if-else chain).', () => {
    const p = read(PY);
    expect(p).toMatch(/PROBLEM_TYPE_TO_ERROR,/);
    expect(p).toMatch(/ConcurrencyLimitError,/);
    expect(p).toMatch(/LegalAcceptanceRequiredError,/);
    expect(p).toMatch(/QuotaExceededError,/);
    expect(p).toMatch(/RateLimitError,/);
    expect(p).toMatch(/SessionTimeoutError,/);
    expect(p).toMatch(/TransportError,/);
  });

  // ─── HttpClientConfig + RequestOptions shape (TS) ─────────────

  it('CRITICAL TS HttpClientConfig interface pinned — apiKey + baseUrl + retry + fetch (test override) + timeoutMs. The 5-field config is what gets piped down from Driftstack constructor (W819).', () => {
    const p = read(TS);
    expect(p).toMatch(/export interface HttpClientConfig \{/);
    expect(p).toMatch(/apiKey: string;/);
    expect(p).toMatch(/baseUrl: string;/);
    expect(p).toMatch(/retry\?: RetryConfig;/);
    expect(p).toMatch(/\/\*\* Override the global `fetch` \(e\.g\. for tests\)\. \*\//);
    expect(p).toMatch(/fetch\?: typeof fetch;/);
    expect(p).toMatch(/timeoutMs\?: number;/);
  });

  it("CRITICAL TS RequestOptions shape pinned — method (5-verb union) + path + query (Record<string, string|number|undefined>) + body (unknown) + retry override + timeoutMs override + headers override. The 5-method union 'GET|POST|DELETE|PUT|PATCH' is what callers stamp out resource methods against.", () => {
    const p = read(TS);
    expect(p).toMatch(/export interface RequestOptions \{/);
    expect(p).toMatch(/method: 'GET' \| 'POST' \| 'DELETE' \| 'PUT' \| 'PATCH';/);
    expect(p).toMatch(/path: string;/);
    expect(p).toMatch(/query\?: Record<string, string \| number \| undefined>;/);
    expect(p).toMatch(/body\?: unknown;/);
    expect(p).toMatch(/headers\?: Record<string, string>;/);
  });

  // ─── AbortController + setTimeout for timeout ─────────────────

  it("CRITICAL TS uses AbortController + setTimeout for the per-request timeout. Drift to using fetch's own AbortSignal.timeout() would make the timeout customer-observable differently (e.g. no clearTimeout on success path, leaked timer references).", () => {
    const p = read(TS);
    expect(p).toMatch(/const controller = new AbortController\(\);/);
    expect(p).toMatch(/const timer = setTimeout\(\(\) => controller\.abort\(\), timeoutMs\);/);
    expect(p).toMatch(/signal: controller\.signal,/);
  });

  // ─── withRetry wrapping ───────────────────────────────────────

  it('CRITICAL TS HttpClient.request wraps the fetch call inside withRetry(...). Drift to retrying outside the request-level (e.g. only in the user-facing resource methods) would lose the policy-as-default contract.', () => {
    const p = read(TS);
    expect(p).toMatch(/return withRetry\(async \(\) => \{/);
  });

  it('CRITICAL Python imports with_retry + with_retry_async from driftstack.retry. The sync + async pair lets both Driftstack + AsyncDriftstack share the same retry-policy contract.', () => {
    expect(read(PY)).toMatch(
      /from driftstack\.retry import RetryConfig, with_retry, with_retry_async/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-http-layer-cross-sdk-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
