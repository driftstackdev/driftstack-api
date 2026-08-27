// V-1918. W-10 records 39 component schemas that no operation references. The
// fix is the owner's call — it changes the published contract, and V-1846/V-1877
// established that the SDK generator reads COMPONENTS rather than paths, so the
// orphans are the SDKs' public vocabulary rather than dead weight to delete.
//
// This guard does not take that decision. It only stops the set growing in
// silence. `openapi-spec-validity-invariant` catches a DANGLING $ref — an
// operation pointing at a component that does not exist; an orphan is the
// inverse, and nothing covered it, so the next `r.register(...)` without a
// matching `.openapi()` tag would have quietly made it 40.
//
// The set is frozen by NAME, not by count. A count would let one orphan be
// fixed and another appear on the same day and still pass, and it could never
// say which schema moved.
//
// Reachability is TRANSITIVE on purpose: a schema referenced only by another
// schema is not an orphan. Measured both ways at the time of writing —
// transitive gives 39, operation-$ref-only gives 43, so the naive reading
// over-accuses four schemas.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC_PATH = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

/**
 * Schemas declared under components but unreachable from any operation, following
 * $refs transitively through the schemas that ARE reached.
 */
export function orphanComponents(spec: Record<string, unknown>): string[] {
  const components = (spec.components ?? {}) as Record<string, unknown>;
  const schemas = (components.schemas ?? {}) as Record<string, unknown>;

  const collect = (node: unknown, out: Set<string>): Set<string> => {
    if (node === null || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      for (const item of node) collect(item, out);
      return out;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        const match = /^#\/components\/schemas\/(.+)$/.exec(value);
        if (match?.[1] !== undefined) out.add(match[1]);
      } else {
        collect(value, out);
      }
    }
    return out;
  };

  // An operation can reach a schema through a shared response/parameter/body too.
  const roots = collect(spec.paths ?? {}, new Set<string>());
  for (const bucket of ['responses', 'parameters', 'requestBodies', 'headers']) {
    collect(components[bucket] ?? {}, roots);
  }

  const reachable = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const name = stack.pop();
    if (name === undefined || reachable.has(name)) continue;
    reachable.add(name);
    const body = schemas[name];
    if (body !== undefined) {
      for (const next of collect(body, new Set<string>())) {
        if (!reachable.has(next)) stack.push(next);
      }
    }
  }

  return Object.keys(schemas)
    .filter((name) => !reachable.has(name))
    .sort();
}

/**
 * The orphan set as it stands while W-10 is open. Shrinking it is the point;
 * growing it is the regression. Either direction reds, and the diff names the
 * schema that moved.
 */
const FROZEN_ORPHANS: readonly string[] = [
  'Account',
  'AccountMeResponse',
  'AdminAccount',
  'AdminAuditLogEntry',
  'AgentIntent',
  'AgentSession',
  'ApiKey',
  'CaptureRequest',
  'CaptureResponse',
  'CreateApiKeyRequest',
  'CreateApiKeyResponse',
  'CreateSessionRequest',
  'CreateSessionResponse',
  'CreateWebhookRequest',
  'CreateWebhookResponse',
  'ExtractRequest',
  'ExtractResponse',
  'GetBillingStateResponse',
  'IntentResult',
  'InteractRequest',
  'InteractResponse',
  'ListDeliveriesQuery',
  'NavigateRequest',
  'NavigateResponse',
  'PaginationQuery',
  'Recipe',
  'RecipeDetail',
  'SearchRequest',
  'SearchResponse',
  'Session',
  'SessionLoginRequest',
  'SessionLoginResponse',
  'SessionState',
  'UpdateAccountMeRequest',
  'UsagePeriodSummary',
  'WaitRequest',
  'WaitResponse',
  'WebhookDelivery',
  'WebhookEndpoint',
];

describe('the OpenAPI orphan-component set does not grow while W-10 is open', () => {
  it('matches the frozen set exactly', () => {
    const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, unknown>;
    expect(orphanComponents(spec)).toEqual([...FROZEN_ORPHANS]);
  });

  it('counts a schema reachable only through another schema as NOT an orphan', () => {
    const spec = {
      paths: { '/x': { get: { responses: { '200': { $ref: '#/components/schemas/Outer' } } } } },
      components: {
        schemas: {
          Outer: { properties: { inner: { $ref: '#/components/schemas/Inner' } } },
          Inner: { type: 'object' },
          Lonely: { type: 'object' },
        },
      },
    };
    expect(orphanComponents(spec)).toEqual(['Lonely']);
  });

  it('accuses a newly registered component that no operation reaches', () => {
    const spec = {
      paths: { '/x': { get: { responses: { '200': { $ref: '#/components/schemas/Used' } } } } },
      components: { schemas: { Used: { type: 'object' }, JustAdded: { type: 'object' } } },
    };
    expect(orphanComponents(spec)).toEqual(['JustAdded']);
  });
});
