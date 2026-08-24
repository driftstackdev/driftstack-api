// V-927 — the OpenAPI document dropped length bounds the routes enforce.
//
// Request bodies in `openapi.ts` are hand-written mirrors of schemas that live
// beside their routes (V-926 measured the surface: 33 of 71 published request
// schemas are mirrors, 21 of them named by no test at all). A mirror can agree
// on field names and required-ness — which is what V-926 checks — while quietly
// dropping a bound, and then the document under-specifies a limit the server
// still enforces.
//
// Two were dropped:
//   • `/v1/oauth/token` redirect_uri — `ExchangeCodeBody` caps it at 2048; the
//     document published `format: uri` with no maxLength.
//   • `/v1/status/subscribe` email — `SubscribeBodySchema` caps it at 254 (the
//     RFC 5321 limit); the document published no length on a PUBLIC endpoint.
//
// Neither is dangerous. Both mean a request the document describes as valid
// draws a 400, which is the same class as V-924 and V-926 and the reason to
// close it rather than shrug: a contract that is loose in a way the server is
// not teaches customers to discover limits by hitting them.
//
// Checked from BOTH ends on purpose. Asserting only the spec would pass if
// someone relaxed the route; asserting only the route would pass if the mirror
// drifted again. The pair is the invariant.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import * as apiTypes from '@driftstack/api-types';

extendZodWithOpenApi(z);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

interface SpecShape {
  paths: Record<
    string,
    {
      post?: {
        requestBody?: {
          content: {
            'application/json': {
              schema: { properties?: Record<string, { maxLength?: number }> };
            };
          };
        };
      };
    }
  >;
}

function publishedMaxLength(path: string, field: string): number | undefined {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape;
  const schema = spec.paths[path]?.post?.requestBody?.content['application/json'].schema;
  return schema?.properties?.[field]?.maxLength;
}

interface BoundCase {
  readonly path: string;
  readonly field: string;
  readonly max: number;
  readonly routeFile: string;
  /** Proves the route really declares the bound, not just that the spec does. */
  readonly routePattern: RegExp;
}

const BOUNDS: readonly BoundCase[] = [
  {
    path: '/v1/oauth/token',
    field: 'redirect_uri',
    max: 2048,
    routeFile: 'apps/server/src/routes/oauth.ts',
    routePattern: /redirect_uri: z\.string\(\)\.max\(2048\)\.url\(\)/,
  },
  {
    path: '/v1/status/subscribe',
    field: 'email',
    max: 254,
    routeFile: 'apps/server/src/routes/status-subscribe.ts',
    routePattern: /email: z\.string\(\)\.trim\(\)\.email\([^)]*\)\.max\(254\)/,
  },
  // V-1474 — a third and fourth, found by deriving the surface instead of
  // waiting for someone to notice. `AdminApplyIpnRequestSchema` published both
  // fields as unbounded strings while `ApplyIpnBody` in the route enforces
  // min(1).max(64) and min(1).max(128), and the api-types content-parity pin
  // quoted the unbounded shape — so the dropped bounds were asserted.
  {
    path: '/v1/admin/crypto-orders/{order_id}/apply-ipn',
    field: 'provider_status',
    max: 64,
    routeFile: 'apps/server/src/routes/admin-crypto-orders.ts',
    routePattern: /provider_status: z\.string\(\)\.min\(1\)\.max\(64\)/,
  },
  {
    path: '/v1/admin/crypto-orders/{order_id}/apply-ipn',
    field: 'payment_id',
    max: 128,
    routeFile: 'apps/server/src/routes/admin-crypto-orders.ts',
    routePattern: /payment_id: z\.string\(\)\.min\(1\)\.max\(128\)/,
  },
];

