// The TypeScript types customers receive describe the same fields the API
// documents — compared as runtime shapes, in both directions.
//
// The three SDKs are kept honest unequally. Python's models are GENERATED from
// the committed spec and `sdk-python-models-cover-every-spec-schema` checks the
// generator ran. Go's structs are hand-written and
// `sdk-go-structs-cover-openapi-fields` checks they cover what the API returns —
// that guard exists because `AgentSession` had silently dropped
// `capability_report` and `error_event`, so a Go caller could read
// `status: "closed"` with no way to learn why.
//
// TypeScript had neither. The Go guard's own header records the reason it was
// not thought necessary — "TypeScript stayed in sync; Go did not" — which was
// true when it was written and is a statement about a moment, not a mechanism.
// Nothing has been keeping it true since.
//
// The comparison is done on RUNTIME ZOD SHAPES rather than by parsing source,
// and that decision is what makes it correct rather than merely convenient. A
// first attempt parsed `export interface X extends Y {` out of the SDK and
// immediately reported `RotateApiKeyResponse` as missing all nine of its fields.
// It is not missing them: it extends `CreateApiKeyResponse`, which is not an
// interface at all but `ApiKeySchema.extend({...})` in `api-types`, imported
// across a package boundary. Source parsing has to chase `extends` across files
// and packages and re-implement `.extend()`; asking the built object for its
// `.shape` gets the resolved answer with no chasing at all.
//
// Both directions are compared. A spec field absent from the type is the Go
// failure — data the API returns that a caller cannot see. A type field absent
// from the spec is the reverse: a property TypeScript promises, that customers
// will write code against, and that the documented contract does not include.
//
// V-1062 extended this from FIELD NAMES to BOUNDS. Presence was the only thing
// compared, so a spec property could carry the right name and no constraint at all
// while the route rejected the value — `cursor` was published as any string against
// a schema requiring 1..512, and a validation-schedule cadence was published with a
// floor and no ceiling against a one-year cap. Both were hand-rolled mirrors in
// lib/openapi.ts; both now use the source schema, which is the fix V-928 already
// applied to the proxy body.
//
// COVERAGE: 39 of the 70 object schemas in the committed spec have a matching
// exported zod object. The other 31 are declared inline inside `lib/openapi.ts`
// rather than imported from `api-types` — `AccountMeResponse`, `AdminAccount`,
// `TeamMember` and so on — so there is no second definition to disagree with and
// nothing here to compare. That number is floored: pairing that quietly shrinks
// turns this file into a comparison of nothing while it still reads green.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as apiTypes from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO, 'packages', 'sdk-python', 'openapi.json');

/**
 * Every exported zod OBJECT, keyed by the schema name with `Schema` dropped.
 *
 * `.shape` is the resolved field set: a schema built with `.extend()` reports
 * the inherited fields alongside its own, which is the whole reason this reads
 * the built object instead of the source.
 */
function zodShapes(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [name, value] of Object.entries(apiTypes)) {
    const shape = (value as { shape?: unknown } | null)?.shape;
    if (shape === null || typeof shape !== 'object') continue;
    out.set(name.replace(/Schema$/, ''), new Set(Object.keys(shape)));
  }
  return out;
}

/** Object schemas in the committed spec, name → property names. */
function specSchemas(): Map<string, Set<string>> {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as {
    components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> };
  };
  const out = new Map<string, Set<string>>();
  for (const [name, s] of Object.entries(spec.components?.schemas ?? {})) {
    if (s.properties !== undefined) out.set(name, new Set(Object.keys(s.properties)));
  }
  return out;
}

/** Object schemas in the committed spec, name → property name → published subschema. */
function fullSpecSchemas(): Map<string, Record<string, Record<string, unknown>>> {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as {
    components?: {
      schemas?: Record<string, { properties?: Record<string, Record<string, unknown>> }>;
    };
  };
  const out = new Map<string, Record<string, Record<string, unknown>>>();
  for (const [name, s] of Object.entries(spec.components?.schemas ?? {})) {
    if (s.properties !== undefined) out.set(name, s.properties);
  }
  return out;
}

/**
 * JSON-Schema keywords a zod field enforces, read from its `_def` checks.
 *
 * Only the keywords that survive the zod-to-openapi conversion are reported. A
 * `.refine()` is a runtime predicate with no JSON Schema equivalent (V-924), so it
 * is deliberately not counted — claiming it should be published would make this arm
 * fail for a reason nobody can fix.
 */
