// No schema in the published spec is nullable by type while excluding null
// from its enum.
//
// OpenAPI 3.1 is JSON Schema 2020-12: `type` and `enum` are INDEPENDENT
// assertions and a value must satisfy both. So `type: ['string','null']` with
// `enum: ['us','eu','apac']` documents a field that can be null and then
// rejects null — a contract that contradicts itself.
//
// This is not theoretical. `/v1/account/me` returns `region: null` for any
// account that has not set one, and until the generator reconciled them, the
// schema describing that exact response rejected it. It reached 31 sites across
// five fields because the fault is in the zod-to-openapi conversion of
// `z.enum([...]).nullable()`, not in any one declaration — every nullable enum
// added later would arrive broken the same way.
//
// Asserted against the GENERATED document, not against the source that feeds
// it, because the conversion is the thing that breaks.

import { describe, expect, it } from 'vitest';
import { generateOpenApiSpec } from '../../src/lib/openapi.js';

interface Offender {
  path: string;
  type: unknown;
  enum: unknown[];
}

/** Schemas whose type admits null while their enum does not. */
function contradictions(node: unknown, path = ''): Offender[] {
  if (Array.isArray(node)) return node.flatMap((v, i) => contradictions(v, `${path}/${i}`));
  if (node === null || typeof node !== 'object') return [];

  const out: Offender[] = [];
  const schema = node as { type?: unknown; enum?: unknown[]; nullable?: boolean };
  // Both spellings: the 3.1 type-array form this generator emits, and the 3.0
  // `nullable: true` flag — so a downgrade or a hand-written fragment cannot
  // reintroduce the defect in a shape this guard does not look at.
  const admitsNull =
    (Array.isArray(schema.type) && schema.type.includes('null')) || schema.nullable === true;
  if (admitsNull && Array.isArray(schema.enum) && !schema.enum.includes(null)) {
    out.push({ path, type: schema.type, enum: schema.enum });
  }
  for (const [k, v] of Object.entries(node)) out.push(...contradictions(v, `${path}/${k}`));
  return out;
}

const spec = generateOpenApiSpec() as unknown;

describe('every nullable enum in the published spec admits null', () => {
  it('CRITICAL the detector finds the contradiction in both spellings and clears a well-formed schema. The assertion below reports an ABSENCE, so a detector that could never report anything would satisfy it having checked nothing.', () => {
    expect(JSON.stringify(spec).length, 'a real document was generated').toBeGreaterThan(10_000);

    // The 3.1 form — the exact shape that broke /v1/account/me.
    expect(
      contradictions({ type: ['string', 'null'], enum: ['us', 'eu', 'apac'] }),
      'a nullable type whose enum omits null is reported',
    ).toHaveLength(1);

    // The 3.0 form.
    expect(
      contradictions({ type: 'string', nullable: true, enum: ['a'] }),
      'the nullable:true spelling is reported too',
    ).toHaveLength(1);

    // Reconciled: null present in the enum.
    expect(
      contradictions({ type: ['string', 'null'], enum: ['us', null] }),
      'an enum that includes null is not a contradiction',
    ).toEqual([]);

    // A non-nullable enum is none of this guard's business.
    expect(
      contradictions({ type: 'string', enum: ['us', 'eu'] }),
      'a plain enum is left alone',
    ).toEqual([]);

    // Nested, since real offenders live deep inside components and responses.
    expect(
      contradictions({ components: { schemas: { A: { type: ['string', 'null'], enum: ['x'] } } } }),
      'nested schemas are reached',
    ).toHaveLength(1);
  });

  it('CRITICAL the published document contains no self-contradicting enum. A customer validating a real response against this spec — a contract test, a gateway, a generated client — would reject valid data.', () => {
    expect(
      contradictions(spec).map((o) => o.path),
      'schema(s) whose type admits null while their enum forbids it:',
    ).toEqual([]);
  });
});