/**
 * V-1476 — the derived half.
 *
 * BOUNDS above is a hand-written roster, and a roster cannot report the case
 * nobody has noticed yet. It held four entries and the fifth — the restore rail
 * publishing `name` as a bare string while the route enforces ProfileNameSchema
 * — sat outside it, exactly as the clone rail had before V-1063 and the quote
 * rail before V-1475. Three instances of one shape found one at a time is the
 * signal that the instrument, not the roster, is what was missing.
 *
 * Every entry here was traced to its HANDLER, not to its zod declaration. That
 * distinction is the finding: three of the five fields this census first
 * surfaced looked unconstrained in zod and were bounded by hand — `rotate.name`
 * by an explicit `body.name.length` test, and `profile_id` on two rails by
 * `parseProfileId`, which answers 400 on anything but `prof_<uuid> | <uuid>`.
 * Writing those off as "no schema, so no bound" would have allowlisted three
 * live divergences as intentional, which is worse than the roster this replaces.
 *
 * PRIOR ART, and why this does not duplicate it.
 * `published-request-schema-is-not-looser-than-enforced` attacks the same class
 * by NAME-MATCHING openapi.ts declarations against route-file declarations, and
 * it measures its own coverage honestly: of 43 published request field names,
 * only 22 are unambiguous on both sides and actually compared. That is exactly
 * why it sees none of the four fixed here — `name` and `profile_id` are declared
 * many times on both sides and land in its ambiguous bucket, `rotate.name` has
 * no route-side zod declaration to match at all, and the organization arrays are
 * declared in api-types rather than in a route file. It compares chains where
 * the pairing is unambiguous and asks whether the published one is LOOSER; this
 * asks, from the document alone, whether a constraint exists AT ALL — which
 * needs no pairing, and so has no ambiguity to decline. Neither subsumes the
 * other, and a field can fail one while passing the other.
 *
 * So this half asks the question from the document's side instead: which
 * published request-body strings carry NO constraint at all? That set is
 * derived, so a newly added unconstrained field joins it without anyone editing
 * this file, and the allowlist below forces a decision — bound it, or write down
 * why it is honestly unbounded.
 *
 * Constraint means any of maxLength, minLength, pattern, enum, format. Checking
 * only `maxLength` is what made the first census of this read 15 unconstrained
 * fields when the true number is 5: `legal/accept.content_hash` publishes its
 * 64-hex `pattern` and is faithful, and ten others were bounded in ways that
 * filter could not see. A census that over-reports gets switched off as noise
 * just as surely as one that under-reports gets trusted.
 */
const UNCONSTRAINED_BY_DESIGN: Record<string, string> = {
  'POST /v1/agent-sessions/{id}/history .tabId':
    'traced end to end: `z.string().optional()` in NavigateHistoryBodySchema, again in ' +
    'NavigateHistoryRequestSchema on the wire, and read by nothing — it ships gated-inert until ' +
    "A3's harness reads it. Honestly unconstrained on both sides.",
};

/**
 * Divergences that are real, named, and not yet fixed. NOT exemptions.
 *
 * Kept separate from the map above so the guard cannot be read as saying these
 * are fine. Emptying this map is the goal; adding to it needs the same evidence
 * as fixing one.
 */
const KNOWN_DIVERGENCE_DEFERRED: Record<string, string> = {
  'POST /v1/sessions .profile_id':
    'parseProfileId enforces `prof_<uuid> | <uuid>` and answers 400 otherwise, so this is the same ' +
    'defect as the agent-sessions rail fixed in V-1476. It is deferred rather than fixed because ' +
    'this endpoint publishes CreateSessionRequestSchema DIRECTLY — the runtime schema is the ' +
    'document — so adding the pattern changes which layer rejects a malformed id and what the ' +
    'error body looks like. Nothing currently exercises that path (no test posts a malformed ' +
    'profile_id anywhere), which is the first thing to fix, not the last.',
};

