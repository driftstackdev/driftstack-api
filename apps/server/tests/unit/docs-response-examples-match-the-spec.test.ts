// A response example in the customer docs shows only fields the API defines.
//
// This exists because the docs were caught being wrong. `apps/docs/.../status.md`
// documented the SLA response as `{target, window_days, checks_total,
// checks_failed, uptime_pct}` when the route returns
// `{target, uptimePct, totalProbes, okCount, failCount, ...}` — one field name
// in five survived. Nothing noticed, because docs prose is not executable and
// no test compared an example to the contract.
//
// READ THE COVERAGE BEFORE TRUSTING A GREEN HERE. Only examples introduced by
// the literal `Response (\`NNN\`):` marker can be tied to an endpoint, and only
// 4 of the 26 API doc pages use that marker at all — 9 examples in total. So
// this checks a real invariant on a SMALL slice, and a page that documents its
// responses some other way is invisible to it. That is a limitation to fix by
// adopting the marker, not by loosening the matcher: a fuzzy "find the nearest
// json block" version of this reported 59 mismatches, and every single one was
// a request body compared against a response schema or an unresolved $ref.
//
// Direction is deliberate: a doc key the spec does not define is a defect (the
// docs promise a field the API never sends). The reverse — a spec field absent
// from the example — is normal, because examples elide optional fields.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS = resolve(REPO_ROOT, 'apps/docs/src/pages/api');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

interface Spec {
  paths?: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, JsonSchema> };
}
interface Operation {
  responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
}
interface JsonSchema {
  $ref?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
}

const spec: Spec = existsSync(SPEC) ? (JSON.parse(readFileSync(SPEC, 'utf8')) as Spec) : {};

/** Follow `$ref` into components; the spec carries 1102 of them. */
function deref(schema: JsonSchema | undefined, depth = 0): JsonSchema | undefined {
  if (schema === undefined || depth > 6) return schema;
  if (schema.$ref === undefined) return schema;
  const name = schema.$ref.split('/').pop() ?? '';
  return deref(spec.components?.schemas?.[name], depth + 1);
}

