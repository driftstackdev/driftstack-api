// Verifies the OpenAPI 3.1 spec is valid, served, and contains every
// expected route.

import { afterEach, describe, expect, it } from 'vitest';
import { generateOpenApiSpec, _clearSpecCache } from '../../src/lib/openapi.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
  _clearSpecCache();
});

describe('OpenAPI spec generation', () => {
  it('produces a valid 3.1 document with required fields', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('Driftstack API');
    expect(spec.info.version).toBe('0.0.1');
    expect(spec.servers).toBeDefined();
  });

  it('registers every expected path', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const paths = Object.keys(spec.paths ?? {}).sort();
    expect(paths).toEqual(
      [
        '/health',
        '/v1/admin/accounts/{id}/quota-override',
        '/v1/admin/accounts/{id}/suspend',
        '/v1/admin/accounts/{id}/tier',
        '/v1/admin/accounts/{id}/unsuspend',
        '/v1/admin/accounts/{id}/usage',
        '/v1/admin/api-keys',
        '/v1/admin/audit-log',
        '/v1/admin/overview',
        '/v1/admin/rate-limit-overrides',
        '/v1/admin/sessions',
        '/v1/admin/webhook-deliveries/{id}',
        '/v1/admin/webhook-deliveries/{id}/replay',
        '/v1/admin/webhook-dlq',
        '/v1/admin/webhook-dlq/{id}/requeue',
        '/v1/api-keys',
        '/v1/api-keys/{id}',
        '/v1/sessions',
        '/v1/sessions/{id}',
        '/v1/sessions/{id}/capture',
        '/v1/sessions/{id}/interact',
        '/v1/sessions/{id}/navigate',
        '/v1/sessions/{id}/state',
        '/v1/sessions/{id}/wait',
        '/v1/usage',
      ].sort(),
    );
  });

  it('all admin endpoints carry the "admin" tag (for docs filtering)', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      if (!path.startsWith('/v1/admin/')) continue;
      const ops = methods as Record<string, { tags?: string[] }>;
      for (const [method, op] of Object.entries(ops)) {
        if (!['get', 'post', 'delete', 'put', 'patch'].includes(method)) continue;
        expect(op.tags).toContain('admin');
      }
    }
  });

  it('declares BearerAuth security scheme', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const schemes = spec.components?.securitySchemes;
    expect(schemes?.BearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  it('all v1 routes require BearerAuth', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      if (!path.startsWith('/v1/')) continue;
      const ops = methods as Record<string, { security?: unknown[] }>;
      for (const [method, op] of Object.entries(ops)) {
        if (!['get', 'post', 'delete', 'put', 'patch'].includes(method)) continue;
        expect(
          op.security,
          `${method.toUpperCase()} ${path} should declare BearerAuth security`,
        ).toBeDefined();
      }
    }
  });

  it('component schemas include the major resources', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const names = Object.keys(spec.components?.schemas ?? {});
    expect(names).toContain('Session');
    expect(names).toContain('ApiKey');
    expect(names).toContain('Account');
    expect(names).toContain('Problem');
    expect(names).toContain('UsagePeriodSummary');
  });
});

describe('OpenAPI HTTP routes', () => {
  it('GET /openapi.json is public and returns JSON', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json<Record<string, unknown>>();
    expect(body.openapi).toBe('3.1.0');
  });

  it('GET /docs serves the Scalar UI HTML (after trailing-slash redirect)', async () => {
    fx = await buildTestApp();
    // Scalar mounts at /docs/ — bare /docs returns a 301 to the trailing form.
    const redirect = await fx.app.inject({ method: 'GET', url: '/docs' });
    expect([200, 301]).toContain(redirect.statusCode);

    const final = await fx.app.inject({ method: 'GET', url: '/docs/' });
    expect(final.statusCode).toBe(200);
    expect(final.headers['content-type']).toMatch(/text\/html/);
    expect(final.body).toContain('<html');
  });
});
