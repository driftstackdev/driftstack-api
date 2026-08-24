// V-930 — two mirrors that missed in OPPOSITE directions.
//
// `POST /v1/profiles/{id}/transfer` — the route validates
// `recipient_account_id` against `/^acc_[0-9a-f]{8}-…/` inline and answers 400
// with `Expected "acc_<uuid>"` otherwise. The mirror published `type: string`
// and put the format in a `description`, so the only machine-readable part of
// the contract was "any string". LOOSER than the server, the usual direction.
//
// `PUT /v1/admin/incidents/{id}` — the document requires `started_at` while the
// SCHEMA it is built from marks that field optional. V-930 read that as the
// document being stricter than the server and loosened it; V-931 put it back,
// because the enforcement is not in the schema at all. It is a hand-written check
// two lines below the handler's `safeParse`:
//
//     if (parsed.data.started_at === undefined) {
//       throw new BadRequestError('started_at is required for idempotent …');
//     }
//
// Without it the upsert is not idempotent — every retry would take a different
// server-now timestamp — and the admin panel both sends the field and compares it
// back on retry. So the arm below asserts the document requires MORE than the
// schema here, and pins the route-side check that earns it. Reading which schema
// a handler parses with is not the same as reading what the handler validates.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AccountIdSchema, CreateIncidentRequestSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');
const PROFILES_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts');

interface Schemaish {
  required?: string[];
  properties?: Record<string, { pattern?: string }>;
  $ref?: string;
}
interface SpecShape {
  paths: Record<
    string,
    Record<
      string,
      {
        requestBody?: {
          required?: boolean;
          content: { 'application/json': { schema: Schemaish } };
        };
      }
    >
  >;
  components: { schemas: Record<string, Schemaish> };
}

function spec(): SpecShape {
  return JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape;
}

function body(path: string, method: string): Schemaish {
  const s = spec();
  const raw = s.paths[path]?.[method]?.requestBody?.content['application/json'].schema ?? {};
  return raw.$ref ? (s.components.schemas[raw.$ref.split('/').pop() ?? ''] ?? {}) : raw;
}

/** The regex `AccountIdSchema` enforces, read off the schema itself. */
function accountIdPattern(): string {
  const checks = (
    AccountIdSchema as unknown as { _def: { checks: { kind: string; regex?: RegExp }[] } }
  )._def.checks;
  const regex = checks.find((c) => c.kind === 'regex')?.regex;
  return regex?.source ?? '';
}

describe('V-930 the document is neither looser nor stricter than the route', () => {
  it('CRITICAL the schema really carries a pattern and the route really carries its own. Both comparisons below are equality checks; two empty strings are equal, so an unread schema or an unmatched route would agree having compared nothing.', () => {
    expect(accountIdPattern(), 'AccountIdSchema regex').toMatch(/^\^acc_/);
    expect(readFileSync(PROFILES_ROUTE, 'utf8').length, 'profiles route read').toBeGreaterThan(
      1000,
    );
  });

  it('CRITICAL the transfer body publishes the format the route enforces. The route rejects anything that is not acc_<uuid>, and the document said "string" — so the machine-readable contract admitted every value the endpoint refuses.', () => {
    const published = body('/v1/profiles/{id}/transfer', 'post').properties?.[
      'recipient_account_id'
    ]?.pattern;
    expect(published, 'published pattern').toBe(accountIdPattern());
    // And the route still enforces it inline — a one-sided check would pass if
    // the route dropped its guard and the document kept advertising one.
    expect(
      readFileSync(PROFILES_ROUTE, 'utf8'),
      'the route still validates the prefixed-id shape',
    ).toMatch(
      /\^acc_\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$/,
    );
  });

  it('CRITICAL the incident PUT publishes the extra requirement its handler enforces, and POST does not. The two verbs share a schema, so the published difference between them can only be justified by code — here a check below the parse that refuses a missing started_at, without which the idempotent upsert would take a fresh server-now timestamp on every retry.', () => {
    const shape = (
      CreateIncidentRequestSchema as unknown as {
        shape: Record<string, { isOptional(): boolean }>;
      }
    ).shape;
    const enforced = Object.entries(shape)
      .filter(([, v]) => !v.isOptional())
      .map(([k]) => k)
      .sort();
    const post = [...(body('/v1/admin/incidents', 'post').required ?? [])].sort();
    const put = [...(body('/v1/admin/incidents/{id}', 'put').required ?? [])].sort();
    expect(post, 'POST publishes exactly the schema requirements').toEqual(enforced);
    expect(put, 'PUT publishes the schema requirements plus started_at').toEqual(
      [...enforced, 'started_at'].sort(),
    );
    // The route-side half. Without this the arm above would keep passing if the
    // handler dropped its check while the document went on advertising the rule —
    // which is the direction V-930 mistook for a documentation defect.
    expect(
      readFileSync(resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts'), 'utf8'),
      'the PUT handler still refuses a missing started_at',
    ).toMatch(/started_at is required for idempotent incident creation/);
  });

  it("V-1532 CRITICAL a request body whose schema has a required field is itself marked required. The two arms above compare a single field's shape; this compares whether the BODY must be sent at all, which is a different key — `requestBody.required` sits beside `content`, not inside the schema, so a schema listing ten required properties still reads as an optional body to anything generating a client from this document. It was false on SIXTY-SIX operations including POST /v1/auth/login, whose handler does `LoginRequestSchema.safeParse(req.body)` and answers 400 when the body is absent. Derived from the document rather than listed, so a new operation cannot arrive unmarked.", () => {
    const s = spec();
    const resolveSchema = (raw: Schemaish | undefined): Schemaish => {
      let node = raw ?? {};
      const seen = new Set<string>();
      while (node.$ref !== undefined) {
        const name = node.$ref.split('/').pop() ?? '';
        if (seen.has(name)) return {};
        seen.add(name);
        node = s.components.schemas[name] ?? {};
      }
      return node;
    };

    let bodies = 0;
    const understated: string[] = [];
    for (const [path, operations] of Object.entries(s.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const requestBody = operation.requestBody;
        if (requestBody === undefined) continue;
        bodies += 1;
        const schema = resolveSchema(requestBody.content['application/json']?.schema);
        const requires = (schema.required ?? []).length > 0;
        if (requires && requestBody.required !== true) {
          understated.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    // An emptiness assertion is satisfied by a document that parsed to nothing.
    expect(bodies, 'operations declaring a JSON request body').toBeGreaterThan(80);
    expect(
      understated.sort(),
      'these operations require fields in the body but do not require the body, so a generated ' +
        'client treats it as omissible on an endpoint that answers 400 without it',
    ).toEqual([]);
  });
});
