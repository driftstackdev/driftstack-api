// V-930 — two mirrors that missed in OPPOSITE directions.
//
// `POST /v1/profiles/{id}/transfer` — the route validates
// `recipient_account_id` against `/^acc_[0-9a-f]{8}-…/` inline and answers 400
// with `Expected "acc_<uuid>"` otherwise. The mirror published `type: string`
// and put the format in a `description`, so the only machine-readable part of
// the contract was "any string". LOOSER than the server, the usual direction.
//
// `PUT /v1/admin/incidents/{id}` — the mirror applied
// `.required({ started_at: true })`, but the route parses with plain
// `CreateIncidentRequestSchema`, where `started_at` is optional and "defaults to
// server-now if omitted". STRICTER than the server, which is the rarer direction
// and worth naming: it breaks nobody who complies, so no test and no user ever
// reports it, and a generated client simply marks a field mandatory that the API
// would have defaulted.
//
// Both are now the same object the route uses — `AccountIdSchema` for the id,
// and the unmodified request schema for the incident body. This file checks the
// property from BOTH sides, because a one-sided check would keep passing when
// the other side moves.

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
    Record<string, { requestBody?: { content: { 'application/json': { schema: Schemaish } } } }>
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

  it('CRITICAL the incident bodies require exactly what the schema requires, on BOTH verbs. POST and PUT parse with the same schema, so any difference between their published required sets is the document inventing a rule. started_at is optional and defaults to server-now, so demanding it made a generated client force a value the API would have filled in.', () => {
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
    expect(post, 'POST required set vs the schema').toEqual(enforced);
    expect(put, 'PUT required set vs the schema').toEqual(enforced);
    expect(
      put,
      'started_at is optional on the route, so the document may not demand it',
    ).not.toContain('started_at');
  });
});
