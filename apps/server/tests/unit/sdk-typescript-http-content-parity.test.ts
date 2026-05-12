// W423.B — drift guard for packages/sdk-typescript/src/http.ts.
// Thin wrapper over global fetch; injects Authorization, parses RFC
// 7807 into typed DriftstackError, and applies the retry policy on
// every call. Drift here either strips the Authorization header
// (every request 401s), drops the Problem parse (errors surface as
// raw TransportError losing context), or breaks the timeout signal
// (consumer's per-call deadline silently ignored).
//
//   • Framing pinned: fetch wrapper + auth header + problem parse +
//     retry on every call.
//   • DEFAULT_TIMEOUT_MS = 30_000.
//   • request<T>: withRetry wraps an AbortController.abort() timer;
//     2xx -> JSON parse (204/empty -> undefined); non-2xx -> Problem
//     parse -> errorFromProblem with retry-after header.
//   • Defaults: authorization `Bearer ${apiKey}` + user-agent
//     `driftstack-sdk-typescript/0.0.1` + content-type
//     application/json only when body is set.
//   • isProblem: type+title+status type-narrowed.
//   • transportMessage: AbortError → "request timed out";
//     err.message otherwise.

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

  it('Framing pinned: thin fetch wrapper + Authorization injection + RFC 7807 problem parse + retry policy applied to every call', () => {
    expect(body).toMatch(
      /\/\/ HTTP layer — thin wrapper over the global `fetch`\. Injects the\s*\n?\s*\/\/ Authorization header, parses RFC 7807 problem responses into typed\s*\n?\s*\/\/ `DriftstackError` subclasses, and applies the retry policy from\s*\n?\s*\/\/ `\.\/retry\.ts` to every call\./,
    );
  });

  it('imports: Problem (api-types) + errorFromProblem/TransportError (./errors.js) + withRetry/RetryConfig (./retry.js)', () => {
    expect(body).toMatch(/import type \{ Problem \} from '@driftstack\/api-types';/);
    expect(body).toMatch(/import \{ errorFromProblem, TransportError \} from '\.\/errors\.js';/);
    expect(body).toMatch(/import \{ withRetry, type RetryConfig \} from '\.\/retry\.js';/);
  });

  it('HttpClientConfig interface: apiKey + baseUrl + retry + fetch override + timeoutMs', () => {
    expect(body).toMatch(
      /export interface HttpClientConfig \{\s*\n?\s*apiKey: string;\s*\n?\s*baseUrl: string;\s*\n?\s*retry\?: RetryConfig;\s*\n?\s*\/\*\* Override the global `fetch` \(e\.g\. for tests\)\. \*\/\s*\n?\s*fetch\?: typeof fetch;\s*\n?\s*\/\*\* Default per-request timeout \(ms\)\. \*\/\s*\n?\s*timeoutMs\?: number;\s*\n?\s*\}/,
    );
  });

  it('RequestOptions interface: 5-verb union (GET/POST/DELETE/PUT/PATCH) + path + query + body + retry + timeoutMs + headers (with avoid-authorization note)', () => {
    expect(body).toMatch(
      /export interface RequestOptions \{\s*\n?\s*method: 'GET' \| 'POST' \| 'DELETE' \| 'PUT' \| 'PATCH';\s*\n?\s*path: string;\s*\n?\s*query\?: Record<string, string \| number \| undefined>;\s*\n?\s*body\?: unknown;/,
    );
    expect(body).toMatch(
      /\/\*\*\s*\n?\s*\*\s*Extra request headers\. Merged on top of the defaults \(authorization,\s*\n?\s*\*\s*user-agent, content-type\); callers can override but should avoid\s*\n?\s*\*\s*touching `authorization`\.\s*\n?\s*\*\/\s*\n?\s*headers\?: Record<string, string>;/,
    );
  });

  it('DEFAULT_TIMEOUT_MS = 30_000', () => {
    expect(body).toMatch(/const DEFAULT_TIMEOUT_MS = 30_000;/);
  });

  it('HttpClient.request<T>: withRetry wraps AbortController.abort timer; per-request timeoutMs precedence over config over DEFAULT', () => {
    expect(body).toMatch(
      /export class HttpClient \{\s*\n?\s*constructor\(private readonly config: HttpClientConfig\) \{\}/,
    );
    expect(body).toMatch(/async request<T>\(opts: RequestOptions\): Promise<T> \{/);
    expect(body).toMatch(/const fetchImpl = this\.config\.fetch \?\? fetch;/);
    expect(body).toMatch(
      /const timeoutMs = opts\.timeoutMs \?\? this\.config\.timeoutMs \?\? DEFAULT_TIMEOUT_MS;/,
    );
    expect(body).toMatch(/const url = this\.buildUrl\(opts\.path, opts\.query\);/);
    expect(body).toMatch(
      /return withRetry\(async \(\) => \{\s*\n?\s*const controller = new AbortController\(\);\s*\n?\s*const timer = setTimeout\(\(\) => controller\.abort\(\), timeoutMs\);/,
    );
  });

  it('Default headers: authorization Bearer apiKey + user-agent driftstack-sdk-typescript/0.0.1 + content-type JSON only when body !== undefined', () => {
    expect(body).toMatch(
      /headers: \{\s*\n?\s*authorization: `Bearer \$\{this\.config\.apiKey\}`,\s*\n?\s*'user-agent': 'driftstack-sdk-typescript\/0\.0\.1',\s*\n?\s*\.\.\.\(opts\.body !== undefined \? \{ 'content-type': 'application\/json' \} : \{\}\),\s*\n?\s*\.\.\.opts\.headers,\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /\.\.\.\(opts\.body !== undefined \? \{ body: JSON\.stringify\(opts\.body\) \} : \{\}\),/,
    );
    expect(body).toMatch(/signal: controller\.signal,/);
  });

  it('fetch try/catch wraps as TransportError(transportMessage(err), 0, err); 2xx body parse: 204 -> undefined / empty -> undefined / JSON.parse with parse-failure → TransportError', () => {
    expect(body).toMatch(
      /try \{\s*\n?\s*res = await fetchImpl\(url, init\);\s*\n?\s*\} catch \(err\) \{\s*\n?\s*throw new TransportError\(transportMessage\(err\), 0, err\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /if \(res\.ok\) \{\s*\n?\s*if \(res\.status === 204\) return undefined as T;\s*\n?\s*const text = await res\.text\(\);\s*\n?\s*if \(text\.length === 0\) return undefined as T;\s*\n?\s*try \{\s*\n?\s*return JSON\.parse\(text\) as T;\s*\n?\s*\} catch \(err\) \{\s*\n?\s*throw new TransportError\('failed to parse JSON response body', res\.status, err\);\s*\n?\s*\}\s*\n?\s*\}/,
    );
  });

  it('Non-2xx path: parse body as Problem (or TransportError "non-JSON body"); isProblem check (or TransportError "not a Problem"); throw errorFromProblem(problem, retry-after header)', () => {
    expect(body).toMatch(
      /\/\/ Non-2xx — try to parse problem\+json\. If the body isn't a problem\s*\n?\s*\/\/ doc, surface as TransportError with status\./,
    );
    expect(body).toMatch(
      /try \{\s*\n?\s*problem = JSON\.parse\(text\) as Problem;\s*\n?\s*\} catch \{\s*\n?\s*throw new TransportError\(\s*\n?\s*`non-2xx response \(\$\{res\.status\.toString\(\)\}\) with non-JSON body`,\s*\n?\s*res\.status,\s*\n?\s*\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /if \(!isProblem\(problem\)\) \{\s*\n?\s*throw new TransportError\(\s*\n?\s*`non-2xx response \(\$\{res\.status\.toString\(\)\}\) but body is not a Problem`,\s*\n?\s*res\.status,\s*\n?\s*\);\s*\n?\s*\}\s*\n?\s*throw errorFromProblem\(problem, res\.headers\.get\('retry-after'\)\);/,
    );
  });

  it('finally clearTimeout(timer) + retry-policy precedence (per-request retry over config retry)', () => {
    expect(body).toMatch(
      /\} finally \{\s*\n?\s*clearTimeout\(timer\);\s*\n?\s*\}\s*\n?\s*\}, opts\.retry \?\? this\.config\.retry\);/,
    );
  });

  it('buildUrl: new URL(path, baseUrl); searchParams.set per defined query entry; returns toString()', () => {
    expect(body).toMatch(
      /private buildUrl\(path: string, query\?: Record<string, string \| number \| undefined>\): string \{\s*\n?\s*const url = new URL\(path, this\.config\.baseUrl\);\s*\n?\s*if \(query\) \{\s*\n?\s*for \(const \[k, v\] of Object\.entries\(query\)\) \{\s*\n?\s*if \(v !== undefined\) url\.searchParams\.set\(k, String\(v\)\);\s*\n?\s*\}\s*\n?\s*\}\s*\n?\s*return url\.toString\(\);\s*\n?\s*\}/,
    );
  });

  it('isProblem type-guard: object + type:string + title:string + status:number', () => {
    expect(body).toMatch(
      /function isProblem\(x: unknown\): x is Problem \{\s*\n?\s*if \(typeof x !== 'object' \|\| x === null\) return false;\s*\n?\s*const r = x as Record<string, unknown>;\s*\n?\s*return typeof r\.type === 'string' && typeof r\.title === 'string' && typeof r\.status === 'number';\s*\n?\s*\}/,
    );
  });

  it('transportMessage: AbortError → "request timed out"; other Errors → err.message; non-Error → "network failure"', () => {
    expect(body).toMatch(
      /function transportMessage\(err: unknown\): string \{\s*\n?\s*if \(err instanceof Error\) \{\s*\n?\s*if \(err\.name === 'AbortError'\) return 'request timed out';\s*\n?\s*return err\.message;\s*\n?\s*\}\s*\n?\s*return 'network failure';\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
