import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SearchRequestSchema, SearchResponseSchema } from '@driftstack/api-types';
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

function schema(spec: JsonObject, name: string): JsonObject {
  const schemas = object(object(spec.components, 'components').schemas, 'schemas');
  return object(schemas[name], name);
}

function expectStrictSearchUnion(value: JsonObject): void {
  const branches = array(value.oneOf, 'oneOf').map((branch, index) =>
    object(branch, `branch ${index.toString()}`),
  );
  expect(branches).toHaveLength(2);
  const byTruncated = new Map(
    branches.map((branch, index) => {
      expect(branch.additionalProperties, `branch ${index.toString()} strict`).toBe(false);
      const properties = object(branch.properties, `branch ${index.toString()} properties`);
      const discriminator = array(
        object(properties.query_truncated, 'query discriminator').enum,
        'query enum',
      );
      expect(discriminator).toHaveLength(1);
      expect(object(properties.duration_ms, 'duration_ms')).toMatchObject({
        type: 'integer',
        minimum: 0,
        maximum: 600_000,
      });
      expect(array(branch.required, 'required').sort()).toEqual([
        'duration_ms',
        'query_truncated',
        'submitted',
      ]);
      return [discriminator[0], { branch, properties }] as const;
    }),
  );

  const completed = byTruncated.get(false);
  expect(completed).toBeDefined();
  // V-1503 — the published description is quoted rather than allowed for. Both
  // fields read backwards to a caller who only has the type: `submitted: false`
  // looks like a failure when it is the documented answer to `submit: false`, and
  // `results_visible: false` looks like an error when it means the selector never
  // appeared. A deep-equal against `{ type: 'boolean' }` froze exactly the state
  // where that sentence was missing, so the shape it asserts includes it now.
  expect(object(completed?.properties.submitted, 'completed submitted')).toEqual({
    type: 'boolean',
    description:
      'Whether the search was submitted. False is not a failure here — it is what you get when the request asked for `submit: false`.',
  });
  expect(object(completed?.properties.results_visible, 'results_visible')).toEqual({
    type: 'boolean',
    description:
      'Present only when the request supplied `wait_for_results_selector`. False means the selector did not appear before the wait timed out, which is a result rather than an error.',
  });

  const truncated = byTruncated.get(true);
  expect(truncated).toBeDefined();
  expect(
    array(object(truncated?.properties.submitted, 'truncated submitted').enum, 'submitted enum'),
  ).toEqual([false]);
  expect(truncated?.properties).not.toHaveProperty('results_visible');
}

describe('session search public response truth', () => {
  const live = generateOpenApiSpec() as unknown as JsonObject;
  const frozen = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as JsonObject;

  it('publishes the query bound and strict two-branch response in live and frozen OpenAPI', () => {
    const requestProperties = object(
      schema(live, 'SearchRequest').properties,
      'request properties',
    );
    expect(requestProperties.query).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 10_000,
    });
    for (const field of ['search_selector', 'wait_for_results_selector']) {
      expect(object(requestProperties[field], field)).toMatchObject({
        type: 'string',
        minLength: 1,
        maxLength: 262_144,
      });
    }
    expectStrictSearchUnion(schema(live, 'SearchResponse'));
    expectStrictSearchUnion(schema(frozen, 'SearchResponse'));
    expect(schema(frozen, 'SearchRequest')).toEqual(schema(live, 'SearchRequest'));
    expect(schema(frozen, 'SearchResponse')).toEqual(schema(live, 'SearchResponse'));
  });

  it('pins the route description and example to safe zero-submit truth', () => {
    const operation = object(
      object(object(live.paths, 'paths')['/v1/sessions/{id}/search'], 'search path').post,
      'search POST',
    );
    expect(operation.summary).toMatch(/real direct-driver capability required/);
    const response = object(object(operation.responses, 'responses')['200'], '200 response');
    expect(response.description).toMatch(/currently shipped drivers report non-real capability/);
    expect(response.description).toMatch(/return 503 before session lookup, operation claim/);
    expect(response.description).toMatch(/query_truncated=false/);
    expect(response.description).toMatch(/exact safe zero-submit refusal/);
    expect(response.description).toMatch(/duration_ms is capped at 600 seconds/);
    expect(response.description).toMatch(/separate 15 seconds for teardown and result delivery/);
    expect(response.description).toMatch(/not successful browser work/);
    const media = object(object(response.content, 'content')['application/json'], 'JSON media');
    expect(media.example).toEqual({
      submitted: true,
      query_truncated: false,
      results_visible: true,
      duration_ms: 8_420,
    });
  });

  it('rejects overlong queries and malformed outcomes at runtime', () => {
    const atBoundary = {
      query: 'q'.repeat(10_000),
      search_selector: 's'.repeat(262_144),
      wait_for_results_selector: 'w'.repeat(262_144),
    };
    expect(SearchRequestSchema.safeParse(atBoundary).success).toBe(true);
    expect(SearchRequestSchema.safeParse({ query: 'q'.repeat(10_001) }).success).toBe(false);
    expect(
      SearchRequestSchema.safeParse({
        ...atBoundary,
        search_selector: 's'.repeat(262_145),
      }).success,
    ).toBe(false);
    expect(
      SearchRequestSchema.safeParse({
        ...atBoundary,
        wait_for_results_selector: 'w'.repeat(262_145),
      }).success,
    ).toBe(false);

    expect(
      SearchResponseSchema.safeParse({
        submitted: false,
        query_truncated: false,
        results_visible: false,
        duration_ms: 600_000,
      }).success,
    ).toBe(true);
    expect(
      SearchResponseSchema.safeParse({
        submitted: false,
        query_truncated: true,
        duration_ms: 42,
      }).success,
    ).toBe(true);

    for (const invalid of [
      { submitted: true, query_truncated: true, duration_ms: 1 },
      {
        submitted: false,
        query_truncated: true,
        results_visible: false,
        duration_ms: 1,
      },
      {
        submitted: true,
        query_truncated: false,
        results_visible: null,
        duration_ms: 1,
      },
      { submitted: true, query_truncated: false, duration_ms: 600_001 },
      { submitted: true, query_truncated: false, duration_ms: 1, unexpected: true },
      { query_truncated: false, duration_ms: 1 },
    ]) {
      expect(SearchResponseSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
