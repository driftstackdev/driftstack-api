// V-953 — the generated Python models carry every property the spec declares.
//
// `sdk-python-models-cover-every-spec-schema` checks that each component schema has
// a generated CLASS. That catches a schema added without re-running
// `npm run sdk:python:generate`, and it is blind to the more likely edit: a property
// added to a schema that already exists. The class is still there, so the class-level
// guard passes, and the Python SDK ships a model that cannot represent a field its
// own API accepts.
//
// The same shape one layer up was V-952: the snapshot's sync guard compared paths,
// operations and schema KEYS, and a changed bound sailed through all of it. This is
// that gap at the models layer, and the two now close the chain —
// `openapi.ts` → `openapi.json` → `models.py` — at content level rather than at
// name level.
//
// Not hypothetical: V-928 found `models.py` genuinely stale against the spec and had
// to regenerate it. Nothing at the time would have said so.
//
// This reads both artefacts rather than running datamodel-codegen. Running the
// generator would be the most direct comparison and is the wrong trade here: it needs
// the Python venv, which makes the guard skip where the venv is absent, and a guard
// that skips is not a guard. Parsing is dependency-free and catches the same drift.
// (Checked at the time of writing by regenerating to a scratch file: the committed
// models are byte-identical to a fresh run apart from the codegen timestamp.)

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');
const MODELS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/_generated/models.py');

const FIX = 'run `npm run sdk:python:generate`, committed alongside the spec change';

interface SpecShape {
  components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> };
}

/** Each `class Name(...)` block in the generated module, keyed by class name. */
function classBlocks(models: string): Map<string, string> {
  const marks = [...models.matchAll(/^class (\w+)\([^)]*\):$/gm)];
  const out = new Map<string, string>();
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? (marks[i + 1]?.index ?? models.length) : models.length;
    out.set(m[1] ?? '', models.slice(m.index, end));
  });
  return out;
}

/**
 * Field names a class block declares, including the wire names of renamed fields.
 *
 * Field declarations only, plus `alias="…"` — NOT a substring search over the block.
 * A substring test looks like it works and is close to vacuous: `id` occurs inside
 * `idempotency`, inside type names and inside every description that happens to use
 * the word, so almost any property would "be present". The first draft of this guard
 * did exactly that and reported the same clean result, which is the whole reason the
 * strictness has its own arm below.
 */
function declaredFields(block: string): Set<string> {
  const out = new Set<string>();
  for (const m of block.matchAll(/^ {4}(\w+):\s/gm)) out.add(m[1] ?? '');
  for (const m of block.matchAll(/alias="([^"]+)"/g)) out.add(m[1] ?? '');
  return out;
}

const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape;
const models = readFileSync(MODELS, 'utf8');
const blocks = classBlocks(models);
const schemasWithProperties = Object.entries(spec.components?.schemas ?? {}).filter(
  ([, schema]) => Object.keys(schema.properties ?? {}).length > 0,
);

describe('V-953 the generated Python models carry every property the spec declares', () => {
  it('CRITICAL both artefacts parsed into real populations. The assertion below reports an ABSENCE, so a spec that yielded no schemas with properties, or a models file that yielded no classes, would satisfy it having compared nothing at all.', () => {
    expect(
      schemasWithProperties.length,
      'spec component schemas carrying properties',
    ).toBeGreaterThan(60);
    expect(blocks.size, 'classes parsed out of the generated module').toBeGreaterThan(150);
  });

  it(`CRITICAL every property of every component schema exists as a field on its generated class. A property added to an existing schema leaves the class in place, so the class-level guard beside this one stays green while the SDK ships a model that cannot represent a field the API accepts. (${FIX})`, () => {
    const missing: string[] = [];
    for (const [name, schema] of schemasWithProperties) {
      const block = blocks.get(name);
      if (block === undefined) {
        missing.push(`${name}: no generated class at all`);
        continue;
      }
      const have = declaredFields(block);
      const absent = Object.keys(schema.properties ?? {}).filter((p) => !have.has(p));
      if (absent.length > 0) missing.push(`${name}: ${absent.join(', ')}`);
    }
    expect(
      missing,
      'the spec declares these properties and the generated models do not carry them. The Python SDK ' +
        'cannot represent them, so a caller using the typed client cannot send or read them',
    ).toEqual([]);
  });

  it('CRITICAL the field matcher is a declaration match, not a substring search. This is the arm that keeps the one above from going quietly vacuous: `block.includes(prop)` produces exactly the same clean result today and would accept a class with no fields at all, because short property names occur inside type names and descriptions. Asserted against a fixture, since every real class happens to be correct.', () => {
    const fixture = [
      'class Thing(BaseModel):',
      '    model_config = ConfigDict(populate_by_name=True)',
      '    id: str = Field(..., description="Identifier for this idempotency record")',
      '    from_: str = Field(..., alias="from")',
      '    nested: OtherModel | None = None',
      '',
    ].join('\n');
    const fields = declaredFields(fixture);

    expect(fields.has('id'), 'a real declared field is found').toBe(true);
    expect(fields.has('from'), 'a renamed field is found under its wire name').toBe(true);
    expect(fields.has('nested'), 'a field with no Field() call is found').toBe(true);

    // Present in the text, absent as a field. A substring matcher accepts all three.
    expect(fields.has('idempotency'), 'a word from a description is NOT a field').toBe(false);
    expect(fields.has('OtherModel'), 'a type name is NOT a field').toBe(false);
    expect(fields.has('description'), 'a Field() keyword is NOT a field').toBe(false);
  });
});
