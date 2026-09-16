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

/**
 * (V6 2026-09-16) The property sets a schema declares inside its UNION BRANCHES —
 * `oneOf` / `anyOf` / `allOf` — rather than on its own `properties`.
 *
 * ⛔ MEASURED, NOT HYPOTHETICAL. `udp_detail` was published on the fleet member of
 * `AccountProxyTestResult`'s `oneOf` and never reached `models.py`; this file walked
 * `components.schemas[*].properties` alone, so that member was outside the population
 * it censused and the guard reported CLEAN for a field the typed client could not
 * read. The same mistake `collectConstraints` below already avoids for enums and
 * patterns, made one layer up — a census reporting a clean answer about a set it
 * never enumerated.
 *
 * Only union keys are followed. `properties` and `items` are NOT: a nested object
 * becomes its own generated class under a name datamodel-codegen invents, and the
 * arm that owns those is the top-level one. A union branch is different — it lands
 * as `<Name>1`, `<Name>2`, … beside the schema's own name, which is exactly the
 * candidate set below.
 */
function unionBranchProperties(schema: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (node: unknown, isRoot: boolean): void => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;
    if (!isRoot) {
      const props = obj['properties'];
      if (props !== null && typeof props === 'object' && Object.keys(props).length > 0) {
        out.push(props as Record<string, unknown>);
      }
    }
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      const branches = obj[key];
      if (Array.isArray(branches)) for (const b of branches) walk(b, false);
    }
  };
  walk(schema, true);
  return out;
}

/** The classes a union member of `name` can have landed as: the schema's own class
 *  and its numbered siblings (`AccountProxyTestResult`, `…1`, `…2`, `…3`). Derived
 *  from the generator's naming rather than listed, so a new union needs no edit. */
function candidateBlocks(name: string, all: Map<string, string>): Set<string>[] {
  const out: Set<string>[] = [];
  for (const [cls, block] of all) {
    if (cls !== name && !(cls.startsWith(name) && /^\d+$/.test(cls.slice(name.length)))) continue;
    out.push(declaredFields(block));
  }
  return out;
}

/**
 * Every `enum` value and every `pattern` the component schemas declare, at any depth.
 *
 * A constraint is not always on a top-level property: it sits inside `items`, inside a
 * `oneOf` branch, inside a nested object. Walking only `schema.properties[*]` reads the
 * shallowest layer and calls it the population — the mistake that makes a census report
 * a clean answer about a set it never enumerated. A pattern carries its property's
 * `format` alongside it, because that is what decides whether the generator keeps it.
 */
function collectConstraints(root: unknown): {
  enums: Set<string>;
  patterns: Map<string, string | undefined>;
} {
  const enums = new Set<string>();
  const patterns = new Map<string, string | undefined>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj['pattern'] === 'string') {
      const format = obj['format'];
      patterns.set(obj['pattern'], typeof format === 'string' ? format : undefined);
    }
    if (Array.isArray(obj['enum'])) {
      for (const v of obj['enum']) if (typeof v === 'string') enums.add(v);
    }
    for (const v of Object.values(obj)) walk(v);
  };
  walk(root);
  return { enums, patterns };
}

