// A response example in the customer docs shows only fields the API defines.
//
// This exists because the docs were caught being wrong. `apps/docs/.../status.md`
// documented the SLA response as `{target, window_days, checks_total,
// checks_failed, uptime_pct}` when the route returns
// `{target, uptimePct, totalProbes, okCount, failCount, ...}` — one field name
// in five survived. Nothing noticed, because docs prose is not executable and
// no test compared an example to the contract.
//
// A LIMIT THIS CANNOT CROSS, measured rather than assumed. 101 of the 129
// templated endpoint references in docs use colon style (`/v1/x/:id`) while the
// spec keys them in braces, so their examples are skipped. Normalising the two
// looked like free coverage — 31 examples to 38 — and produced TWO false
// positives instead — both from ATTRIBUTION, neither a docs defect:
//
//   - account-rate-limits.md names an unrelated endpoint parenthetically
//     mid-sentence, nearer to the example than the section's own endpoint.
//   - mfa.md documents four responses in one page, and `POST /v1/auth/login` is
//     named INLINE in the sentence introducing its example.
//
// Three attribution rules were tried and each traded one error for another:
// nearest-preceding gets mfa.md right and account-rate-limits wrong; requiring
// the reference to start its line reverses that; skipping parenthesised
// references picks up a still-earlier unrelated endpoint. The tuning was
// stopped there rather than continued — a matcher tuned until it stops
// complaining is one nobody can trust.
//
// An earlier version of this comment said mfa.md names its endpoint AFTER the
// example. That was a misreading: the endpoint appears before it, inline, and
// the later `/v1/auth/mfa/challenge` is the NEXT step in the flow. The prose is
// good documentation as written, so the docs are not reshaped to suit a parser.
// Coverage stays where attribution is sound.
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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
// The whole docs tree, not just `api/`. Measured: 43 of the 44 labelled
// response examples live under `api/`; the 44th is a real API response (the
// webhook replay endpoint in `webhooks/replay.md`). The directory filter was an
// assumption rather than a property of the corpus.
const DOCS = resolve(REPO_ROOT, 'apps/docs/src/pages');
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

/**
 * Doc keys the spec does not list but that the server genuinely sends.
 *
 * Needed because this check is deliberately STRICTER than the schema. Only 11
 * of 447 object schemas set `additionalProperties: false`, so honouring the
 * schema literally would make the check nearly vacuous — an undocumented key
 * would almost never be a violation and the status.md defect it was written for
 * would sail through. Keeping it strict means the rare legitimate case is
 * recorded here, with the evidence, rather than silently tolerated.
 *
 * Exact, and checked for staleness below.
 */
const VERIFIED_UNDOCUMENTED: Record<string, string> = {
  'pair_mode_state.requestedByClientId':
    'REAL. The server union in services/agent-pair-mode-state.ts includes ' +
    "{ kind: 'takeover-pending'; requestedByClientId; requestedAt }, and the " +
    'published schema is z.object({ kind }).passthrough(), which permits extra ' +
    'keys. So the docs are right and the SPEC is loose — it flattens a ' +
    'discriminated union to its common member. Raised on the A2 bus rather ' +
    'than restructured here, since pair-mode is A3-s active surface (V-757).',
  'pair_mode_state.requestedAt':
    'Same union member and the same passthrough schema as the entry above.',
};

/** Every markdown file under the docs tree, at any depth. */
function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full));
    else if (full.endsWith('.md')) out.push(full);
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

  for (const file of markdownFiles(DOCS)) {
    const text = readFileSync(file, 'utf8');
    // BOTH marker spellings. The original regex required the status in
    // backticks — `Response (`200`):` — which is the MINORITY form: the corpus
    // uses the bare `Response (200):` 27 times against 10 backticked. So the
    // guard was matching the smaller half of the convention it was written for,
    // and 27 examples went unchecked because of a pair of backticks.
    for (const m of text.matchAll(/Response \(`?(\d{3})`?\)[^\n]*:\s*\n+```json\n([\s\S]*?)```/g)) {
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
      const undocumented = undocumentedKeys(example, schema).filter(
        // Match on the LEAF path so an exemption cannot acquit a whole subtree.
        (path) => VERIFIED_UNDOCUMENTED[path.replace(/\[\d+\]/g, '')] === undefined,
      );
      if (undocumented.length > 0) {
        pairs.push({ file, endpoint: `${method.toUpperCase()} ${path}`, undocumented });
      }
    }
  }
  return { pairs, matched, labelled };
}

/**
 * Every undocumented key the examples contain, BEFORE exemptions are applied.
 *
 * The staleness arm needs this: exempted keys are filtered out of `scan()` by
 * construction, so checking an exemption against the filtered result would
 * always call it stale.
 */
function scanRaw(): Set<string> {
  const out = new Set<string>();
  if (!existsSync(DOCS)) return out;
  for (const file of markdownFiles(DOCS)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/Response \(`?(\d{3})`?\)[^\n]*:\s*\n+```json\n([\s\S]*?)```/g)) {
      const status = m[1] ?? '';
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
      const schema = responseSchema(path, method, status);
      if (schema?.properties === undefined) continue;
      for (const k of undocumentedKeys(example, schema)) out.add(k.replace(/\[\d+\]/g, ''));
    }
  }
  return out;
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

  it('CRITICAL every verified-undocumented entry still describes a key the docs really show. An entry whose key is gone exempts nothing and reads as reviewed.', () => {
    const { pairs } = scan();
    const shown = new Set(pairs.flatMap((p) => p.undocumented));
    // The entries suppress their keys, so they cannot appear in `pairs`. Assert
    // against the raw scan instead: an exemption must correspond to a key some
    // example actually contains.
    const raw = scanRaw();
    const stale = Object.keys(VERIFIED_UNDOCUMENTED).filter((k) => !raw.has(k));
    expect(stale, 'exemption(s) no example produces any more:').toEqual([]);
    expect(shown.size, 'no unexplained keys leak through').toBe(0);
  });

  it('CRITICAL no doc example shows a field the API does not define. This is the exact defect found in status.md, where four of five documented SLA field names did not exist on the route.', () => {
    const { pairs } = scan();
    expect(
      pairs.map((p) => `${p.file} ${p.endpoint}: ${p.undocumented.join(', ')}`),
      'doc example(s) promising fields the contract does not define:',
    ).toEqual([]);
  });
});
