// Cross-package zod single-instance invariant (2026-06-03).
//
// Why this guard exists: 30 routes call `Schema.parse(req.body/query/params)`,
// which THROWS a ZodError on bad input (vs the 73 routes that `.safeParse()` +
// handle it explicitly). `middleware/error-handler.ts` maps a thrown ZodError
// to a 400 via `err instanceof ZodError`. MANY of those `.parse()` calls use
// CROSS-PACKAGE schemas from @driftstack/api-types (CreateApiKeyRequestSchema,
// CreateSessionRequestSchema, CreateWebhookRequestSchema, ChangeTierRequest, …).
//
// `instanceof` is identity-bound to a specific class object. If apps/server and
// packages/api-types ever resolved DIFFERENT zod instances (divergent version
// ranges → npm installs two copies instead of hoisting one), a ZodError thrown
// by an api-types schema would NOT be `instanceof` the server's ZodError → the
// error-handler would miss it and fall through to InternalError 500. Bad input
// on those 30 routes would silently regress from 400 to 500 — and the
// safeParse routes wouldn't share the bug, so it'd be a confusing partial
// regression. Today both packages declare the SAME range so npm hoists ONE zod.
//
// dependabot's "locked-stack" group (drizzle/fastify/ioredis/postgres) does NOT
// include zod, so a per-package zod bump is a plausible way to introduce the
// divergence. This guard forces the two ranges to stay identical (a coordinated
// bump) and pins the error-handler line whose correctness depends on it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function zodRange(pkgPath: string): string | undefined {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, pkgPath), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return pkg.dependencies?.zod ?? pkg.devDependencies?.zod;
}

describe('cross-package zod single-instance invariant', () => {
  const serverZod = zodRange('apps/server/package.json');
  const apiTypesZod = zodRange('packages/api-types/package.json');

  it('apps/server and packages/api-types declare the SAME zod range (single hoisted instance → cross-package `instanceof ZodError` holds → bad input → 400, not 500)', () => {
    expect(serverZod, 'apps/server must declare a zod dependency').toBeDefined();
    expect(apiTypesZod, 'packages/api-types must declare a zod dependency').toBeDefined();
    expect(
      serverZod,
      `zod version drift between apps/server (${serverZod}) and packages/api-types (${apiTypesZod}) ` +
        'risks splitting into two zod instances → a ZodError from an api-types Schema.parse() would ' +
        'not be `instanceof` the error-handler ZodError → 500 instead of 400. Bump both together.',
    ).toBe(apiTypesZod);
  });

  it('error-handler maps a thrown ZodError → ValidationError via `instanceof ZodError` (the path this single-instance guard protects)', () => {
    const handler = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts'),
      'utf8',
    );
    expect(handler).toMatch(/err instanceof ZodError/);
  });
});