function constraintsOf(def: unknown): string[][] {
  const d = (
    def as {
      _def?: { typeName?: string; checks?: { kind: string; inclusive?: boolean }[] };
    }
  )._def;
  const inner = (def as { _def?: { innerType?: unknown } })._def?.innerType;
  if (d?.checks === undefined && inner !== undefined) return constraintsOf(inner);
  const checks = d?.checks ?? [];
  const isString = d?.typeName === 'ZodString';
  const out: string[][] = [];
  for (const c of checks) {
    if (c.kind !== 'min' && c.kind !== 'max') continue;
    if (isString) {
      out.push([c.kind === 'min' ? 'minLength' : 'maxLength']);
      continue;
    }
    // V-1063 — a numeric bound publishes EITHER the inclusive or the exclusive
    // keyword, and `.positive()` / `.negative()` are min/max checks with
    // `inclusive: false`. Demanding `minimum` for a `.positive()` field reports a
    // spec that is already correct: `exclusiveMinimum: 0` is exactly right for it.
    // Each entry is a set of acceptable keywords, satisfied by any one of them.
    out.push(c.kind === 'min' ? ['minimum', 'exclusiveMinimum'] : ['maximum', 'exclusiveMaximum']);
  }
  return out;
}

/**
 * Each live `/v1` registration paired with the schema its handler parses.
 *
 * V-1063 — the component-level comparison above cannot see operation-level query
 * parameters, and six of the seven properties V-1063 fixed were exactly that: a
 * `cursor` declared inline on the operation, published unbounded, against routes
 * that all enforce 1..512. Fixing them without extending the guard would have left
 * them free to regress.
 *
 * Segments are bounded by the enclosing `export function` as well as the next
 * registration — without that bound the last live route in a file swallows the
 * `…DisabledRoutes` stub beneath it, which has produced a wrong count three times
 * in this corpus.
 */
