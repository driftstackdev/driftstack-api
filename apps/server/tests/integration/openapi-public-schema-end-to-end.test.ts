// End-to-end integration test: GET /openapi.json is public + valid
// OpenAPI 3.x JSON. Drift would either gate the spec behind auth
// (breaking third-party tool integration) or break the spec shape
// (breaking SDK generators that depend on it).

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('GET /openapi.json public + valid OpenAPI shape end-to-end', () => {
  it('GET /openapi.json without auth → 200 + application/json', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('Response body is valid JSON + has OpenAPI 3.x root shape', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({ method: 'GET', url: '/openapi.json' });
    const body = res.json<{
      openapi?: string;
      info?: { title?: string; version?: string };
      paths?: Record<string, unknown>;
    }>();
    expect(body.openapi).toBeDefined();
    expect(body.openapi).toMatch(/^3\./);
    expect(body.info).toBeDefined();
    expect(body.info?.title).toBeDefined();
    expect(body.paths).toBeDefined();
    expect(Object.keys(body.paths ?? {}).length).toBeGreaterThan(0);
  });

  it('OpenAPI components.schemas includes the canonical Problem schema (RFC 7807)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({ method: 'GET', url: '/openapi.json' });
    const body = res.json<{
      components?: { schemas?: Record<string, unknown> };
    }>();
    expect(body.components?.schemas).toBeDefined();
    expect(Object.keys(body.components?.schemas ?? {})).toContain('Problem');
  });

  it('OpenAPI exposes /v1/sessions path (most-trafficked customer endpoint)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({ method: 'GET', url: '/openapi.json' });
    const body = res.json<{ paths?: Record<string, unknown> }>();
    expect(body.paths?.['/v1/sessions']).toBeDefined();
  });
});