describe('V-927 a published bound matches the route', () => {
  it('CRITICAL every route named here still declares its bound. The published side is compared against these numbers, so if a route relaxed its cap and nothing said so, the spec arm would keep passing against a limit that no longer exists — this is the half that makes the other half mean something.', () => {
    for (const { routeFile, routePattern, field } of BOUNDS) {
      const src = readFileSync(resolve(REPO_ROOT, routeFile), 'utf8');
      expect(src.length, `${routeFile} was read`).toBeGreaterThan(500);
      expect(src, `${routeFile} declares the ${field} bound`).toMatch(routePattern);
    }
  });

  it('CRITICAL the document publishes the same bound the route enforces. A mirror that agrees on field names and required-ness can still drop a limit, and then the contract describes as valid a request the server refuses — the customer finds the cap by hitting it.', () => {
    const gaps: string[] = [];
    for (const { path, field, max } of BOUNDS) {
      const published = publishedMaxLength(path, field);
      if (published !== max) {
        gaps.push(
          `${path} ${field}: route enforces ${String(max)}, document says ${String(published)}`,
        );
      }
    }
    expect(gaps, 'the document under-specifies these bounds:').toEqual([]);
  });
  // V-1476 — see UNCONSTRAINED_BY_DESIGN above for why this is derived.
  it('CRITICAL every published request-body string is either constrained or written down as deliberately unconstrained. The roster above can only re-check bounds someone already noticed; this arm is the half that can see a NEW one, which is what three separate one-at-a-time findings of this same shape (V-1063 clone, V-1475 quote, V-1476 restore) say was missing.', () => {
    const root = JSON.parse(readFileSync(SPEC, 'utf8')) as Record<string, Record<string, unknown>>;
    const deref = (node: unknown): Record<string, unknown> => {
      let cur = node as Record<string, unknown>;
      for (let hop = 0; hop < 10 && cur && typeof cur['$ref'] === 'string'; hop += 1) {
        let target: unknown = root;
        for (const key of cur['$ref'].replace(/^#\//, '').split('/')) {
          target = (target as Record<string, unknown>)?.[key];
        }
        cur = target as Record<string, unknown>;
      }
      return cur ?? {};
    };
    const CONSTRAINTS = ['maxLength', 'minLength', 'pattern', 'enum', 'format'] as const;

    let examined = 0;
    const unconstrained: string[] = [];
    const paths = (root['paths'] ?? {}) as Record<string, Record<string, unknown>>;
    for (const [path, ops] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const body = (op as Record<string, unknown>)?.['requestBody'] as
          | Record<string, unknown>
          | undefined;
        if (!body) continue;
        const byMedia = body['content'] as Record<string, Record<string, unknown>> | undefined;
        const schema = deref(byMedia?.['application/json']?.['schema']);
        const properties = (schema['properties'] ?? {}) as Record<string, unknown>;
        for (const [field, raw] of Object.entries(properties)) {
          const prop = deref(raw);
          if (prop['type'] !== 'string') continue;
          examined += 1;
          if (!CONSTRAINTS.some((c) => c in prop)) {
            unconstrained.push(`${method.toUpperCase()} ${path} .${field}`);
          }
        }
      }
    }

    // The floor counts STRING PROPERTIES, which is what the assertion iterates —
    // not paths, and not request bodies. A walk that resolved no $ref would find
    // plenty of both and zero of these.
    expect(
      examined,
      'no published request-body string properties were read — the walk stopped resolving, and this arm would pass over an empty set',
    ).toBeGreaterThan(120);

    const declared = { ...UNCONSTRAINED_BY_DESIGN, ...KNOWN_DIVERGENCE_DEFERRED };
    const undeclared = unconstrained.filter((k) => !(k in declared)).sort();
    expect(
      undeclared,
      'this field is published with no maxLength, minLength, pattern, enum or format. If the route enforces one, the document is describing as valid a request the server refuses — publish the bound. If it really is unbounded, add it to UNCONSTRAINED_BY_DESIGN with the reason',
    ).toEqual([]);

    // And the allowlist may not outlive what it exempts: a field that gains a
    // bound must leave, or the exemption silently covers the next regression.
    const stale = Object.keys({ ...UNCONSTRAINED_BY_DESIGN, ...KNOWN_DIVERGENCE_DEFERRED })
      .filter((k) => !unconstrained.includes(k))
      .sort();
    expect(
      stale,
      'this exemption no longer matches an unconstrained published field — the field was bounded or removed, so drop the entry rather than leaving it to cover something else later',
    ).toEqual([]);
  });
  /**
   * V-1477 — the SCHEMA-level comparator.
   *
   * `lib/openapi.ts` hand-writes 99 `*OpenApi` schemas, and 21 of them have a
   * same-named exported schema in api-types: a hand copy of something that
   * already exists, kept in sync by nothing at all. Two were drifting when this
   * was written. `AccountOrganization` had lost `.max(200)` on both arrays,
   * `min(1).max(32)` on a folder name, `.max(16)` on an icon and
   * `min(1).max(24)` on a tag, and published two `.default([])` fields as
   * REQUIRED; `AccountAuditEntry` published `action` as a bare string against a
   * 46-value enum and `timestamp` without its `date-time` format.
   *
   * Pairing by FIELD name is what the sibling guard declines to guess at, and
   * rightly — `name`, `code` and `status` mean different things per endpoint.
   * `X` ↔ `XSchema` is a pairing at the SCHEMA level, where the name is unique
   * on both sides, so that ambiguity does not arise. The api-types schema is run
   * through the same generator that produces the document and the two JSON
   * Schemas are diffed: a comparison of generated artifacts rather than source
   * text, which is why nested and element-level constraints (`tags[]`,
   * `folders[].icon`) are visible to it at all.
   */
  const CONSTRAINT_KEYWORDS = [
    'maxLength',
    'minLength',
    'pattern',
    'enum',
    'format',
    'maximum',
    'minimum',
    'maxItems',
    'minItems',
  ] as const;

  /** Mirrors that intentionally differ from their namesake, with the reason. */
  const INTENTIONAL_MIRRORS: Record<string, string> = {
    AccountProxyInput:
      'a discriminatedUnion flattened into one documented object on purpose. Four scheme variants ' +
      'read badly as anyOf, and the flattened mirror carries every bound faithfully. Comparing an ' +
      'object against a union reports its entire required list as drift — an artifact of the two ' +
      "shapes, not a finding. This was the comparator's first false positive.",
  };

  type Constraints = Record<string, string>;

  const deref = (node: unknown, root: unknown): Record<string, unknown> => {
    let cur = node as Record<string, unknown>;
    for (let hop = 0; hop < 10 && cur && typeof cur['$ref'] === 'string'; hop += 1) {
      let target: unknown = root;
      for (const key of cur['$ref'].replace(/^#\//, '').split('/')) {
        target = (target as Record<string, unknown>)?.[key];
      }
      cur = target as Record<string, unknown>;
    }
    return cur ?? {};
  };

  const constraintsOf = (
    node: unknown,
    root: unknown,
    prefix = '',
    out: Constraints = {},
    depth = 0,
  ): Constraints => {
    if (depth > 6) return out;
    const schema = deref(node, root);
    const properties = (schema['properties'] ?? {}) as Record<string, unknown>;
    for (const [field, raw] of Object.entries(properties)) {
      const prop = deref(raw, root);
      const found = CONSTRAINT_KEYWORDS.filter((k) => k in prop);
      if (found.length) out[prefix + field] = [...found].sort().join(',');
      if (prop['type'] === 'array' && prop['items']) {
        const items = deref(prop['items'], root);
        const itemFound = CONSTRAINT_KEYWORDS.filter((k) => k in items);
        if (itemFound.length) out[`${prefix}${field}[]`] = [...itemFound].sort().join(',');
        constraintsOf(items, root, `${prefix}${field}[].`, out, depth + 1);
      }
      if (prop['type'] === 'object')
        constraintsOf(prop, root, `${prefix}${field}.`, out, depth + 1);
    }
    return out;
  };

  it('CRITICAL a hand-written openapi.ts mirror carries every constraint the api-types schema of the same name enforces. 21 mirrors duplicate a schema that already exists and nothing keeps them in step; two had silently dropped bounds, an enum and a date-time format by the time anyone looked. Pairing is by SCHEMA name, which is unique on both sides, so this has none of the field-name ambiguity that limits the sibling guard.', () => {
    const openapiSource = readFileSync(
      resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'),
      'utf8',
    );
    const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as Record<string, Record<string, unknown>>;
    const components = (spec['components']?.['schemas'] ?? {}) as Record<string, unknown>;
    const exported = apiTypes as unknown as Record<string, unknown>;

    // DERIVED, never a roster: a hardcoded pair list would stop covering a
    // mirror registered later, which is the exact failure the other half of
    // this file exists to correct.
    const names = [...openapiSource.matchAll(/const (\w+)OpenApi\s*=/g)].map((m) => m[1]!);
    const paired = [...new Set(names)].filter((n) => `${n}Schema` in exported);
    const registered = paired.filter((n) => n in components);

    expect(
      paired.length,
      'no mirror paired with an api-types schema — the naming convention changed and this arm would pass over an empty set',
    ).toBeGreaterThanOrEqual(20);
    expect(
      registered.length,
      'no paired mirror is a registered component — the by-name lookup broke',
    ).toBeGreaterThanOrEqual(5);

    const drift: string[] = [];
    for (const name of registered) {
      if (name in INTENTIONAL_MIRRORS) continue;
      const schema = exported[`${name}Schema`];
      const registry = new OpenAPIRegistry();
      registry.register(name, schema as never);
      const truth = new OpenApiGeneratorV31(registry.definitions).generateComponents().components
        ?.schemas?.[name] as Record<string, unknown> | undefined;
      if (!truth) continue;

      const enforced = constraintsOf(truth, { components: { schemas: { [name]: truth } } });
      const published = constraintsOf(components[name], spec);
      for (const [field, want] of Object.entries(enforced)) {
        if (published[field] !== want) {
          drift.push(
            `${name}.${field}: enforces [${want}], publishes [${published[field] ?? 'none'}]`,
          );
        }
      }

      // Required-ness drifts in the over-narrow direction: the document calling
      // a `.default([])` field mandatory tells callers to send what the server
      // is happy to omit. Unions are skipped above — anyOf has no top-level
      // required and the diff would be an artifact of the shape.
      const enforcedRequired = ((truth['required'] as string[]) ?? []).slice().sort();
      const publishedRequired = (
        ((components[name] as Record<string, unknown>)['required'] as string[]) ?? []
      )
        .slice()
        .sort();
      if (enforcedRequired.join(',') !== publishedRequired.join(',')) {
        drift.push(
          `${name}.required: enforces [${enforcedRequired.join(',') || '-'}], publishes [${publishedRequired.join(',') || '-'}]`,
        );
      }
    }

    expect(
      drift.sort(),
      'a hand-written mirror in openapi.ts disagrees with the api-types schema it copies. Delete the mirror and register the schema itself — a corrected copy is still a copy that happens to agree today',
    ).toEqual([]);
  });
});
