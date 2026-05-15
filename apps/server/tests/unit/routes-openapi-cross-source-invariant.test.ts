// W1015 — routes/openapi cross-source invariant. Three-hundred-forty-
// first in the drift-guard series. Pins the apps/server/src/routes/
// openapi.ts Scalar API-reference UI + spec endpoint:
//
//   Header — 'Serve the OpenAPI spec at /openapi.json and Scalar UI
//   at /docs'.
//
//   registerOpenApiRoutes 2 endpoints:
//     - GET /openapi.json — returns generateOpenApiSpec() result.
//     - /docs — Scalar fastify-api-reference plugin with
//       routePrefix:/docs + configuration {url:/openapi.json, theme:
//       default, hideClientButton:true}.
//
// stays in lockstep across apps/server/src/routes/openapi.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1015 routes/openapi cross-source invariant', () => {
  it("CRITICAL header — 'Serve the OpenAPI spec at /openapi.json and Scalar UI at /docs'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/openapi.ts'));
    expect(p).toMatch(/\/\/ Serve the OpenAPI spec at \/openapi\.json and Scalar UI at \/docs\./);
  });

  it('CRITICAL GET /openapi.json returns generateOpenApiSpec() result.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/openapi.ts'));
    expect(p).toMatch(/app\.get\('\/openapi\.json', \(\) => generateOpenApiSpec\(\)\);/);
  });

  it("CRITICAL Scalar plugin registered with routePrefix:'/docs' + url:'/openapi.json' + theme:'default' + hideClientButton:true.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/openapi.ts'));
    expect(p).toMatch(/await app\.register\(scalarApiReference, \{/);
    expect(p).toMatch(/routePrefix: '\/docs',/);
    expect(p).toMatch(/url: '\/openapi\.json',/);
    expect(p).toMatch(/theme: 'default',/);
    expect(p).toMatch(/hideClientButton: true,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/routes-openapi-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