const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape;
const models = readFileSync(MODELS, 'utf8');
const blocks = classBlocks(models);
const constraints = collectConstraints(spec.components?.schemas ?? {});
const specEnumValues = constraints.enums;
const specPatterns = constraints.patterns;
const schemasWithProperties = Object.entries(spec.components?.schemas ?? {}).filter(
  ([, schema]) => Object.keys(schema.properties ?? {}).length > 0,
);
const schemasWithUnionBranches = Object.entries(spec.components?.schemas ?? {})
  .map(([name, schema]) => ({ name, branches: unionBranchProperties(schema) }))
  .filter((s) => s.branches.length > 0);

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

  it(`CRITICAL every property of every UNION BRANCH (\`oneOf\` / \`anyOf\` / \`allOf\`) exists on one of that schema's generated classes. The arm above walks \`schema.properties\` only, so a property added inside a union member is outside its population and it reports CLEAN — which is exactly what happened to \`udp_detail\` on the fleet member of AccountProxyTestResult: published in the spec, absent from models.py, four sdk-python guards green. A VPN row then reached a typed Python caller with neither a UDP verdict nor the sentence saying why there is none. (${FIX})`, () => {
    // The population, first: this arm reports an ABSENCE, and a walker that found
    // no branches would satisfy it having compared nothing.
    expect(
      schemasWithUnionBranches.length,
      'spec component schemas carrying union branches with properties',
    ).toBeGreaterThan(5);

    const missing: string[] = [];
    for (const { name, branches } of schemasWithUnionBranches) {
      const candidates = candidateBlocks(name, blocks);
      branches.forEach((props, i) => {
        const keys = Object.keys(props);
        if (candidates.length === 0) {
          missing.push(`${name} (union member ${i + 1}): no generated class at all`);
          return;
        }
        // Covered when ONE class declares the whole member — the generator emits a
        // class per member, so a member split across two classes is not a match.
        const absentPerClass = candidates.map((have) => keys.filter((k) => !have.has(k)));
        if (absentPerClass.some((a) => a.length === 0)) return;
        const best = absentPerClass.reduce((a, b) => (a.length <= b.length ? a : b));
        missing.push(`${name} (union member ${i + 1}): ${best.join(', ')}`);
      });
    }
    expect(
      missing,
      'the spec declares these properties on a union member and no generated class for that ' +
        'schema carries them. A typed Python caller cannot read them off the branch that has them',
    ).toEqual([]);
  });

  it("CRITICAL the union walker follows union keys ONLY, and can miss. Asserted against a fixture: walking `properties` or `items` as well would credit a nested object's fields to the parent class, and the arm above would pass on a models.py that never generated the member.", () => {
    const found = unionBranchProperties({
      properties: { own: {}, nested: { properties: { buried: {} } } },
      oneOf: [
        { properties: { a: {} } },
        { anyOf: [{ properties: { b: {} } }] },
        { properties: { list: { items: { properties: { deep: {} } } } } },
      ],
    });
    const keys = found.flatMap((p) => Object.keys(p)).sort();

    expect(keys, 'union members at any union depth, and nothing else').toEqual(['a', 'b', 'list']);
    expect(keys.includes('own'), "the schema's OWN properties belong to the arm above").toBe(false);
    expect(keys.includes('buried'), 'a nested object is its own class, not this one').toBe(false);
    expect(keys.includes('deep'), 'an array item is its own class, not this one').toBe(false);

    // …and the candidate set is the generator's numbering, not every class whose
    // name merely begins with the schema's.
    const fake = new Map([
      ['Thing', 'class Thing(BaseModel):\n    a: str\n'],
      ['Thing2', 'class Thing2(BaseModel):\n    b: str\n'],
      ['ThingHolder', 'class ThingHolder(BaseModel):\n    c: str\n'],
    ]);
    const names = candidateBlocks('Thing', fake).flatMap((s) => [...s]);
    expect(names.sort(), 'Thing and Thing2 — never ThingHolder').toEqual(['a', 'b']);
  });

  it(`CRITICAL every enum the spec declares reaches the generated models as a literal. The arm above compares NAMES: a property keeps its field when its allowed values change, so widening or narrowing an enum leaves every name-level check green while the typed client rejects a value the API accepts — or accepts one it refuses. Measured: the models went stale for five days across this exact class, carrying \`action: str\` against a spec declaring 24 audit actions, with three sdk-python guards green throughout. (${FIX})`, () => {
    expect(specEnumValues.size, 'enum values declared across component schemas').toBeGreaterThan(
      150,
    );
    const missing = [...specEnumValues].filter((v) => !models.includes(`"${v}"`)).sort();
    expect(
      missing,
      'the spec allows these values and the generated models do not name them. A typed Python ' +
        'caller cannot express them',
    ).toEqual([]);
  });

  it(`CRITICAL every pattern the spec declares reaches the generated models, except where the property also declares a \`format\` — datamodel-codegen maps a formatted string onto its own type (\`format: uri\` becomes \`AnyUrl\`) and drops the pattern on the way. That exemption is DERIVED from the property rather than listed by name, so a field that loses its format stops being exempt on its own. Measured at the time of writing: 14 of 14 format-less patterns present, 2 of 2 formatted ones absent — the split is exactly the generator's behaviour and nothing else. (${FIX})`, () => {
    const unformatted = [...specPatterns].filter(([, format]) => format === undefined);
    expect(unformatted.length, 'format-less patterns declared in the spec').toBeGreaterThan(10);

    const missing = unformatted.map(([p]) => p).filter((p) => !models.includes(p));
    expect(
      missing,
      'the spec constrains these strings and the generated models accept anything. A bound ' +
        'published without regenerating is a bound the Python SDK does not have',
    ).toEqual([]);

    // Not vacuous: the matcher is a verbatim search, so it has to be able to miss.
    expect(models.includes('^tot_[0-9a-f]{4}$'), 'a pattern the spec never declared').toBe(false);
  });
});
