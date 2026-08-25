// W421.A — drift guard for apps/server/src/routes/openapi.ts.
// Serves /openapi.json + Scalar UI at /docs. Drift here either drops
// the public OpenAPI surface (clients lose the contract) or breaks
// the Scalar registration (docs page 404s).
//
//   • Framing pinned: /openapi.json + /docs Scalar UI.
//   • generateOpenApiSpec imported from lib/openapi.
//   • scalarApiReference plugin from @scalar/fastify-api-reference.
//   • Scalar config pinned: routePrefix '/docs' + url '/openapi.json'
//     + theme 'default' + hideClientButton true.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/openapi.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W421.A apps/server/src/routes/openapi.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: /openapi.json + Scalar UI at /docs', () => {
    expect(body).toMatch(
      /\/\/ Serve the OpenAPI spec at \/openapi\.json and Scalar UI at \/docs\./,
    );
  });

  it('GET /openapi.json: returns generateOpenApiSpec() (arrow-form handler)', () => {
    expect(body).toMatch(/app\.get\('\/openapi\.json', \(\) => generateOpenApiSpec\(\)\);/);
  });

  it("Scalar register: routePrefix '/docs' + url '/openapi.json' + theme 'default' + hideClientButton true", () => {
    expect(body).toMatch(
      /await app\.register\(scalarApiReference, \{\s*routePrefix: '\/docs',\s*configuration: \{\s*url: '\/openapi\.json',\s*theme: 'default',\s*hideClientButton: true,\s*\},\s*\}\);/,
    );
  });

  it('registerOpenApiRoutes: async function (Promise<void>); scalar register is awaited', () => {
    expect(body).toMatch(
      /export async function registerOpenApiRoutes\(app: FastifyInstance\): Promise<void> \{/,
    );
  });

  it('imports: FastifyInstance type + scalarApiReference (default import) + generateOpenApiSpec from lib/openapi', () => {
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
    expect(body).toMatch(/import scalarApiReference from '@scalar\/fastify-api-reference';/);
    expect(body).toMatch(/import \{ generateOpenApiSpec \} from '\.\.\/lib\/openapi\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