function routeSchemaPairs(): { method: string; path: string; schema: string }[] {
  const dir = resolve(REPO, 'apps/server/src/routes');
  const REGISTRATION =
    /app\.(get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(\s*['"`](\/v1\/[^'"`]*)['"`]/g;
  const out: { method: string; path: string; schema: string }[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(resolve(dir, file), 'utf8');
    const fns = [...src.matchAll(/^export function (\w+)/gm)].map((m) => [m.index, m[1]!] as const);
    const edges = [...fns.map(([at]) => at), src.length];
    const regs = [...src.matchAll(REGISTRATION)];
    for (const [i, m] of regs.entries()) {
      let owner = '(top)';
      let fnEnd = src.length;
      for (const [idx, [at, name]] of fns.entries()) {
        if (at <= m.index) {
          owner = name;
          fnEnd = edges[idx + 1] ?? src.length;
        } else break;
      }
      if (/Disabled/.test(owner)) continue;
      const nextReg = i + 1 < regs.length ? (regs[i + 1]?.index ?? src.length) : src.length;
      const segment = src.slice(m.index + m[0].length, Math.min(nextReg, fnEnd));
      const parsed = /(\w+Schema)\.(?:safeParse|parse)\(/.exec(segment);
      if (parsed !== null) {
        out.push({ method: (m[1] ?? '').toLowerCase(), path: m[2] ?? '', schema: parsed[1]! });
      }
    }
  }
  return out;
}

/** Published properties for one operation: request body fields plus query params. */
function operationProperties(
  spec: Record<string, unknown>,
  method: string,
  path: string,
): Record<string, Record<string, unknown>> {
  const paths = (spec as { paths?: Record<string, Record<string, unknown>> }).paths ?? {};
  const op = paths[path.replace(/:(\w+)/g, '{$1}')]?.[method] as
    | {
        parameters?: { name: string; schema?: Record<string, unknown> }[];
        requestBody?: {
          content?: { 'application/json'?: { schema?: Record<string, unknown> } };
        };
      }
    | undefined;
  if (op === undefined) return {};
  const out: Record<string, Record<string, unknown>> = {};
  let body = op.requestBody?.content?.['application/json']?.schema;
  const ref = body?.['$ref'];
  if (typeof ref === 'string') {
    const comps = (spec as { components?: { schemas?: Record<string, Record<string, unknown>> } })
      .components?.schemas;
    body = comps?.[ref.split('/').pop() ?? ''];
  }
  const props = body?.['properties'];
  if (props !== null && typeof props === 'object') {
    for (const [k, v] of Object.entries(props as Record<string, Record<string, unknown>>)) {
      out[k] = v;
    }
  }
  for (const p of op.parameters ?? []) out[p.name] = p.schema ?? {};
  return out;
}

const pairedNames = (): string[] => {
  const shapes = zodShapes();
  return [...specSchemas().keys()].filter((n) => shapes.has(n)).sort();
};

describe('the api-types shapes match the committed spec', () => {
  it('CRITICAL both sides were read and paired. Every assertion below reports an absence, and an absence compared against nothing is absent — an empty parse on either side would report perfect agreement, which is exactly the failure this file exists to catch wearing the result as a disguise.', () => {
    // MEASURED: 178 exported zod objects, 70 object schemas in the spec.
    expect(zodShapes().size, 'exported zod objects read from api-types').toBeGreaterThanOrEqual(
      170,
    );
    expect(
      specSchemas().size,
      'object schemas read from the committed spec',
    ).toBeGreaterThanOrEqual(70);

    // `.shape` resolving `.extend()` is the assumption the whole file rests on,
    // checked on a schema whose answer is not in doubt: CreateApiKeyResponse is
    // ApiKeySchema.extend({ plaintext }), so it must report BOTH sides.
    const created = zodShapes().get('CreateApiKeyResponse');
    expect(created?.has('plaintext'), 'the field the extending schema adds').toBe(true);
    expect(created?.has('key_prefix'), 'and a field it inherits from ApiKeySchema').toBe(true);
  });

  it('CRITICAL the pairing still covers what it covered. MEASURED at 39 of 70 spec object schemas; the rest are declared inline in lib/openapi.ts with no api-types counterpart, so there is no second definition to disagree with. A renamed export silently drops a pair, and a comparison of fewer things reads exactly like a comparison that found nothing.', () => {
    expect(
      pairedNames().length,
      'spec schemas with a matching exported zod object',
    ).toBeGreaterThanOrEqual(39);
  });

  it('CRITICAL no documented field is missing from the TypeScript type. This is the Go failure in the other SDK: the API returns the field, the type does not mention it, and a caller has no way to reach data that is already on the wire.', () => {
    const shapes = zodShapes();
    const spec = specSchemas();
    const missing: string[] = [];
    for (const name of pairedNames()) {
      const have = shapes.get(name)!;
      const absent = [...spec.get(name)!].filter((f) => !have.has(f));
      if (absent.length > 0) missing.push(`${name}: ${absent.sort().join(', ')}`);
    }
    expect(missing, 'documented field(s) absent from the api-types shape:').toEqual([]);
  });

  it('CRITICAL no TypeScript field is missing from the spec. The reverse direction and the one that misleads rather than hides: a property the types promise, that customers write code against, and that the documented contract never mentions.', () => {
    const shapes = zodShapes();
    const spec = specSchemas();
    const extra: string[] = [];
    for (const name of pairedNames()) {
      const documented = spec.get(name)!;
      const undocumented = [...shapes.get(name)!].filter((f) => !documented.has(f));
      if (undocumented.length > 0) extra.push(`${name}: ${undocumented.sort().join(', ')}`);
    }
    expect(extra, 'api-types field(s) the spec does not document:').toEqual([]);
  });

  it('CRITICAL a documented property carries the constraints its schema enforces. A name that matches with no bound behind it is the shape V-1062 found twice: the document says any string, the route rejects the value, and the only way a customer learns the real limit is a 400 they were told could not happen.', () => {
    const spec = fullSpecSchemas();
    const loose: string[] = [];
    for (const name of pairedNames()) {
      const zod = (apiTypes as Record<string, unknown>)[`${name}Schema`];
      const shape = (zod as { shape?: Record<string, unknown> } | undefined)?.shape;
      if (shape === undefined) continue;
      for (const [field, def] of Object.entries(shape)) {
        const enforced = constraintsOf(def);
        if (enforced.length === 0) continue;
        const published = spec.get(name)?.[field] ?? {};
        for (const acceptable of enforced) {
          if (!acceptable.some((k) => k in published)) {
            loose.push(`${name}.${field}: schema enforces ${acceptable.join(' or ')}`);
          }
        }
      }
    }
    expect(
      loose.sort(),
      'the spec publishes these properties without the constraint the route enforces — use the ' +
        'source schema in lib/openapi.ts rather than a hand-rolled mirror:',
    ).toEqual([]);
  });

  it('CRITICAL an operation publishes the constraints its own handler enforces. The component comparison above cannot see query parameters declared inline on an operation, which is where six of the seven V-1063 properties lived — every paginated list published `cursor` as any string while every one of those routes rejects anything outside 1..512.', () => {
    const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as Record<string, unknown>;
    const pairs = routeSchemaPairs();

    // The pairing has to find real routes, or the loop below compares nothing.
    expect(pairs.length, 'registrations paired to a parsing schema').toBeGreaterThanOrEqual(90);

    const loose: string[] = [];
    let compared = 0;
    for (const { method, path, schema } of pairs) {
      const zod = (apiTypes as Record<string, unknown>)[schema];
      const shape = (zod as { shape?: Record<string, unknown> } | undefined)?.shape;
      if (shape === undefined) continue;
      const published = operationProperties(spec, method, path);
      if (Object.keys(published).length === 0) continue;
      compared += 1;
      for (const [field, def] of Object.entries(shape)) {
        const declared = published[field];
        if (declared === undefined) continue;
        for (const acceptable of constraintsOf(def)) {
          if (!acceptable.some((k) => k in declared)) {
            loose.push(
              `${method.toUpperCase()} ${path} .${field}: ${schema} enforces ` +
                `${acceptable.join(' or ')}`,
            );
          }
        }
      }
    }
    expect(compared, 'operations compared against their parsing schema').toBeGreaterThanOrEqual(50);
    expect(
      [...new Set(loose)].sort(),
      'these operations publish a property looser than the schema their handler parses with:',
    ).toEqual([]);
  });
});
