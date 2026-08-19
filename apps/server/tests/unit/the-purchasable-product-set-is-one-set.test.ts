// V-924 — the two checkout endpoints published a set of tiers that was not the
// set they accept.
//
// `POST /v1/billing/checkout-session` (Stripe) validated with
// `AccountTierSchema.refine((t) => t !== 'free' && t !== 'enterprise', …)`. A
// refine is a runtime predicate and JSON Schema cannot express it, so the
// generated OpenAPI document emitted the FULL eight-tier enum: the published
// contract advertised `free` and `enterprise` as valid tiers on an endpoint that
// answers 400 for both. That one was live and shipped.
//
// `POST /v1/billing/crypto-checkout` had the same field typed as a bare
// `z.string()` with the constraint only in a `.describe()` — so no valid-value
// list at all — while the route enforced its own `z.enum(SUPPORTED_PRODUCTS)`
// over the keys of `TIER_PRICE_CENTS`. The describe also named only the free
// tier, though enterprise is refused too.
//
// Both fields are now `z.enum(PURCHASABLE_TIERS)`, so the accepted set is what
// the document publishes. Five text pins froze the old wording and V-924 updated
// them, but no text pin can check that the SETS still coincide, which is the
// property that matters: add a priced tier to the server map without adding it to
// AccountTierSchema and the route sells something the contract refuses. That is
// what this file recomputes — including against the committed spec, which is the
// arm that would have caught the original defect.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  AccountTierSchema,
  CreateCheckoutSessionRequestSchema,
  CreateCryptoCheckoutRequestSchema,
  PURCHASABLE_TIERS,
} from '@driftstack/api-types';

import { TIER_PRICE_CENTS } from '../../src/routes/billing-crypto.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
/** The committed spec snapshot the Python SDK is generated from. */
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

/** Just enough of the OpenAPI document to read a POST body's field enum. */
interface SpecSlice {
  paths: Record<
    string,
    {
      post?: {
        requestBody?: {
          content: {
            'application/json': { schema: { properties?: Record<string, { enum?: string[] }> } };
          };
        };
      };
    }
  >;
}

/** The enum the published document advertises for a request field. */
function publishedEnum(path: string, field: string): string[] | undefined {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as SpecSlice;
  const schema = spec.paths[path]?.post?.requestBody?.content['application/json'].schema;
  return schema?.properties?.[field]?.enum;
}

/** Tiers that are not self-serve purchasable; excluded from PURCHASABLE_TIERS. */
const NOT_PURCHASABLE = ['free', 'enterprise'] as const;

/** A well-formed body; only `product` varies across the arms below. */
function bodyWith(product: string): Record<string, unknown> {
  return { product, price_cents: 24_900, price_currency: 'USD' };
}

