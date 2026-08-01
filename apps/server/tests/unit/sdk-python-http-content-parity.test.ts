// W585.C — drift guard for packages/sdk-python/src/driftstack/http.py.
// HttpClient + AsyncHttpClient transport contract. Drift here either
// breaks bearer-auth header construction, RFC 7807 problem-mapping,
// or the retry-delegation handoff.
//
//   • Two transport classes: HttpClient (httpx.Client) +
//     AsyncHttpClient (httpx.AsyncClient).
//   • _build_headers: Authorization: Bearer + User-Agent + Accept +
//     conditional Content-Type when has_body.
//   • _problem_from_text: RFC 7807 contract — requires type+title+
//     status; None on parse-fail.
//   • _error_from_response_data: routes by problem-type URI → typed
//     subclass with field decoding (retry_after_seconds + timeout_ms
//     + pending_acceptances + current_sessions + current/limit/
//     record_type).
//   • _decode_or_raise: 2xx → JSON (None on 204) + non-2xx → raise.
//   • USER_AGENT = "driftstack-sdk-python/{version}" pinned.
//   • Retry delegated to with_retry / with_retry_async.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/http.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W585.C packages/sdk-python/src/driftstack/http.py content parity', () => {
  const body = read(LIB);

  it('Module docstring + Bearer-auth-header-injection + RFC-7807-problem-mapping + per-request-timeout + retry-policy-delegation + shared _error_from_response_data single-source framing pinned', () => {
    expect(body).toMatch(/^"""HTTP client wrapper\.\n/);
    expect(body).toMatch(
      /Customers don't construct this directly — they get a :class:`Driftstack`/,
    );
    expect(body).toMatch(/or :class:`AsyncDriftstack`, which wraps an :class:`HttpClient`/);
    expect(body).toMatch(/\* Bearer auth header injection/);
    expect(body).toMatch(
      /\* RFC 7807 problem-json → typed error mapping \(``error_from_response``\)/,
    );
    expect(body).toMatch(/\* Per-request timeout/);
    expect(body).toMatch(/\* Retry policy delegation \(see :mod:`driftstack\.retry`\)/);
    expect(body).toMatch(/Both sync and async variants share the same problem-mapping logic in/);
    expect(body).toMatch(/:func:`_error_from_response_data`, so a future shape change to the/);
    expect(body).toMatch(/server's error envelope updates both paths in one place\./);
  });

  it('Constants + _build_headers: 30s timeout + 8 MiB response cap + versioned User-Agent + Authorization Bearer + Accept + conditional Content-Type', () => {
    expect(body).toMatch(/^DEFAULT_TIMEOUT_S = 30\.0$/m);
    expect(body).toMatch(/^USER_AGENT = f"driftstack-sdk-python\/\{__version__\}"$/m);
    expect(body).toMatch(/^MAX_RESPONSE_BODY_BYTES = 8 \* 1024 \* 1024$/m);
    expect(body).toMatch(/^_RESPONSE_CHUNK_BYTES = 64 \* 1024$/m);
    expect(body).toMatch(
      /^def _build_headers\(\s*\n\s*api_key: str, has_body: bool, effective_account: str \| None = None\s*\n\s*\) -> dict\[str, str\]:\s*\n\s*headers = \{\s*\n\s*"authorization": f"Bearer \{api_key\}",(\s*\n\s*#[^\n]*)*\s*\n\s*\*\*\(\{"x-driftstack-account": effective_account\} if effective_account else \{\}\),\s*\n\s*"user-agent": USER_AGENT,\s*\n\s*"accept": "application\/json",\s*\n\s*\}\s*\n\s*if has_body:\s*\n\s*headers\["content-type"\] = "application\/json"\s*\n\s*return headers/m,
    );
  });

  it('_problem_from_text: RFC 7807 contract — requires type+title+status fields; None on parse-fail / non-dict / missing-required-fields', () => {
    expect(body).toMatch(
      /^def _problem_from_text\(text: str, status: int\) -> dict\[str, Any\] \| None:\s*\n\s*"""Parse a response body as RFC 7807 problem\+json\. Return None on parse fail\."""\s*\n\s*if not text:\s*\n\s*return None\s*\n\s*try:\s*\n\s*parsed = json\.loads\(text\)\s*\n\s*except \(json\.JSONDecodeError, ValueError\):\s*\n\s*return None\s*\n\s*if not isinstance\(parsed, dict\):\s*\n\s*return None\s*\n\s*if "type" not in parsed or "title" not in parsed or "status" not in parsed:\s*\n\s*return None\s*\n\s*return parsed/m,
    );
  });

  it('_error_from_response_data: routes via PROBLEM_TYPE_TO_ERROR + decodes per-subclass fields (retry_after_seconds from header or problem.retry_after_seconds; timeout_ms; pending_acceptances list with document_key+current_version filter; current_sessions; current/limit/record_type)', () => {
    expect(body).toMatch(/^def _error_from_response_data\(/m);
    expect(body).toMatch(/Falls back to :class:`TransportError` when the body isn't a proper/);
    expect(body).toMatch(/problem document — that surfaces as a server contract violation,/);
    expect(body).toMatch(/which is the right diagnostic for "we got a 500 with HTML in it\."/);
    expect(body).toMatch(/error_cls = PROBLEM_TYPE_TO_ERROR\.get\(problem_type, DriftstackError\)/);
    expect(body).toMatch(
      /if error_cls is RateLimitError:\s*\n\s*return RateLimitError\(\s*\n\s*detail,\s*\n\s*retry_after_seconds=retry_after_seconds,/,
    );
    expect(body).toMatch(
      /if error_cls is QuotaExceededError:\s*\n\s*return QuotaExceededError\(\s*\n\s*detail,\s*\n\s*current=_int_or_none\(problem\.get\("current"\)\),\s*\n\s*limit=_int_or_none\(problem\.get\("limit"\)\),\s*\n\s*record_type=str\(problem\["record_type"\]\) if problem\.get\("record_type"\) else None,/,
    );
    expect(body).toMatch(
      /if error_cls is ConcurrencyLimitError:\s*\n\s*return ConcurrencyLimitError\(\s*\n\s*detail,\s*\n\s*current_sessions=_int_or_none\(problem\.get\("current_sessions"\)\),/,
    );
    expect(body).toMatch(
      /if error_cls is SessionTimeoutError:\s*\n\s*return SessionTimeoutError\(\s*\n\s*detail,\s*\n\s*timeout_ms=_int_or_none\(problem\.get\("timeout_ms"\)\),/,
    );
    expect(body).toMatch(/if error_cls is LegalAcceptanceRequiredError:/);
    expect(body).toMatch(/raw = problem\.get\("pending_acceptances"\)/);
    expect(body).toMatch(/pending: list\[dict\[str, str\]\] = \[\]/);
    expect(body).toMatch(
      /isinstance\(entry, dict\)\s*\n\s*and isinstance\(entry\.get\("document_key"\), str\)\s*\n\s*and isinstance\(entry\.get\("current_version"\), str\)/,
    );
    expect(body).toMatch(/_int_or_none/);
  });

  it('Sync HttpClient: constructor (api_key + kwarg-only base_url/timeout_s/retry/client) + base_url rstrip-slash + owns-client flag + close idempotent on injected client + context-manager + request(method/path/params/json_body/retry) routes through with_retry', () => {
    expect(body).toMatch(/^class HttpClient:$/m);
    expect(body).toMatch(
      /"""Thin wrapper around ``httpx\.Client`` for the sync :class:`Driftstack`\."""/,
    );
    expect(body).toMatch(
      /def __init__\(\s*\n\s*self,\s*\n\s*api_key: str,\s*\n\s*\*,\s*\n\s*base_url: str,\s*\n\s*timeout_s: float = DEFAULT_TIMEOUT_S,\s*\n\s*retry: RetryConfig \| None = None,\s*\n\s*client: httpx\.Client \| None = None,\s*\n\s*effective_account: str \| None = None,\s*\n\s*\) -> None:\s*\n\s*self\._api_key = api_key\s*\n\s*self\._effective_account = effective_account\s*\n\s*self\._base_url = base_url\.rstrip\("\/"\)\s*\n\s*self\._retry = retry\s*\n\s*self\._timeout_s = timeout_s\s*\n\s*self\._client = client or httpx\.Client\(timeout=timeout_s\)\s*\n\s*self\._owns_client = client is None/m,
    );
    expect(body).toMatch(
      /def close\(self\) -> None:\s*\n\s*if self\._owns_client:\s*\n\s*self\._client\.close\(\)/,
    );
    expect(body).toMatch(/def __enter__\(self\) -> HttpClient:\s*\n\s*return self/);
    expect(body).toMatch(
      /def request\(\s*\n\s*self,\s*\n\s*method: str,\s*\n\s*path: str,\s*\n\s*\*,\s*\n\s*params: dict\[str, Any\] \| None = None,\s*\n\s*json_body: Any \| None = None,\s*\n\s*retry: RetryConfig \| None = None,\s*\n\s*extra_headers: dict\[str, str\] \| None = None,\s*\n\s*\) -> Any:/,
    );
    expect(body).toMatch(
      /except httpx\.TimeoutException as err:\s*\n\s*raise TransportError\("request timed out", status=0\) from err/,
    );
    expect(body).toMatch(
      /except httpx\.HTTPError as err:\s*\n\s*raise TransportError\(str\(err\), status=0\) from err/,
    );
    expect(body).toMatch(/with self\._client\.stream\(/);
    expect(body).toMatch(/return with_retry\(_do, retry or self\._retry\)/);
  });

  it('Async AsyncHttpClient: mirrored constructor + aclose + __aenter__ + __aexit__ + awaited request that delegates to with_retry_async; both sync+async raise TransportError(status=0) on httpx.TimeoutException/HTTPError', () => {
    expect(body).toMatch(/^class AsyncHttpClient:$/m);
    expect(body).toMatch(/"""Async analogue of :class:`HttpClient`\."""/);
    expect(body).toMatch(/client: httpx\.AsyncClient \| None = None,/);
    expect(body).toMatch(/self\._client = client or httpx\.AsyncClient\(timeout=timeout_s\)/);
    expect(body).toMatch(
      /async def aclose\(self\) -> None:\s*\n\s*if self\._owns_client:\s*\n\s*await self\._client\.aclose\(\)/,
    );
    expect(body).toMatch(/async def __aenter__\(self\) -> AsyncHttpClient:/);
    expect(body).toMatch(/async def __aexit__\(self, \*_excinfo: Any\) -> None:/);
    expect(body).toMatch(/async with self\._client\.stream\(/);
    expect(body).toMatch(/return await with_retry_async\(_do, retry or self\._retry\)/);
  });

  it('sync+async streaming readers reject declared oversize, count decoded chunks into a bounded bytearray, and share a fixed credential-safe TransportError', () => {
    expect(body).toMatch(/def _declares_oversized_body\(response: httpx\.Response\) -> bool:/);
    expect(body).toMatch(/response\.headers\.get\("content-length"\)/);
    expect(body).toMatch(/int\(declared\) > MAX_RESPONSE_BODY_BYTES/);
    // V-723 — both readers now take an absolute wall-clock `deadline` and read
    // through _iter_chunks/_aiter_chunks, which pick the granularity: fixed
    // 64 KiB for ordinary responses, ARRIVAL-granular for a deadline-bounded
    // event stream. That split is load-bearing — buffering 15s heartbeat
    // comments into 64 KiB chunks would defer the deadline check for hours.
    expect(body).toMatch(
      /def _read_bounded_response\(response: httpx\.Response, deadline: float \| None = None\) -> bytes:/,
    );
    expect(body).toMatch(/for chunk in _iter_chunks\(response, deadline\):/);
    expect(body).toMatch(/async for chunk in _aiter_chunks\(response, deadline\):/);
    expect(
      body.match(/return response\.a?iter_bytes\(chunk_size=_RESPONSE_CHUNK_BYTES\)/g),
    ).toHaveLength(2);
    expect(body.match(/return response\.a?iter_bytes\(\)/g)).toHaveLength(2);
    expect(body.match(/if len\(body\) \+ len\(chunk\) > MAX_RESPONSE_BODY_BYTES:/g)).toHaveLength(
      2,
    );
    expect(body).toMatch(/f"response body exceeds \{MAX_RESPONSE_BODY_BYTES\}-byte limit"/);
  });

  it('_decode_or_raise shared: supplied bounded bytes + 2xx 204/no-content → None + JSONDecode/ValueError → TransportError + non-2xx RFC7807 mapping with retry-after', () => {
    expect(body).toMatch(
      /^def _decode_or_raise\(response: httpx\.Response, content: bytes\) -> Any:\s*\n\s*"""2xx → parsed JSON \(or None on 204\)\. Anything else → raise typed error\."""\s*\n\s*if 200 <= response\.status_code < 300:\s*\n\s*if response\.status_code == 204 or not content:\s*\n\s*return None/m,
    );
    expect(body).toMatch(/return json\.loads\(content\)/);
    expect(body).toMatch(
      /except \(json\.JSONDecodeError, ValueError\) as err:\s*\n\s*raise TransportError\(\s*\n\s*"failed to parse JSON response body",\s*\n\s*status=response\.status_code,\s*\n\s*\) from err/,
    );
    expect(body).toMatch(
      /raise _error_from_response_data\(\s*\n\s*status=response\.status_code,\s*\n\s*text=content\.decode\("utf-8", errors="replace"\),\s*\n\s*retry_after_header=response\.headers\.get\("retry-after"\),\s*\n\s*\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
