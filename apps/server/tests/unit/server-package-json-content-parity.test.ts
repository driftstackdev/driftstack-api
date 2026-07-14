// W530.A — drift guard for apps/server/package.json.
// Control-plane server manifest. Pins identity + build pipeline +
// load-bearing dep set. Drift here either drops Fastify (would break
// the entire control plane) or drops drizzle-orm (would break every
// database call) or changes the typecheck script (would break CI).
//
//   • Name: @driftstack/server (monorepo-scoped server identity).
//   • main: dist/index.js (compiled entry).
//   • private: true + type: module.
//   • 7 scripts: build (tsc --build) + dev (tsx watch) + start
//     (node dist) + test (server-local Vitest config) + test:e2e (playwright) +
//     typecheck (tsc --build && tsc --noEmit on tsconfig.test.json) +
//     db:migrate + db:seed.
//   • Critical runtime deps: fastify + fastify-plugin + 4 @fastify/*
//     + drizzle-orm + postgres + zod + pino (structured logging) +
//     ioredis + @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner +
//     @sentry/node + scrypt-kdf + postmark + @driftstack/api-types +
//     @scalar/fastify-api-reference + @asteasolutions/zod-to-openapi.
//   • Critical devDeps: playwright + drizzle-kit + ajv + ajv-formats +
//     @driftstack/sdk. HTTP integration uses Fastify injection; unused
//     Supertest is deliberately absent to keep its transitive tree out.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/package.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W530.A apps/server/package.json content parity', () => {
  const body = read(LIB);
  const pkg = JSON.parse(body) as {
    name: string;
    private: boolean;
    type: string;
    main: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it("Package identity framing pinned: 'name: @driftstack/server' + 'private: true' + 'type: module' + 'main: dist/index.js' — pinned so the monorepo-scoped name + never-publish-to-npm + ESM + compiled-dist-entry commitment survives (drift to main:src/index.ts would break tsx-free production startup; drift to private:false would risk publishing the server to npm)", () => {
    expect(pkg.name).toBe('@driftstack/server');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBe('dist/index.js');
  });

  it("7-script build pipeline framing pinned: 'build: tsc --build' (project-references aware) + 'dev: tsx watch src/index.ts' (hot-reload via tsx) + 'start: node dist/index.js' (prod startup from pre-compiled dist) + 'test: vitest run --config vitest.config.ts' (server-only, file-filter-compatible) + 'test:e2e: playwright test --config=playwright.config.ts' + 'typecheck: tsc --build && tsc --noEmit -p tsconfig.test.json' (typecheck src first via project-references then tests separately) + 'db:migrate: tsx src/db/migrate.ts' + 'db:seed: tsx src/db/seed.ts' — pinned so the 7-script pipeline commitment survives (drift to bare vitest would run the whole monorepo; drift to single-tsc typecheck would skip the test suite)", () => {
    expect(pkg.scripts.build).toBe('tsc --build');
    expect(pkg.scripts.dev).toBe('tsx watch src/index.ts');
    expect(pkg.scripts.start).toBe('node dist/index.js');
    expect(pkg.scripts.test).toBe('vitest run --config vitest.config.ts');
    expect(pkg.scripts['test:e2e']).toBe('playwright test --config=playwright.config.ts');
    expect(pkg.scripts.typecheck).toBe('tsc --build && tsc --noEmit -p tsconfig.test.json');
    expect(pkg.scripts['db:migrate']).toBe('tsx src/db/migrate.ts');
    expect(pkg.scripts['db:seed']).toBe('tsx src/db/seed.ts');
  });

  it("Fastify + plugin stack framing pinned: 'fastify' + 'fastify-plugin' + '@fastify/cors' + '@fastify/helmet' + '@fastify/swagger' + '@fastify/swagger-ui' + '@scalar/fastify-api-reference' (Scalar API ref alternative to swagger-ui) + '@asteasolutions/zod-to-openapi' — pinned so the Fastify v5 + plugin-decoration + CORS + Helmet + dual-API-docs (Swagger + Scalar) + Zod-to-OpenAPI commitment survives (drift to dropping fastify-plugin would break every plugin's decoration wiring)", () => {
    expect(pkg.dependencies).toHaveProperty('fastify');
    expect(pkg.dependencies).toHaveProperty('fastify-plugin');
    expect(pkg.dependencies).toHaveProperty('@fastify/cors');
    expect(pkg.dependencies).toHaveProperty('@fastify/helmet');
    expect(pkg.dependencies).toHaveProperty('@fastify/swagger');
    expect(pkg.dependencies).toHaveProperty('@fastify/swagger-ui');
    expect(pkg.dependencies).toHaveProperty('@scalar/fastify-api-reference');
    expect(pkg.dependencies).toHaveProperty('@asteasolutions/zod-to-openapi');
    // V-820 — @fastify/websocket backs the /v1/fleet/events control-plane WS.
    expect(pkg.dependencies).toHaveProperty('@fastify/websocket');
  });

  it("Data + infra deps framing pinned: 'drizzle-orm' + 'postgres' (Postgres driver) + 'ioredis' (Redis client) + '@aws-sdk/client-s3' + '@aws-sdk/s3-request-presigner' (presigned URL TTL) + 'zod' (runtime schema validation) + 'pino' (structured logging) — pinned so the data-layer (Drizzle + postgres-driver + ioredis) + S3 SDK + zod-runtime-validation + pino-structured-logging commitment survives (drift to a different postgres driver or to console.log would break observability)", () => {
    expect(pkg.dependencies).toHaveProperty('drizzle-orm');
    expect(pkg.dependencies).toHaveProperty('postgres');
    expect(pkg.dependencies).toHaveProperty('ioredis');
    expect(pkg.dependencies).toHaveProperty('@aws-sdk/client-s3');
    expect(pkg.dependencies).toHaveProperty('@aws-sdk/s3-request-presigner');
    expect(pkg.dependencies).toHaveProperty('zod');
    expect(pkg.dependencies).toHaveProperty('pino');
  });

  it("Cross-cutting deps framing pinned: '@sentry/node' (V-469 prod error telemetry) + 'scrypt-kdf' (API key hashing via scrypt logN=15) + 'postmark' (outbound email transport per #171) + '@driftstack/api-types' (cross-app shared types) — pinned so the Sentry + scrypt + Postmark + api-types commitment survives (drift to dropping any of these silently breaks a load-bearing prod feature — Sentry telemetry, key hashing, email delivery, or cross-app type safety)", () => {
    expect(pkg.dependencies).toHaveProperty('@sentry/node');
    expect(pkg.dependencies).toHaveProperty('scrypt-kdf');
    expect(pkg.dependencies).toHaveProperty('postmark');
    expect(pkg.dependencies).toHaveProperty('@driftstack/api-types');
  });

  it('devDeps framing pinned: Playwright + AJV + drizzle-kit + SDK loop-back; unused Supertest tree remains absent', () => {
    expect(pkg.devDependencies).toHaveProperty('@playwright/test');
    expect(pkg.devDependencies).not.toHaveProperty('supertest');
    expect(pkg.devDependencies).not.toHaveProperty('@types/supertest');
    expect(pkg.devDependencies).toHaveProperty('ajv');
    expect(pkg.devDependencies).toHaveProperty('ajv-formats');
    expect(pkg.devDependencies).toHaveProperty('drizzle-kit');
    expect(pkg.devDependencies).toHaveProperty('@driftstack/sdk');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