function responseSchema(path: string, method: string, status: string): JsonSchema | undefined {
  return deref(
    spec.paths?.[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema,
  );
}

/**
 * Walk the example ALONGSIDE the schema and collect every key the contract does
 * not define, at any depth.
 *
 * Top-level-only was not good enough, and that is not a hypothetical: the
 * status.md defect this guard exists for lived inside `data[]`. A first version
 * compared only the outer object, so reintroducing the real historical bug —
 * `uptime_pct` for `uptimePct` — left it green. The guard was checking that the
 * envelope said `data`, which was the one thing that had never been wrong.
 */
function undocumentedKeys(example: unknown, schema: JsonSchema | undefined, path = ''): string[] {
  const node = deref(schema);
  if (node === undefined) return [];

  if (Array.isArray(example)) {
    return example.flatMap((item, i) =>
      undocumentedKeys(item, node.items, `${path}[${String(i)}]`),
    );
  }
  if (typeof example !== 'object' || example === null) return [];

  // A union describes several shapes; a key defined by ANY branch is defined.
  const branches = node.anyOf ?? node.oneOf;
  if (branches !== undefined) {
    const perBranch = branches.map((b) => undocumentedKeys(example, b, path));
    const best = perBranch.reduce((a, b) => (b.length < a.length ? b : a), perBranch[0] ?? []);
    return best;
  }

  const props = node.properties;
  if (props === undefined) return [];

  const out: string[] = [];
  for (const [key, value] of Object.entries(example as Record<string, unknown>)) {
    const child = props[key];
    if (child === undefined) {
      out.push(path === '' ? key : `${path}.${key}`);
      continue;
    }
    out.push(...undocumentedKeys(value, child, path === '' ? key : `${path}.${key}`));
  }
  return out;
}

interface Pair {
  file: string;
  endpoint: string;
  undocumented: string[];
}

function scan(): { pairs: Pair[]; matched: number; labelled: number } {
  const pairs: Pair[] = [];
  let matched = 0;
  let labelled = 0;
  if (!existsSync(DOCS)) return { pairs, matched, labelled };

  for (const file of readdirSync(DOCS).filter((f) => f.endsWith('.md'))) {
    const text = readFileSync(resolve(DOCS, file), 'utf8');
    for (const m of text.matchAll(/Response \(`(\d{3})`\):\s*\n+```json\n([\s\S]*?)```/g)) {
      labelled += 1;
      const status = m[1] ?? '';
      // The endpoint is the LAST `METHOD /v1/...` before this block, which is
      // what ties the example to a contract rather than to a nearby heading.
      const before = text.slice(0, m.index ?? 0);
      const eps = [...before.matchAll(/`(GET|POST|PATCH|DELETE) (\/v1\/[^`\s]+)`/g)];
      const last = eps.at(-1);
      if (last === undefined) continue;
      const method = (last[1] ?? '').toLowerCase();
      const path = (last[2] ?? '').split('?')[0]?.replace(/\/$/, '') ?? '';

      let example: unknown;
      try {
        example = JSON.parse(m[2] ?? '');
      } catch {
        continue;
      }
      if (typeof example !== 'object' || example === null || Array.isArray(example)) continue;

      const schema = responseSchema(path, method, status);
      if (schema?.properties === undefined) continue;
      matched += 1;
      const undocumented = undocumentedKeys(example, schema);
      if (undocumented.length > 0) {
        pairs.push({ file, endpoint: `${method.toUpperCase()} ${path}`, undocumented });
      }
    }
  }
  return { pairs, matched, labelled };
}

describe('customer doc response examples match the published contract', () => {
  it('CRITICAL the scan still resolves refs and still finds examples to compare. The assertion below reports an ABSENCE, so a matcher that stopped matching anything would satisfy it having compared nothing.', () => {
    const { matched, labelled } = scan();
    expect(Object.keys(spec.paths ?? {}).length, 'spec paths loaded').toBeGreaterThan(20);
    expect(labelled, 'labelled response examples found in the docs').toBeGreaterThanOrEqual(10);
    // 9 of the 10 labelled examples tie to a spec schema today. Pinned so the
    // coverage cannot quietly fall to zero and keep reporting success.
    expect(matched, 'examples actually compared against a schema').toBeGreaterThanOrEqual(9);

    // Ref resolution is what makes the comparison meaningful; without it a
    // $ref'd schema yields no properties and every key looks undocumented.
    const refd = deref({ $ref: '#/components/schemas/Problem' });
    expect(
      Object.keys(refd?.properties ?? {}).length,
      'a $ref resolves to real properties',
    ).toBeGreaterThan(1);

    // NESTING, as an executable arm rather than a comment — this is the exact
    // hole the first version of this guard had. It compared top-level keys
    // only, so the status.md bug it was written for (a wrong name inside
    // `data[]`) left it green: the envelope key `data` was the one thing that
    // had never been wrong.
    const envelope: JsonSchema = {
      properties: { data: { items: { properties: { uptimePct: {} } } } },
    };
    expect(
      undocumentedKeys({ data: [{ uptime_pct: 1 }] }, envelope),
      'a wrong field name INSIDE an array is reported, with its path',
    ).toEqual(['data[0].uptime_pct']);
    expect(
      undocumentedKeys({ data: [{ uptimePct: 1 }] }, envelope),
      'and the correct name is not',
    ).toEqual([]);

    // A union: a key any branch defines is defined.
    expect(
      undocumentedKeys({ b: 1 }, { anyOf: [{ properties: { a: {} } }, { properties: { b: {} } }] }),
      'a key defined by one branch of a union is accepted',
    ).toEqual([]);
  });

  it('CRITICAL no doc example shows a field the API does not define. This is the exact defect found in status.md, where four of five documented SLA field names did not exist on the route.', () => {
    const { pairs } = scan();
    expect(
      pairs.map((p) => `${p.file} ${p.endpoint}: ${p.undocumented.join(', ')}`),
      'doc example(s) promising fields the contract does not define:',
    ).toEqual([]);
  });
});
