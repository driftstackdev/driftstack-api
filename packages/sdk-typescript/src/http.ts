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

export class HttpClient {
  constructor(private readonly config: HttpClientConfig) {}

  async request<T>(opts: RequestOptions): Promise<T> {
    const fetchImpl = this.config.fetch ?? fetch;
    const timeoutMs = opts.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = this.buildUrl(opts.path, opts.query);

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
          if (res.status === 204) return undefined as T;
          const text = await res.text();
          if (text.length === 0) return undefined as T;
          try {
            return JSON.parse(text) as T;
          } catch (err) {
            throw new TransportError('failed to parse JSON response body', res.status, err);
          }
        }

        // Non-2xx — try to parse problem+json. If the body isn't a problem
        // doc, surface as TransportError with status.
        const text = await res.text();
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
    }, opts.retry ?? this.config.retry);
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
