// Cross-source invariant: every error response uses
// `application/problem+json` per RFC 7807. The middleware error-
// handler sets the content-type once; the openapi.ts spec
// documents it for every error response schema. Drift on the
// content-type would either break SDK clients that branch on the
// problem+json mime type, or have the OpenAPI spec misrepresent
// what the server actually emits.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const HANDLER = resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts');
const OPENAPI = resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('problem+json content-type cross-source invariant', () => {
  const handler = read(HANDLER);
  const openapi = read(OPENAPI);

  it("middleware/error-handler header documents 'Sets Content-Type: application/problem+json on every response' + RFC 7807 framing", () => {
    expect(handler).toMatch(
      /\/\/ Sets `Content-Type: application\/problem\+json` on every response\./,
    );
    expect(handler).toMatch(/RFC 7807/);
  });

  it('middleware/error-handler actually emits content-type: application/problem+json; charset=utf-8 on the reply', () => {
    expect(handler).toMatch(
      /\.header\('content-type', 'application\/problem\+json; charset=utf-8'\)/,
    );
  });

  it("openapi spec references 'application/problem+json' for the Problem schema — pinned so the OpenAPI-published mime type matches what error-handler actually emits", () => {
    expect(openapi).toMatch(
      /'application\/problem\+json': \{ schema: \{ \$ref: '#\/components\/schemas\/Problem' \} \}/,
    );
  });

  it("404-not-found handler ALSO uses problem+json (every miss is problem+json) + references the canonical errors.driftstack.dev/not-found problem-type — pinned so 404 misses don't fall through to a non-problem+json default", () => {
    expect(handler).toMatch(
      /Replace the default 404 handler so every miss is also problem\+json\./,
    );
    // The URI moved behind PROBLEM_TYPES so a typo in it cannot compile —
    // `Problem.type` is `z.string().url()`, not the closed `ProblemType` union,
    // so this call site was the one building an envelope from an unchecked
    // literal. The claim splits: the handler uses the constant, and the constant
    // still holds the canonical URI.
    expect(handler).toMatch(/type: PROBLEM_TYPES\.NotFound,/);
    expect(PROBLEM_TYPES.NotFound).toBe('https://errors.driftstack.dev/not-found');
  });
});
