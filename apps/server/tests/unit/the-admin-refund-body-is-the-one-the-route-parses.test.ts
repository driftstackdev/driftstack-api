// V-929 — the published body for `POST /v1/admin/accounts/{id}/refund-record`
// could not have succeeded.
//
// The route parses with `RecordRefundRequestSchema`, which REQUIRES
// `external_reference` (the Stripe charge / payment_intent / invoice id being
// refunded, 3–120 chars). The hand-written mirror in `openapi.ts` omitted that
// field entirely, so a request built from the document was missing a required
// key every time. It was wrong three further ways at once:
//
//   • it advertised `stripe_refund_id`, a field that appears NOWHERE else in the
//     repository — not in the route, not in a schema, not in the admin panel;
//   • it marked `currency` required, where the route defaults it to USD;
//   • it published a 2000-character `reason` cap against an enforced 500.
//
// Nobody was broken by it: the admin panel posts `external_reference` correctly
// (account-detail.astro), so the UI works and only the contract was wrong. The
// cost is that the document was unusable for anyone building against it, which
// on an operator endpoint means the first integration attempt fails and the
// second is written by reading the source.
//
// Fixed by pointing the document at `RecordRefundRequestSchema` itself rather
// than a corrected copy. This file guards the property that made the copy
// possible: that the document's required set is the schema's required set.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RecordRefundRequestSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');
const REFUND_PATH = '/v1/admin/accounts/{id}/refund-record';

interface Prop {
  minLength?: number;
  maxLength?: number;
}
interface SpecShape {
  paths: Record<
    string,
    {
      post?: {
        requestBody?: {
          content: {
            'application/json': {
              schema: { required?: string[]; properties?: Record<string, Prop> };
            };
          };
        };
      };
      patch?: {
        requestBody?: {
          content: {
            'application/json': { schema: { $ref?: string; minProperties?: number } };
          };
        };
      };
    }
  >;
  components: { schemas: Record<string, { minProperties?: number }> };
}

function spec(): SpecShape {
  return JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape;
}

function publishedRefundBody(): { required?: string[]; properties?: Record<string, Prop> } {
  const s = spec().paths[REFUND_PATH]?.post?.requestBody?.content['application/json'].schema;
  return s ?? {};
}

/** Keys the schema requires, i.e. those that are not optional. */
function schemaRequiredKeys(): string[] {
  const shape = (
    RecordRefundRequestSchema as unknown as { shape: Record<string, { isOptional(): boolean }> }
  ).shape;
  return Object.entries(shape)
    .filter(([, v]) => !v.isOptional())
    .map(([k]) => k)
    .sort();
}

describe('V-929 the admin refund body is the one the route parses', () => {
  it('CRITICAL both sides parse, and the schema really has a required set. The arms below compare two key lists; if the schema walk returned nothing they would agree over empty sets, which is the false green this sweep keeps finding.', () => {
    expect(schemaRequiredKeys().length, 'required keys on the real schema').toBeGreaterThan(1);
    expect(
      Object.keys(publishedRefundBody().properties ?? {}).length,
      'published properties',
    ).toBeGreaterThan(2);
  });

  it('CRITICAL the document requires exactly what the schema requires. The mirror omitted `external_reference`, so a body built from the document was missing a required key and the endpoint answered 400 every time — the document described a request that could not succeed.', () => {
    expect(
      [...(publishedRefundBody().required ?? [])].sort(),
      'published vs enforced required set',
    ).toEqual(schemaRequiredKeys());
  });

  it('CRITICAL the document does not advertise a field that does not exist. `stripe_refund_id` appeared only in the mirror — no route reads it, no schema declares it, the admin panel never sends it. A documented field with no implementation is worse than an undocumented one: it invites a caller to populate it and to believe it did something.', () => {
    const props = Object.keys(publishedRefundBody().properties ?? {});
    expect(props, 'the phantom field must not return').not.toContain('stripe_refund_id');
    expect(props, 'and the real identifier must be published').toContain('external_reference');
  });

  it('CRITICAL the published reason cap is the enforced one. The mirror said 2000 where the route enforces 500, so an operator could write a note the document allowed and the API refused.', () => {
    expect(publishedRefundBody().properties?.['reason']?.maxLength, 'reason cap').toBe(500);
  });

  it('CRITICAL the bundled-llm settings body states its at-least-one rule in JSON Schema, not only in prose. The route refines "at least one of consent / monthly_cap_usd_cents", and a refine never reaches the document (V-924), so the published body had no `required` at all and described `{}` as valid against an endpoint that answers 400 for it. `minProperties` is the keyword that carries it.', () => {
    const s = spec();
    const ref =
      s.paths['/v1/account/me/bundled-llm-settings']?.patch?.requestBody?.content[
        'application/json'
      ].schema;
    const component = ref?.$ref?.split('/').pop();
    expect(component, 'the patch body is a named component').toBe('PatchBundledLlmRequest');
    expect(
      s.components.schemas[component ?? '']?.minProperties,
      'at least one property is required',
    ).toBe(1);
  });
});
