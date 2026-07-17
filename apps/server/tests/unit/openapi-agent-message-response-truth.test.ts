// Public-contract invariant for the agent-message terminal. The route has four
// successful variants and emits bounded evidence on selected 409 conflicts;
// the generated OpenAPI document must expose those executable shapes so SDKs
// never have to guess from an untyped object.

import { describe, expect, it } from 'vitest';
import { generateOpenApiSpec } from '../../src/lib/openapi.js';

type JsonObject = Record<string, unknown>;

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

function refName(value: unknown, label: string): string {
  const ref = object(value, label).$ref;
  expect(typeof ref, `${label} $ref`).toBe('string');
  expect(ref, `${label} component ref`).toMatch(/^#\/components\/schemas\/[A-Za-z0-9_-]+$/);
  return (ref as string).split('/').at(-1) as string;
}

describe('agent-message OpenAPI response truth', () => {
  const spec = generateOpenApiSpec() as unknown as JsonObject;
  const paths = object(spec.paths, 'paths');
  const operation = object(
    object(paths['/v1/agent-sessions/{id}/message'], 'message path').post,
    'message POST',
  );
  const responses = object(operation.responses, 'message responses');
  const schemas = object(object(spec.components, 'components').schemas, 'component schemas');

  it('publishes all four successful variants and optional provider usage', () => {
    const response = object(responses['200'], '200 response');
    expect(response.description).toMatch(/logged-manual/);
    expect(response.description).toMatch(/usage/);

    const media = object(object(response.content, '200 content')['application/json'], '200 JSON');
    expect(refName(media.schema, '200 schema')).toBe('AgentMessageResponse');

    const success = object(schemas.AgentMessageResponse, 'AgentMessageResponse');
    const variants = array(success.oneOf, 'AgentMessageResponse.oneOf').map((variant, index) =>
      object(variant, `success variant ${index.toString()}`),
    );
    const byKind = new Map(
      variants.map((variant, index) => {
        const properties = object(variant.properties, `variant ${index.toString()} properties`);
        const kind = array(object(properties.kind, 'kind schema').enum, 'kind enum');
        expect(kind).toHaveLength(1);
        return [kind[0], { variant, properties }] as const;
      }),
    );
    expect([...byKind.keys()].sort()).toEqual([
      'clarify',
      'logged-manual',
      'plan-executed',
      'refuse',
    ]);

    for (const kind of ['plan-executed', 'clarify', 'refuse'] as const) {
      const branch = byKind.get(kind);
      expect(branch, kind).toBeDefined();
      expect(refName(branch?.properties.usage, `${kind} usage`)).toBe('AgentMessageUsage');
      expect(array(branch?.variant.required, `${kind} required`)).not.toContain('usage');
    }
    const manual = byKind.get('logged-manual');
    expect(manual).toBeDefined();
    expect(manual?.properties).not.toHaveProperty('usage');
    expect(array(manual?.variant.required, 'logged-manual required').sort()).toEqual([
      'kind',
      'session',
    ]);

    const usage = object(schemas.AgentMessageUsage, 'AgentMessageUsage');
    expect(Object.keys(object(usage.properties, 'usage properties')).sort()).toEqual([
      'anthropic_input_tokens',
      'anthropic_output_tokens',
      'cost_usd_cents',
      'decomposer_kind',
      'model',
    ]);
    expect(array(usage.required, 'usage required')).toEqual(['decomposer_kind']);
  });

  it('publishes bounded idempotency, authority, usage and settled-result evidence on 409', () => {
    const response = object(responses['409'], '409 response');
    expect(response.description).toMatch(/control authority changed/);
    expect(response.description).toMatch(/partial results/);
    const media = object(
      object(response.content, '409 content')['application/problem+json'],
      '409 problem JSON',
    );
    expect(refName(media.schema, '409 schema')).toBe('AgentMessageConflictProblem');

    const conflict = object(schemas.AgentMessageConflictProblem, 'AgentMessageConflictProblem');
    const properties = object(conflict.properties, 'conflict properties');
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining([
        'type',
        'title',
        'status',
        'detail',
        'instance',
        'idempotency_status',
        'ai_control_unavailable',
        'phase',
        'tokens_consumed',
        'usage',
        'partial_results',
      ]),
    );
    expect(
      array(object(properties.idempotency_status, 'idempotency status').enum, 'status enum'),
    ).toEqual(['mismatch', 'in_progress']);
    expect(
      array(object(properties.ai_control_unavailable, 'AI authority flag').enum, 'AI flag enum'),
    ).toEqual([true]);
    expect(array(object(properties.phase, 'authority phase').enum, 'phase enum').sort()).toEqual([
      'admission',
      'decompose',
      'execution',
      'finalize',
      'message-publication',
      'observation',
      'plan-publication',
      'readback',
    ]);
    expect(refName(properties.usage, 'conflict usage')).toBe('AgentMessageUsage');
    const partialItems = object(properties.partial_results, 'partial results').items;
    expect(object(partialItems, 'partial result item')).toHaveProperty('oneOf');
    expect(array(conflict.required, 'conflict required').sort()).toEqual([
      'status',
      'title',
      'type',
    ]);
  });
});
