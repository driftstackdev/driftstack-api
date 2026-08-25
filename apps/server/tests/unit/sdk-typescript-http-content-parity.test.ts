// W423.B (W673-deepened) — drift guard for packages/sdk-typescript/
// src/http.ts. Thin HTTP layer over global fetch.
//
// W673 splits the original 14 it() blocks into 22 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • CRITICAL Authorization header injection — `Bearer ${apiKey}`
//     on EVERY request. Drift to dropping would 401 every call;
//     drift to a different scheme (e.g. "Token") would break server
//     auth parsing.
//   • DEFAULT_TIMEOUT_MS = 30_000 + 3-level precedence: per-request
//     > config > DEFAULT.
//   • AbortController.abort() timer — clearTimeout in finally so
//     timeout doesn\'t leak. Drift to not clearing would leave a
//     dangling timer that fires after a fast success.
//   • 5-method HTTP verb union (GET/POST/DELETE/PUT/PATCH) — drift
//     to widening would let HEAD/OPTIONS/TRACE leak through.
//   • Default headers — authorization + user-agent + conditional
//     content-type-json-when-body. CRITICAL: content-type only set
//     when body !== undefined (NOT always-set) so GETs don\'t lie
//     about having a JSON body.
//   • 2xx response handling — 204 returns undefined + empty-text
//     returns undefined + JSON.parse with TransportError fallback.
//   • Non-2xx response handling — try-parse as Problem; if not
//     parseable OR isProblem fails, throw TransportError; else
//     throw errorFromProblem(problem, retry-after header).
//   • retry-after header passthrough — exactly `res.headers.get(
//     "retry-after")`. Drift to manually parsing here would force
//     errorFromProblem to be aware of headers (defeating the
//     separation).
//   • finally clearTimeout — runs on success AND error paths.
//   • Per-request retry override — `opts.retry ?? this.config.retry`
//     defers per-call.
//   • isProblem type-guard — exact 3-field check (type:string +
//     title:string + status:number).
//   • transportMessage AbortError → "request timed out" translation.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/http.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W423.B packages/sdk-typescript/src/http.ts content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module framing pinned (thin fetch wrapper + Authorization injection + RFC 7807 problem parse + retry policy on every call)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(
      /\/\/ HTTP layer — thin wrapper over the global `fetch`\. Injects the\s*\/\/ Authorization header, parses RFC 7807 problem responses into typed\s*\/\/ `DriftstackError` subclasses, and applies the retry policy from\s*\/\/ `\.\/retry\.ts` to every call\./,
    );
  });

  it('Imports — Problem (api-types) + errorFromProblem/TransportError (./errors.js) + withRetry/RetryConfig (./retry.js). CRITICAL: the 3 imports represent the 3 cross-module dependencies (api-types for the wire shape, errors for typed parsing, retry for the wrapper).', () => {
    expect(body).toMatch(/import type \{ Problem \} from '@driftstack\/api-types';/);
    expect(body).toMatch(/import \{ errorFromProblem, TransportError \} from '\.\/errors\.js';/);
    expect(body).toMatch(/import \{ withRetry, type RetryConfig \} from '\.\/retry\.js';/);
  });

  it('HttpClientConfig interface — 6-field shape (apiKey/baseUrl required + retry/fetch/timeoutMs/effectiveAccount optional). fetch test-seam JSDoc + the V-326c effectiveAccount workspace JSDoc pinned.', () => {
    expect(body).toMatch(/export interface HttpClientConfig \{/);
    expect(body).toContain('apiKey: string;');
    expect(body).toContain('baseUrl: string;');
    expect(body).toContain('retry?: RetryConfig;');
    expect(body).toContain('/** Override the global `fetch` (e.g. for tests). */');
    expect(body).toContain('fetch?: typeof fetch;');
    expect(body).toContain('/** Default per-request timeout (ms). */');
    expect(body).toContain('timeoutMs?: number;');
    expect(body).toContain('effectiveAccount?: string;');
    expect(body).toMatch(/V-326c\/V-330 team workspaces/);
  });

  it('CRITICAL RequestOptions method union — 5-verb closed set (GET/POST/DELETE/PUT/PATCH). Drift to widening (HEAD/OPTIONS/TRACE/CONNECT) would let unintended verbs leak into the SDK surface. Drift to `string` type would lose static-checking on verbs.', () => {
    expect(body).toMatch(
      /export interface RequestOptions \{\s*method: 'GET' \| 'POST' \| 'DELETE' \| 'PUT' \| 'PATCH';\s*path: string;\s*query\?: Record<string, string \| number \| undefined>;\s*body\?: unknown;/,
    );
  });

  it('RequestOptions headers JSDoc — pinned per-line: 3 default headers (authorization + user-agent + content-type) + "callers can override but should avoid touching `authorization`". The avoid-authorization advisory is load-bearing — drift to dropping would let customers override the Bearer header (breaking auth).', () => {
    expect(body).toMatch(
      /\/\*\*\s*\*\s*Extra request headers\. Merged on top of the defaults \(authorization,\s*\*\s*user-agent, content-type\); callers can override but should avoid\s*\*\s*touching `authorization`\.\s*\*\/\s*headers\?: Record<string, string>;/,
    );
  });

  it('CRITICAL DEFAULT_TIMEOUT_MS = 30_000 (numeric separator). Drift to a shorter default would make sessions.capture() time out on heavy screenshots; drift to a longer default would let stuck flows wait minutes.', () => {
    expect(body).toMatch(/const DEFAULT_TIMEOUT_MS = 30_000;/);
  });

  it('HttpClient class declaration + private-readonly config constructor field. async request<T> generic method signature. Drift to non-generic would force callers to type-assert the response.', () => {
    expect(body).toMatch(
      /export class HttpClient \{\s*constructor\(private readonly config: HttpClientConfig\) \{\}/,
    );
    expect(body).toMatch(/async request<T>\(opts: RequestOptions\): Promise<T> \{/);
  });

  it('CRITICAL fetch + timeout + URL setup — (1) `fetchImpl = this.config.fetch ?? fetch`; (2) `timeoutMs = this.resolveTimeoutMs(opts)` which keeps the precedence: explicit per-call opts.timeoutMs wins, else `config.timeoutMs ?? DEFAULT_TIMEOUT_MS`, auto-raised for a body-declared long-running deadline (sweep-3); (3) `url = this.buildUrl(opts.path, opts.query)`. Drift to `||` instead of `??` would let `timeoutMs: 0` fall through to default.', () => {
    expect(body).toMatch(/const fetchImpl = this\.config\.fetch \?\? fetch;/);
    expect(body).toMatch(/const timeoutMs = this\.resolveTimeoutMs\(opts\);/);
    // The precedence + body-raise lives in resolveTimeoutMs.
    expect(body).toMatch(/if \(opts\.timeoutMs !== undefined\) return opts\.timeoutMs;/);
    expect(body).toMatch(/const base = this\.config\.timeoutMs \?\? DEFAULT_TIMEOUT_MS;/);
    expect(body).toMatch(/return Math\.max\(base, bodyTimeoutMs \+ BODY_TIMEOUT_HEADROOM_MS\);/);
    expect(body).toMatch(/const url = this\.buildUrl\(opts\.path, opts\.query\);/);
  });

  it('CRITICAL withRetry-wrapped per-attempt body — opens with AbortController + setTimeout. Drift to creating the controller OUTSIDE withRetry would share ONE timer across retries (cumulative deadline). Drift to dropping the timer would let stuck requests block forever. Drift to using AbortSignal.timeout() (which requires Node 17+) would break older environments.', () => {
    expect(body).toMatch(
      /return withRetry\(async \(\) => \{\s*const controller = new AbortController\(\);\s*const timer = setTimeout\(\(\) => controller\.abort\(\), timeoutMs\);/,
    );
  });

  it('CRITICAL default headers — authorization always set; x-driftstack-account ONLY when effectiveAccount configured; user-agent ONLY in non-browser contexts (forbidden request header in browsers — the 2026-05-20 Tauri WKWebView preflight bug); content-type when body; opts.headers SPREAD LAST so callers can override non-auth defaults.', () => {
    expect(body).toContain('authorization: `Bearer ${this.config.apiKey}`,');
    expect(body).toContain('...(this.config.effectiveAccount !== undefined');
    expect(body).toContain("? { 'x-driftstack-account': this.config.effectiveAccount }");
    expect(body).toContain(
      "...(isBrowserContext ? {} : { 'user-agent': 'driftstack-sdk-typescript/0.0.1' }),",
    );
    expect(body).toContain(
      "...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),",
    );
    expect(body).toContain('...opts.headers,');
  });

  it("CRITICAL body serialization — `...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {})` conditional spread. Drift to always-include would force every request to carry a body (even GETs which shouldn't); drift to dropping the JSON.stringify would let the body be `[object Object]` literal string.", () => {
    expect(body).toMatch(
      /\.\.\.\(opts\.body !== undefined \? \{ body: JSON\.stringify\(opts\.body\) \} : \{\}\),/,
    );
  });

  it('signal hookup — `signal: controller.signal` pinned. This is the load-bearing link between the AbortController + the fetch call. Drift to dropping would let the setTimeout fire but the fetch never abort.', () => {
    expect(body).toMatch(/signal: controller\.signal,/);
  });

  it('CRITICAL fetch error catch — wraps native fetch failure as `TransportError(transportMessage(err), 0, err)`. status=0 because no HTTP response received; cause=err preserves the original Error for debug. Drift to swallowing the error would lose the stack trace; drift to re-throwing raw would break the typed-error contract.', () => {
    expect(body).toMatch(
      /let res: Response;\s*try \{\s*res = await fetchImpl\(url, init\);\s*\} catch \(err\) \{\s*throw new TransportError\(transportMessage\(err\), 0, err\);\s*\}/,
    );
  });

  it('CRITICAL 2xx response handling — 3-branch parse: (1) status===204 cancels any body and returns undefined (No Content); (2) bounded text.length===0 → undefined (empty body); (3) JSON.parse(text) with TransportError fallback. Drift to dropping branch 1 would retain an unread response stream or crash on DELETE responses. Drift to dropping branch 2 would crash on POST 200 with no body.', () => {
    expect(body).toMatch(
      /if \(res\.ok\) \{\s*if \(res\.status === 204\) \{\s*await res\.body\?\.cancel\(\)\.catch\(\(\) => undefined\);\s*return undefined as T;\s*\}\s*const text = await readBoundedResponseText\(res\);\s*if \(text\.length === 0\) return undefined as T;\s*try \{\s*return JSON\.parse\(text\) as T;\s*\} catch \(err\) \{\s*throw new TransportError\('failed to parse JSON response body', res\.status, err\);\s*\}\s*\}/,
    );
  });

  it('CRITICAL every success/error response is raw-byte bounded at the Go-parity 8 MiB ceiling, rejects oversized Content-Length before reading, stream-counts chunk byteLength, cancels on overflow, and emits a fixed TransportError', () => {
    expect(body).toMatch(/const MAX_RESPONSE_BODY_BYTES = 8 \* 1024 \* 1024;/);
    expect(body.match(/await readBoundedResponseText\(res\);/g)).toHaveLength(2);
    expect(body).toMatch(/const declaredLength = response\.headers\.get\('content-length'\);/);
    expect(body).toMatch(/if \(declaredBytes > MAX_RESPONSE_BODY_BYTES\)/);
    expect(body).toMatch(/const reader = response\.body\.getReader\(\);/);
    expect(body).toMatch(/bytesRead \+= value\.byteLength;/);
    expect(body).toMatch(/await reader\.cancel\(\)\.catch\(\(\) => undefined\);/);
    expect(body).toMatch(
      /`response body exceeds \$\{MAX_RESPONSE_BODY_BYTES\.toString\(\)\}-byte limit`/,
    );
  });

  it('Non-2xx parse rationale comment pinned — "Non-2xx — try to parse problem+json. If the body isn\'t a problem doc, surface as TransportError with status." Drift to silently dropping non-Problem bodies would lose the failure context (customer sees a 500 with no body would just get a generic transport error without the status).', () => {
    expect(body).toMatch(
      /\/\/ Non-2xx — try to parse problem\+json\. If the body isn't a problem\s*\/\/ doc, surface as TransportError with status\./,
    );
  });

  it('CRITICAL Non-2xx body JSON.parse — wraps a try-catch around `JSON.parse(text) as Problem`. On parse failure throws TransportError with template-literal message including the status. Drift to dropping the try-catch would let a non-JSON 500 response crash with SyntaxError instead of TransportError.', () => {
    expect(body).toMatch(
      /try \{\s*problem = JSON\.parse\(text\) as Problem;\s*\} catch \{\s*throw new TransportError\(\s*`non-2xx response \(\$\{res\.status\.toString\(\)\}\) with non-JSON body`,\s*res\.status,\s*\);\s*\}/,
    );
  });

  it('CRITICAL isProblem narrowing — guards against malformed JSON that parses but lacks Problem fields. `if (!isProblem(problem)) throw TransportError(...)` then `throw errorFromProblem(problem, res.headers.get("retry-after"))`. The retry-after header passthrough is load-bearing — RateLimitError uses it as a fallback when the body lacks retry_after_seconds.', () => {
    expect(body).toMatch(
      /if \(!isProblem\(problem\)\) \{\s*throw new TransportError\(\s*`non-2xx response \(\$\{res\.status\.toString\(\)\}\) but body is not a Problem`,\s*res\.status,\s*\);\s*\}\s*throw errorFromProblem\(problem, res\.headers\.get\('retry-after'\)\);/,
    );
  });

  it('CRITICAL finally clearTimeout — `} finally { clearTimeout(timer); }` runs on both success AND error paths. Drift to clearing only on success would leave a dangling timer that fires AFTER the request returned an error. Drift to clearing only on error would let the success path leak.', () => {
    expect(body).toMatch(/\} finally \{\s*clearTimeout\(timer\);\s*\}/);
  });

  it("Per-request retry override + retry-SAFETY gate — `const baseRetry = opts.retry ?? this.config.retry` (CRITICAL `??` not `||`, so a deliberately-empty retry config `{}` doesn't fall through to the config retry); then the audit-2026-06-23 gate `isRetrySafe(opts.method, opts.headers) ? baseRetry : { ...baseRetry, maxAttempts: 0 }` forces a SINGLE attempt for a non-idempotent keyless POST (no double-submit on a transient 5xx); the resolved retryConfig is passed as withRetry's 2nd arg. Drift to dropping the gate would let a transient failure double-submit a create; drift to `||` would override per-call disable-retry intent.", () => {
    expect(body).toMatch(/const baseRetry = opts\.retry \?\? this\.config\.retry;/);
    expect(body).toMatch(
      /const retryConfig: RetryConfig \| undefined = isRetrySafe\(opts\.method, opts\.headers\)\s*\? baseRetry\s*: \{ \.\.\.baseRetry, maxAttempts: 0 \};/,
    );
    expect(body).toMatch(/\}, retryConfig\);/);
  });

  it('CRITICAL buildUrl helper — `new URL(this.config.baseUrl + path)` (concat, NOT `new URL(path, base)` which would drop a self-hosted base path prefix; mirrors Python/Go) + query-iteration with `if (v !== undefined) url.searchParams.set(k, String(v))`. The `!== undefined` filter (not falsy check) ensures `query: { limit: 0 }` is sent (drift to `if (v)` would drop limit:0). String(v) coerces numbers to string for URLSearchParams compatibility. Discrete pins (not one chained block regex) per the no-long-chain-regex lesson.', () => {
    expect(body).toMatch(
      /private buildUrl\(path: string, query\?: Record<string, string \| number \| undefined>\): string \{/,
    );
    // Concat — preserves a path-prefixed base URL (the cross-SDK fix).
    expect(body).toMatch(/const url = new URL\(this\.config\.baseUrl \+ path\);/);
    // The `!== undefined` filter (not falsy) so `limit: 0` is still sent.
    expect(body).toMatch(/if \(v !== undefined\) url\.searchParams\.set\(k, String\(v\)\);/);
    expect(body).toMatch(/return url\.toString\(\);/);
  });

  it('CRITICAL isProblem type-guard — `typeof x !== "object" || x === null` early-return + `typeof r.type === "string" && typeof r.title === "string" && typeof r.status === "number"`. Exact 3-field RFC 7807 minimum (type/title/status). Drift to requiring `detail` or `instance` would falsely reject legitimate Problems that omit them.', () => {
    expect(body).toMatch(
      /function isProblem\(x: unknown\): x is Problem \{\s*if \(typeof x !== 'object' \|\| x === null\) return false;\s*const r = x as Record<string, unknown>;\s*return typeof r\.type === 'string' && typeof r\.title === 'string' && typeof r\.status === 'number';\s*\}/,
    );
  });

  it('CRITICAL transportMessage — 3-branch translation: (1) Error with name="AbortError" → "request timed out" (CRITICAL: the AbortController.abort() from the setTimeout produces this); (2) other Error → err.message (preserve original); (3) non-Error throws → "network failure". Drift to dropping the AbortError branch would surface a confusing "The operation was aborted." message instead of the user-friendly "request timed out".', () => {
    expect(body).toMatch(
      /function transportMessage\(err: unknown\): string \{\s*if \(err instanceof Error\) \{\s*if \(err\.name === 'AbortError'\) return 'request timed out';\s*return err\.message;\s*\}\s*return 'network failure';\s*\}/,
    );
  });

  it('SDK user-agent version pin — `driftstack-sdk-typescript/0.0.1`. Drift to a different version string would break server-side metric aggregation that buckets by SDK version. The version MUST stay in sync with package.json.', () => {
    expect(body).toMatch(/'driftstack-sdk-typescript\/0\.0\.1'/);
  });
});