describe('V-924 the purchasable product set is one set', () => {
  it('CRITICAL both sides were really read. Every arm below compares two derived sets, and an empty set on either side would make the comparisons vacuously agree — the failure shape this sweep kept finding in guards that reported an absence.', () => {
    expect(Object.keys(TIER_PRICE_CENTS).length, 'priced tiers in the server map').toBeGreaterThan(
      3,
    );
    expect(AccountTierSchema.options.length, 'tiers in the published enum').toBeGreaterThan(
      Object.keys(TIER_PRICE_CENTS).length,
    );
  });

  it('CRITICAL the server-priced product set equals the published purchasable set. The route accepts exactly the keys of its price map; the published schema accepts the tier enum minus free and enterprise. If those drift, a customer either gets a 400 the OpenAPI document did not predict, or the SDK type rejects a tier the server would have sold them.', () => {
    const priced = [...Object.keys(TIER_PRICE_CENTS)].sort();
    const publishedPurchasable = AccountTierSchema.options
      .filter((t) => !(NOT_PURCHASABLE as readonly string[]).includes(t))
      .sort();
    expect(priced, 'server price-map keys vs published purchasable tiers').toEqual(
      publishedPurchasable,
    );
  });

  it('CRITICAL the published schema accepts every tier the server prices. Behavioural rather than textual: a pin on the refine source would still pass if the enum it refines lost a member, because the refine only subtracts.', () => {
    for (const product of Object.keys(TIER_PRICE_CENTS)) {
      const parsed = CreateCryptoCheckoutRequestSchema.safeParse(bodyWith(product));
      expect(parsed.success, `${product} is priced by the server and must be publishable`).toBe(
        true,
      );
    }
  });

  it('CRITICAL the published schema refuses the two non-purchasable tiers. This is the half the old bare string could not express: `free` and `enterprise` parse fine as strings, and the server rejects both, so the spec used to promise a request the API would refuse.', () => {
    for (const product of NOT_PURCHASABLE) {
      const parsed = CreateCryptoCheckoutRequestSchema.safeParse(bodyWith(product));
      expect(parsed.success, `${product} must not validate as a crypto checkout product`).toBe(
        false,
      );
    }
  });

  it('CRITICAL an unknown product string is refused. The point of the change: under the previous bare string this parsed, and the customer learned otherwise from a 400.', () => {
    expect(CreateCryptoCheckoutRequestSchema.safeParse(bodyWith('pro')).success).toBe(false);
    expect(CreateCryptoCheckoutRequestSchema.safeParse(bodyWith('')).success).toBe(false);
  });

  it('CRITICAL PURCHASABLE_TIERS is exactly AccountTierSchema minus free and enterprise. The tuple is spelled out so it survives into JSON Schema, which means it can drift from the tier enum it is meant to mirror — add a tier to AccountTierSchema and this fails rather than quietly leaving it unsellable.', () => {
    const derived = AccountTierSchema.options.filter(
      (t) => !(NOT_PURCHASABLE as readonly string[]).includes(t),
    );
    expect([...PURCHASABLE_TIERS].sort(), 'explicit tuple vs derived set').toEqual(derived.sort());
  });

  it('CRITICAL both checkout endpoints accept the same set. Stripe and crypto are two ways to buy the same tiers; if their accept-sets diverge a customer can buy a tier with one rail and not the other, which is the kind of split nobody notices until a support ticket.', () => {
    for (const tier of AccountTierSchema.options) {
      const stripe = CreateCheckoutSessionRequestSchema.safeParse({
        tier,
        billing_period: 'monthly',
      }).success;
      const crypto = CreateCryptoCheckoutRequestSchema.safeParse(bodyWith(tier)).success;
      expect(crypto, `${tier}: stripe=${String(stripe)} crypto=${String(crypto)}`).toBe(stripe);
    }
  });

  it('CRITICAL the PUBLISHED document advertises exactly the purchasable tiers, for both rails. This is the arm that would have caught the original defect: both fields were `AccountTierSchema.refine(...)`, and a refine is a runtime predicate JSON Schema cannot express — so the generated spec emitted all eight tiers and told customers `free` and `enterprise` were valid on endpoints that answer 400 for both. Behaviour was always right; the contract was not.', () => {
    for (const [path, field] of [
      ['/v1/billing/checkout-session', 'tier'],
      ['/v1/billing/crypto-checkout', 'product'],
    ] as const) {
      const advertised = publishedEnum(path, field);
      expect(advertised, `${path} must publish an enum for ${field}`).toBeDefined();
      expect([...(advertised ?? [])].sort(), `${path} ${field} advertised values`).toEqual(
        [...PURCHASABLE_TIERS].sort(),
      );
      for (const excluded of NOT_PURCHASABLE) {
        expect(advertised ?? [], `${path} must not advertise ${excluded}`).not.toContain(excluded);
      }
    }
  });

  it('CRITICAL the documented example body still validates. /docs/guides/paying-with-crypto tells customers to POST product team_manual at 24900 — narrowing a published type is only safe if the copy-paste example survives it, so that is asserted rather than assumed.', () => {
    const documented = { product: 'team_manual', price_cents: 24_900, price_currency: 'USD' };
    const parsed = CreateCryptoCheckoutRequestSchema.safeParse(documented);
    expect(parsed.success, 'the documented curl body').toBe(true);
    expect(TIER_PRICE_CENTS['team_manual'], 'and the documented price matches the server map').toBe(
      24_900,
    );
  });
});
