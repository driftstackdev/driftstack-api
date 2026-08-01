// HTTP layer — thin wrapper over the global `fetch`. Injects the
// Authorization header, parses RFC 7807 problem responses into typed
// `DriftstackError` subclasses, and applies the retry policy from
// `./retry.ts` to every call.

import type { Problem } from '@driftstack/api-types';
import { errorFromProblem, TransportError } from './errors.js';
import { withRetry, type RetryConfig } from './retry.js';

export interface HttpClientConfig {
  apiKey: string;
  baseUrl: string;
  retry?: RetryConfig;
  /** Override the global `fetch` (e.g. for tests). */
  fetch?: typeof fetch;
  /** Default per-request timeout (ms). */
  timeoutMs?: number;
  /**
   * V-326c/V-330 team workspaces — when set, every request carries
   * `X-Driftstack-Account: <owner account id>` so reads resolve against
   * that owner's workspace (writes additionally require the admin role,
   * enforced server-side). Format `acc_<uuid>` or the bare uuid, exactly
   * as the server's effective-account header parser accepts.
   */
  effectiveAccount?: string;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Per-request retry override. */
  retry?: RetryConfig;
  /** Per-request timeout override (ms). */
  timeoutMs?: number;
  /**
   * Extra request headers. Merged on top of the defaults (authorization,
   * user-agent, content-type); callers can override but should avoid
   * touching `authorization`.
   */
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
// Matches the Go SDK's response ceiling. API JSON and RFC 7807 bodies are
// normally tiny; this leaves generous headroom for list responses while
// preventing a compromised server or intermediary from exhausting a client.
const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Headroom added on top of a body-declared operation timeout when deriving the
 * transport timeout, covering network round-trip + the server's own scheduling
 * slack so the client never aborts a request the server would still have
 * honoured. Generous on purpose — the transport timeout is a backstop against a
 * truly hung socket, not the operation's deadline (the server enforces that).
 */
const BODY_TIMEOUT_HEADROOM_MS = 15_000;

export class HttpClient {
  constructor(private readonly config: HttpClientConfig) {}

  async request<T>(opts: RequestOptions): Promise<T> {
    const fetchImpl = this.config.fetch ?? fetch;
    const timeoutMs = this.resolveTimeoutMs(opts);
    const url = this.buildUrl(opts.path, opts.query);

    // Retry SAFETY gate. Idempotent methods are always safe to re-attempt;
    // a non-idempotent POST/PATCH is only safe when it carries an
    // Idempotency-Key (the server replays the original response on that
    // key — apps/server billing-crypto — so a retry can't double-submit).
    // Without a key, a transient 5xx / network blip on a create may already
    // have been applied server-side, so retrying would mint a duplicate;
    // force a single attempt instead.
    const baseRetry = opts.retry ?? this.config.retry;
    const retryConfig: RetryConfig | undefined = isRetrySafe(opts.method, opts.headers)
      ? baseRetry
      : { ...baseRetry, maxAttempts: 0 };

    return withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // 2026-05-20 — `user-agent` is a forbidden request header in
        // Fetch-spec browser contexts (the browser/webview sets its own
        // and JS isn't allowed to override). WebKit in Tauri 2.x ADDS
        // any JS-set user-agent to the CORS preflight's
        // Access-Control-Request-Headers list rather than silently
        // dropping it — so if the server's allow-headers doesn't list
        // user-agent, the preflight fails with a generic "Load failed".
        // Only set the header in Node (where it's legal and useful for
        // server-side log triage); skip in any context that exposes
        // `window` (browsers, Tauri WKWebView, Electron renderer, etc.).
        const isBrowserContext = typeof globalThis !== 'undefined' && 'window' in globalThis;
        const init: RequestInit = {
          method: opts.method,
          // The non-browser `user-agent` set below is INTENTIONALLY frozen
          // at 0.0.1 — the stable metric-bucketing marker, deliberately NOT
          // tracking package.json (see W834). Don't "sync" it to the package
          // version; ~5 SDK tests pin the 0.0.1 freeze on purpose.
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            ...(this.config.effectiveAccount !== undefined
              ? { 'x-driftstack-account': this.config.effectiveAccount }
              : {}),
            ...(isBrowserContext ? {} : { 'user-agent': 'driftstack-sdk-typescript/0.0.1' }),
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...opts.headers,
          },
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          signal: controller.signal,
        };

        let res: Response;
        try {
          res = await fetchImpl(url, init);
        } catch (err) {
          throw new TransportError(transportMessage(err), 0, err);
        }

        if (res.ok) {
          if (res.status === 204) {
            await res.body?.cancel().catch(() => undefined);
            return undefined as T;
          }
          const text = await readBoundedResponseText(res);
          if (text.length === 0) return undefined as T;
          try {
            return JSON.parse(text) as T;
          } catch (err) {
            throw new TransportError('failed to parse JSON response body', res.status, err);
          }
        }

