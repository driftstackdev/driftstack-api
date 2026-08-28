// The committed spec has a drift guard (`openapi.test.ts` — "committed
// openapi.json is stale, run sdk:python:dump-spec"). The GENERATED PYTHON MODEL
// has none for values.
//
// `sdk-python-models-cover-every-spec-schema` checks that every component schema
// has a class — coverage by NAME. A schema can therefore gain an enum value and
// the model keep the old `Literal[...]`, with both guards green: the class still
// exists, and the spec still matches its generator.
//
// Measured 2026-08-28: adding `recipe.created` / `recipe.deleted` took the spec's
// AccountAuditEntry.action to 49 values while models.py stayed at 47, and NOTHING
// failed. A client on that model rejects an audit page containing a recipe row —
// a validation error on data the server is entitled to send. The guard's key was
// coarser than the property it was trusted for: a name-level census cannot see a
// value-level divergence.
//
// Direction: a value in the SPEC and absent from the MODEL is the break — the
// server may send it and the client rejects it. The reverse (model ahead of spec)
// is a stale regeneration that costs a client nothing, so it is DELIBERATELY NOT
// CHECKED here rather than reported. Stating that because an earlier draft of this
// comment said the reverse was "reported separately", which the code never did —
// prose describing a behaviour the file does not have is the same defect this
// guard exists to catch, one level up.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');
const MODELS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/_generated/models.py');

interface SpecEnum {
  schema: string;
  field: string;
  values: string[];
}

/** Every `properties.<field>.enum` of a component schema, as (schema, field, values). */
function specEnums(specJson: string): SpecEnum[] {
  const spec = JSON.parse(specJson) as {
    components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> };
  };
  const out: SpecEnum[] = [];
  for (const [schema, def] of Object.entries(spec.components?.schemas ?? {})) {
    for (const [field, prop] of Object.entries(def.properties ?? {})) {
      const e = (prop as { enum?: unknown }).enum;
      if (!Array.isArray(e)) continue;
      const values = e.filter((v): v is string => typeof v === 'string');
      if (values.length > 0) out.push({ schema, field, values });
    }
  }
  return out;
}

/** The `Literal[...]` members datamodel-codegen emitted for `<class>.<field>`. */
function modelLiteral(modelsPy: string, cls: string, field: string): string[] | null {
  const start = modelsPy.indexOf(`class ${cls}(`);
  if (start === -1) return null;
  const next = modelsPy.indexOf('\nclass ', start + 1);
  const body = modelsPy.slice(start, next === -1 ? undefined : next);
  // datamodel-codegen wraps long Literals across lines, so match to the closing
  // bracket rather than to end-of-line.
  const m = new RegExp(`^\\s+${field}:[^\\n]*?Literal\\[([\\s\\S]*?)\\]`, 'm').exec(body);
  if (m?.[1] === undefined) return null;
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]!);
}

describe('the generated python model agrees with the spec enums', () => {
  const specJson = readFileSync(SPEC, 'utf8');
  const modelsPy = readFileSync(MODELS, 'utf8');
  const enums = specEnums(specJson);

  it('CRITICAL both artefacts parsed and the comparison is non-trivial. Every assertion below reports an ABSENCE, so a spec that yielded no enums, or a models file that yielded no classes, would satisfy them having compared nothing.', () => {
    expect(enums.length, 'enum-typed properties found in the spec').toBeGreaterThan(20);
    expect(modelsPy.split('\nclass ').length - 1, 'classes in models.py').toBeGreaterThan(50);
    // A known pair must resolve, or the extractor is returning null for everything
    // and every comparison below is skipped rather than passed.
    const known = modelLiteral(modelsPy, 'AccountAuditEntry', 'action');
    expect(known, 'AccountAuditEntry.action Literal resolved').not.toBeNull();
    expect(known?.length ?? 0).toBeGreaterThan(40);
  });

  it('CRITICAL no spec enum value is missing from the generated model. A value the server may send and the model rejects is a client-side validation error on legitimate data — and it ships silently, because the class still exists and the spec still matches its generator.', () => {
    const missing: string[] = [];
    for (const { schema, field, values } of enums) {
      const lit = modelLiteral(modelsPy, schema, field);
      if (lit === null) continue; // no model field — the name-coverage guard's job
      for (const v of values) {
        if (!lit.includes(v)) missing.push(`${schema}.${field}: '${v}'`);
      }
    }
    expect(
      missing,
      'spec enum values absent from models.py — run `npm run sdk:python:generate`',
    ).toEqual([]);
  });
});
