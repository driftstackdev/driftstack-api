// V-927 — the OpenAPI document dropped length bounds the routes enforce.
//
// Request bodies in `openapi.ts` are hand-written mirrors of schemas that live
// beside their routes (V-926 measured the surface: 33 of 71 published request
// schemas are mirrors, 21 of them named by no test at all). A mirror can agree
// on field names and required-ness — which is what V-926 checks — while quietly
// dropping a bound, and then the document under-specifies a limit the server
// still enforces.
//
// Two were dropped:
//   • `/v1/oauth/token` redirect_uri — `ExchangeCodeBody` caps it at 2048; the
//     document published `format: uri` with no maxLength.
//   • `/v1/status/subscribe` email — `SubscribeBodySchema` caps it at 254 (the
//     RFC 5321 limit); the document published no length on a PUBLIC endpoint.
//
// Neither is dangerous. Both mean a request the document describes as valid
// draws a 400, which is the same class as V-924 and V-926 and the reason to
// close it rather than shrug: a contract that is loose in a way the server is
// not teaches customers to discover limits by hitting them.
//
// Checked from BOTH ends on purpose. Asserting only the spec would pass if
// someone relaxed the route; asserting only the route would pass if the mirror
// drifted again. The pair is the invariant.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

interface SpecShape {
  paths: Record<
    string,
    {
      post?: {
        requestBody?: {
          content: {
            'application/json': {
              schema: { properties?: Record<string, { maxLength?: number }> };
            };
          };
        };
      };
    }
  >;
}

function publishedMaxLength(path: string, field: string): number | undefined {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape;
  const schema = spec.paths[path]?.post?.requestBody?.content['application/json'].schema;
  return schema?.properties?.[field]?.maxLength;
}

interface BoundCase {
  readonly path: string;
  readonly field: string;
  readonly max: number;
  readonly routeFile: string;
  /** Proves the route really declares the bound, not just that the spec does. */
  readonly routePattern: RegExp;
}

const BOUNDS: readonly BoundCase[] = [
  {
    path: '/v1/oauth/token',
    field: 'redirect_uri',
    max: 2048,
    routeFile: 'apps/server/src/routes/oauth.ts',
    routePattern: /redirect_uri: z\.string\(\)\.max\(2048\)\.url\(\)/,
  },
  {
    path: '/v1/status/subscribe',
    field: 'email',
    max: 254,
    routeFile: 'apps/server/src/routes/status-subscribe.ts',
    routePattern: /email: z\.string\(\)\.trim\(\)\.email\([^)]*\)\.max\(254\)/,
  },
];

describe('V-927 a published bound matches the route', () => {
  it('CRITICAL every route named here still declares its bound. The published side is compared against these numbers, so if a route relaxed its cap and nothing said so, the spec arm would keep passing against a limit that no longer exists — this is the half that makes the other half mean something.', () => {
    for (const { routeFile, routePattern, field } of BOUNDS) {
      const src = readFileSync(resolve(REPO_ROOT, routeFile), 'utf8');
      expect(src.length, `${routeFile} was read`).toBeGreaterThan(500);
      expect(src, `${routeFile} declares the ${field} bound`).toMatch(routePattern);
    }
  });

  it('CRITICAL the document publishes the same bound the route enforces. A mirror that agrees on field names and required-ness can still drop a limit, and then the contract describes as valid a request the server refuses — the customer finds the cap by hitting it.', () => {
    const gaps: string[] = [];
    for (const { path, field, max } of BOUNDS) {
      const published = publishedMaxLength(path, field);
      if (published !== max) {
        gaps.push(
          `${path} ${field}: route enforces ${String(max)}, document says ${String(published)}`,
        );
      }
    }
    expect(gaps, 'the document under-specifies these bounds:').toEqual([]);
  });
});