        // Non-2xx — try to parse problem+json. If the body isn't a problem
        // doc, surface as TransportError with status.
        const text = await readBoundedResponseText(res);
        let problem: Problem | null = null;
        try {
          problem = JSON.parse(text) as Problem;
        } catch {
          throw new TransportError(
            `non-2xx response (${res.status.toString()}) with non-JSON body`,
            res.status,
          );
        }
        if (!isProblem(problem)) {
          throw new TransportError(
            `non-2xx response (${res.status.toString()}) but body is not a Problem`,
            res.status,
          );
        }
        throw errorFromProblem(problem, res.headers.get('retry-after'));
      } finally {
        clearTimeout(timer);
      }
    }, retryConfig);
  }

  /**
   * Send a request whose successful representation is a bounded SSE stream
   * containing exactly one terminal `event: response` envelope. This is used by
   * long-running agent turns: immediate SSE headers + comments keep proxies alive,
   * while the final envelope preserves the ordinary JSON result / RFC 7807 error
   * contract. Non-idempotent streams are never transparently retried — a dropped
   * connection may have already dispatched browser actions.
   */
  async requestEventStream<T>(opts: RequestOptions): Promise<T> {
    const fetchImpl = this.config.fetch ?? fetch;
    const timeoutMs = this.resolveTimeoutMs(opts);
    const url = this.buildUrl(opts.path, opts.query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const isBrowserContext = typeof globalThis !== 'undefined' && 'window' in globalThis;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: opts.method,
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            ...(this.config.effectiveAccount !== undefined
              ? { 'x-driftstack-account': this.config.effectiveAccount }
              : {}),
            ...(isBrowserContext ? {} : { 'user-agent': 'driftstack-sdk-typescript/0.0.1' }),
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...opts.headers,
            // Stream negotiation cannot be downgraded by resource-supplied
            // headers; the Python and Go clients enforce the same invariant.
            accept: 'text/event-stream',
          },
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          signal: controller.signal,
        });
      } catch (err) {
        throw new TransportError(transportMessage(err), 0, err);
      }

      const text = await readBoundedResponseText(response);
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!response.ok || contentType.split(';', 1)[0]?.trim() !== 'text/event-stream') {
        return decodeJsonResponse<T>(response.status, text, response.headers.get('retry-after'));
      }

      const terminal = parseTerminalSseResponse(text, response.status);
      if (terminal.status >= 200 && terminal.status < 300) return terminal.body as T;
      if (!isProblem(terminal.body)) {
        throw new TransportError(
          `streamed non-2xx response (${terminal.status.toString()}) but body is not a Problem`,
          terminal.status,
        );
      }
      throw errorFromProblem(terminal.body, null);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolve the per-request transport (abort) timeout.
   *
   * Precedence:
   *   1. An explicit per-call `opts.timeoutMs` always wins (caller override).
   *   2. Otherwise, if the request BODY carries a long-running-operation
   *      deadline (`timeout_ms` in ms, or `timeout_seconds` in seconds — the
   *      navigate/wait/login/search contract, up to 120s server-side), the
   *      transport timeout is auto-raised to that deadline + headroom, so a
   *      30s client default never aborts a 90s op the server would honour.
   *   3. Otherwise the configured client `timeoutMs`, else DEFAULT_TIMEOUT_MS.
   *
   * The body-derived timeout only ever RAISES the floor (max with the
   * configured default) — a tiny body timeout never shortens an explicitly
   * configured longer client timeout.
   */
  private resolveTimeoutMs(opts: RequestOptions): number {
    if (opts.timeoutMs !== undefined) return opts.timeoutMs;
    const base = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const bodyTimeoutMs = bodyOperationTimeoutMs(opts.body);
    if (bodyTimeoutMs === undefined) return base;
    return Math.max(base, bodyTimeoutMs + BODY_TIMEOUT_HEADROOM_MS);
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    // Concatenate rather than `new URL(path, baseUrl)`: an absolute-path
    // reference (`/v1/...`) passed as the first arg to `new URL` REPLACES
    // the base's path, silently dropping a path prefix on a self-hosted
    // base URL (e.g. `https://gw.internal/driftstack`). `baseUrl` already
    // has trailing slashes stripped (client.ts) and every `path` starts
    // with `/`, so concatenation mirrors the Python/Go SDKs and preserves
    // the prefix.
    const url = new URL(this.config.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
}

interface TerminalSseResponse {
  status: number;
  body: unknown;
}

function parseTerminalSseResponse(text: string, transportStatus: number): TerminalSseResponse {
  let terminal: TerminalSseResponse | null = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
    }
    if (event !== 'response') continue;
    if (terminal !== null) {
      throw new TransportError(
        'agent turn stream contained multiple terminal responses',
        transportStatus,
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(data.join('\n')) as unknown;
    } catch (err) {
      throw new TransportError('failed to parse terminal agent turn event', transportStatus, err);
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new TransportError('terminal agent turn event was not an object', transportStatus);
    }
    const record = decoded as Record<string, unknown>;
    if (
      typeof record.status !== 'number' ||
      !Number.isInteger(record.status) ||
      record.status < 100 ||
      record.status > 599 ||
      !Object.prototype.hasOwnProperty.call(record, 'body')
    ) {
      throw new TransportError(
        'terminal agent turn event had an invalid response envelope',
        transportStatus,
      );
    }
    terminal = { status: record.status, body: record.body };
  }
  if (terminal === null) {
    throw new TransportError(
      'agent turn stream ended without a terminal response',
      transportStatus,
    );
  }
  return terminal;
}

