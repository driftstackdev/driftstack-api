import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SessionLoginRequestSchema, SessionLoginResponseSchema } from '@driftstack/api-types';
import { generateOpenApiSpec } from '../../src/lib/openapi.js';

type JsonObject = Record<string, unknown>;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SNAPSHOT = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

function object(value: unknown, label: string): JsonObject {
  expect(value, label).not.toBeNull();
  expect(typeof value, label).toBe('object');
  expect(Array.isArray(value), label).toBe(false);
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), label).toBe(true);
  return value as unknown[];
}

function loginSchema(spec: JsonObject): JsonObject {
  const schemas = object(object(spec.components, 'components').schemas, 'schemas');
  return object(schemas.SessionLoginResponse, 'SessionLoginResponse');
}

function loginRequestSchema(spec: JsonObject): JsonObject {
  const schemas = object(object(spec.components, 'components').schemas, 'schemas');
  return object(schemas.SessionLoginRequest, 'SessionLoginRequest');
}

function expectStrictLoginUnion(schema: JsonObject): void {
  const branches = array(schema.oneOf, 'oneOf').map((value, index) =>
    object(value, `branch ${index.toString()}`),
  );
  expect(branches).toHaveLength(2);
  const byTruncated = new Map(
    branches.map((branch, index) => {
      expect(branch.additionalProperties, `branch ${index.toString()} strict`).toBe(false);
      const properties = object(branch.properties, `branch ${index.toString()} properties`);
      const truncated = array(
        object(properties.credentials_truncated, 'credentials discriminator').enum,
        'credentials enum',
      );
      expect(truncated).toHaveLength(1);
      const duration = object(properties.duration_ms, 'duration_ms');
      expect(duration).toMatchObject({ type: 'integer', minimum: 0, maximum: 600_000 });
      expect(array(branch.required, 'required').sort()).toEqual([
        'credentials_truncated',
        'duration_ms',
        'logged_in',
        'submitted',
      ]);
      return [truncated[0], { branch, properties }] as const;
    }),
  );

  const submitted = byTruncated.get(false);
  expect(submitted).toBeDefined();
  expect(
    array(object(submitted?.properties.submitted, 'submitted=true').enum, 'submitted enum'),
  ).toEqual([true]);
  expect(object(submitted?.properties.logged_in, 'submitted logged_in')).toEqual({
    type: 'boolean',
  });
  expect(submitted?.properties.post_login_url).toEqual({ type: 'string' });

  const truncated = byTruncated.get(true);
  expect(truncated).toBeDefined();
  expect(
    array(object(truncated?.properties.submitted, 'submitted=false').enum, 'submitted enum'),
  ).toEqual([false]);
  expect(
    array(object(truncated?.properties.logged_in, 'logged_in=false').enum, 'logged enum'),
  ).toEqual([false]);
  expect(truncated?.properties).not.toHaveProperty('post_login_url');
}

describe('session login public response truth', () => {
  const live = generateOpenApiSpec() as unknown as JsonObject;
  const frozen = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as JsonObject;

  it('publishes the same strict two-branch union in live and generated OpenAPI', () => {
    expectStrictLoginUnion(loginSchema(live));
    expectStrictLoginUnion(loginSchema(frozen));
    expect(loginSchema(frozen)).toEqual(loginSchema(live));
  });

  it('publishes and enforces the exact harness text and selector input bounds', () => {
    const properties = object(loginRequestSchema(live).properties, 'login request properties');
    for (const field of ['username', 'password']) {
      expect(object(properties[field], field)).toMatchObject({
        type: 'string',
        minLength: 1,
        maxLength: 10_000,
      });
    }
    for (const field of [
      'username_selector',
      'password_selector',
      'submit_selector',
      'success_selector',
    ]) {
      expect(object(properties[field], field)).toMatchObject({
        type: 'string',
        minLength: 1,
        maxLength: 262_144,
      });
    }
    expect(loginRequestSchema(frozen)).toEqual(loginRequestSchema(live));

    const atBoundary = {
      username: 'u'.repeat(10_000),
      password: 'p'.repeat(10_000),
      username_selector: 'u'.repeat(262_144),
      password_selector: 'p'.repeat(262_144),
      submit_selector: 's'.repeat(262_144),
      success_selector: 'c'.repeat(262_144),
    };
    expect(SessionLoginRequestSchema.safeParse(atBoundary).success).toBe(true);

    for (const invalid of [
      { ...atBoundary, username: 'u'.repeat(10_001) },
      { ...atBoundary, password: 'p'.repeat(10_001) },
      { ...atBoundary, username_selector: 'u'.repeat(262_145) },
      { ...atBoundary, password_selector: 'p'.repeat(262_145) },
      { ...atBoundary, submit_selector: 's'.repeat(262_145) },
      { ...atBoundary, success_selector: 'c'.repeat(262_145) },
      { ...atBoundary, success_selector: '' },
    ]) {
      expect(SessionLoginRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('pins the route description and example to safe submission truth', () => {
    const paths = object(live.paths, 'paths');
    const operation = object(
      object(paths['/v1/sessions/{id}/login'], 'login path').post,
      'login POST',
    );
    expect(operation.summary).toMatch(/real direct-driver capability required/);
    const response = object(object(operation.responses, 'responses')['200'], '200 response');
    expect(response.description).toMatch(
      /Requires an explicitly real direct-driver login capability/,
    );
    expect(response.description).toMatch(/currently shipped drivers report non-real capability/);
    expect(response.description).toMatch(/return 503 before session lookup, operation claim/);
    expect(response.description).toMatch(/submitted=true/);
    expect(response.description).toMatch(/safe zero-submit refusal/);
    expect(response.description).toMatch(/duration_ms is capped at 600 seconds/);
    expect(response.description).toMatch(/separate 15 seconds for teardown and result delivery/);
    expect(response.description).toMatch(/not successful browser work/);
    const media = object(object(response.content, 'content')['application/json'], 'JSON media');
    expect(media.example).toEqual({
      submitted: true,
      credentials_truncated: false,
      logged_in: true,
      post_login_url: 'https://example.com/account',
      duration_ms: 12_450,
    });
  });

  it('rejects contradictory, incomplete, over-budget and extra-field outcomes at runtime', () => {
    expect(
      SessionLoginResponseSchema.safeParse({
        submitted: true,
        credentials_truncated: false,
        logged_in: false,
        duration_ms: 600_000,
      }).success,
    ).toBe(true);
    expect(
      SessionLoginResponseSchema.safeParse({
        submitted: false,
        credentials_truncated: true,
        logged_in: false,
        duration_ms: 42,
      }).success,
    ).toBe(true);

    for (const invalid of [
      {
        submitted: true,
        credentials_truncated: true,
        logged_in: false,
        duration_ms: 1,
      },
      {
        submitted: false,
        credentials_truncated: true,
        logged_in: true,
        duration_ms: 1,
      },
      {
        submitted: false,
        credentials_truncated: true,
        logged_in: false,
        post_login_url: 'https://example.test/leak',
        duration_ms: 1,
      },
      {
        submitted: true,
        credentials_truncated: false,
        logged_in: true,
        duration_ms: 600_001,
      },
      {
        submitted: true,
        credentials_truncated: false,
        logged_in: true,
        duration_ms: 1,
        unexpected: true,
      },
    ]) {
      expect(SessionLoginResponseSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
