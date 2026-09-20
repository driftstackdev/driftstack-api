// Public-contract invariant for the agent-message terminal. The route has four
// successful variants and emits bounded evidence on selected 409 conflicts;
// the generated OpenAPI document must expose those executable shapes so SDKs
// never have to guess from an untyped object.

import { describe, expect, it } from 'vitest';
import { generateOpenApiSpec } from '../../src/lib/openapi.js';
import { ALL_TURN_NOTICE_REASONS } from '../../src/services/agent-runtime.js';

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

  it('publishes all five successful variants and optional provider usage', () => {
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
      'stopped',
    ]);

    // B2 — a stopped turn carries what RAN, the sentence that says how far it got,
    // and where it was; `ok` can only be false, because the task did not finish.
    const stopped = byKind.get('stopped');
    expect(stopped).toBeDefined();
    expect(array(stopped?.variant.required, 'stopped required').sort()).toEqual([
      'intents',
      'kind',
      'notice',
      'ok',
      'results',
      'session',
      'stopped_during',
    ]);
    expect(array(object(stopped?.properties.ok, 'stopped ok').enum, 'stopped ok enum')).toEqual([
      false,
    ]);
    expect(
      array(object(stopped?.properties.stopped_during, 'stopped_during').enum, 'during').sort(),
    ).toEqual(['answering', 'executing', 'planning', 'reading_page']);

    for (const kind of ['plan-executed', 'clarify', 'refuse', 'stopped'] as const) {
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

  it('publishes every reason a turn can end with, as an OPEN string beside the notice', () => {
    // The route sends `notice_reason` from the runtime's own list. A value the
    // runtime can send and the document does not publish is a branch no
    // generated client can write, so the expected set is DERIVED from the
    // runtime rather than written here.
    const success = object(schemas.AgentMessageResponse, 'AgentMessageResponse');
    const planExecuted = array(success.oneOf, 'AgentMessageResponse.oneOf')
      .map((variant, index) => object(variant, `variant ${index.toString()}`))
      .find(
        (variant) =>
          array(
            object(object(variant.properties, 'properties').kind, 'kind').enum,
            'kind enum',
          )[0] === 'plan-executed',
      );
    expect(planExecuted, 'the plan-executed variant').toBeDefined();
    const properties = object(planExecuted?.properties, 'plan-executed properties');
    const reason = object(properties.notice_reason, 'notice_reason');
    const arms = array(reason.anyOf, 'notice_reason.anyOf').map((a, i) =>
      object(a, `notice_reason arm ${i.toString()}`),
    );
    const enumArm = arms.find((a) => Array.isArray(a.enum));
    expect(enumArm, 'the enum arm naming the known values').toBeDefined();
    expect(array(enumArm?.enum, 'known notice_reason values').sort()).toEqual(
      [...ALL_TURN_NOTICE_REASONS].sort(),
    );
    // OPEN: a bare string arm, so a client generated today parses a turn that
    // ends a way that does not exist yet instead of failing to decode it.
    expect(
      arms.some((a) => a.type === 'string' && a.enum === undefined),
      'a string arm for values newer than this document',
    ).toBe(true);
    // Optional, and never required: a finished turn carries neither half.
    expect(array(planExecuted?.required, 'plan-executed required')).not.toContain('notice_reason');
    expect(array(planExecuted?.required, 'plan-executed required')).not.toContain('notice');
    // The description tells a program what to do, not only what happened.
    expect(reason.description, 'notice_reason description').toMatch(/send "continue"/);
    expect(reason.description, 'notice_reason description').toMatch(/OPEN string/);
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