function decodeJsonResponse<T>(status: number, text: string, retryAfter: string | null): T {
  if (status >= 200 && status < 300) {
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new TransportError('failed to parse JSON response body', status, err);
    }
  }
  let problem: unknown;
  try {
    problem = JSON.parse(text) as unknown;
  } catch {
    throw new TransportError(`non-2xx response (${status.toString()}) with non-JSON body`, status);
  }
  if (!isProblem(problem)) {
    throw new TransportError(
      `non-2xx response (${status.toString()}) but body is not a Problem`,
      status,
    );
  }
  throw errorFromProblem(problem, retryAfter);
}

/**
 * Decode a response through a raw-byte ceiling. The request's AbortController
 * remains armed in the caller until this completes, so a body that stalls
 * after returning headers is still bounded by the request timeout.
 */
async function readBoundedResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
    const declaredBytes = Number(declaredLength);
    if (declaredBytes > MAX_RESPONSE_BODY_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw responseBodyTooLarge(response.status);
    }
  }

  if (response.body === null) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BODY_BYTES) {
        throw responseBodyTooLarge(response.status);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    if (err instanceof TransportError) throw err;
    throw new TransportError(transportMessage(err), response.status, err);
  } finally {
    reader.releaseLock();
  }
}

function responseBodyTooLarge(status: number): TransportError {
  return new TransportError(
    `response body exceeds ${MAX_RESPONSE_BODY_BYTES.toString()}-byte limit`,
    status,
  );
}

/**
 * HTTP methods that are idempotent by RFC 7231 semantics — always safe to
 * auto-retry. POST and PATCH are deliberately excluded; they're only
 * retried when the caller supplies an Idempotency-Key (see `isRetrySafe`).
 */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE']);

/**
 * Whether a request may be transparently retried by the SDK. True for
 * idempotent methods, or for any method carrying a USABLE `Idempotency-Key`
 * header (case-insensitive name, non-blank value). Guards against
 * double-submitting a non-idempotent create on a transient 5xx / network error.
 *
 * The value check is load-bearing, not defensive tidying. The server treats an
 * empty or whitespace-only `Idempotency-Key` as ABSENT — it stores no dedup
 * record and replays nothing (see the server's `readIdempotencyKey`). So a
 * header present with a blank value is the WORST case: it buys no server-side
 * protection while, before this check, it switched retries on. An unset
 * variable reaching the header map as `''` turned a single POST into an
 * auto-retried one that could mint duplicates.
 */
function isRetrySafe(method: string, headers?: Record<string, string>): boolean {
  if (IDEMPOTENT_METHODS.has(method.toUpperCase())) return true;
  if (headers === undefined) return false;
  return Object.entries(headers).some(
    ([k, v]) => k.toLowerCase() === 'idempotency-key' && typeof v === 'string' && v.trim() !== '',
  );
}

/**
 * Extract a long-running-operation deadline from a request body, in
 * milliseconds. Recognises the two server contract fields: `timeout_ms`
 * (already ms — navigate/wait/interact) and `timeout_seconds` (login/search;
 * converted to ms). Returns `undefined` when the body carries neither (or
 * isn't a plain object), so the caller falls back to the configured timeout.
 * A non-finite / non-positive value is ignored (treated as absent).
 */
function bodyOperationTimeoutMs(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const r = body as Record<string, unknown>;
  if (typeof r.timeout_ms === 'number' && Number.isFinite(r.timeout_ms) && r.timeout_ms > 0) {
    return r.timeout_ms;
  }
  if (
    typeof r.timeout_seconds === 'number' &&
    Number.isFinite(r.timeout_seconds) &&
    r.timeout_seconds > 0
  ) {
    return r.timeout_seconds * 1000;
  }
  return undefined;
}

function isProblem(x: unknown): x is Problem {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r.type === 'string' && typeof r.title === 'string' && typeof r.status === 'number';
}

function transportMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'request timed out';
    return err.message;
  }
  return 'network failure';
}
