// What happens to a field the customer sends that we do not recognise.
//
// Zod 3's `z.object()` STRIPS unknown keys. The customer-facing request schemas
// in `api-types` are almost all plain `z.object(...)`, the routes validate with
// `safeParse`, and there is no Fastify body schema in front — so an
// unrecognised field is silently discarded and the request succeeds.
//
// The consequence is concrete rather than theoretical. `POST /v1/profiles`
// accepts `archetype`, and the schema documents that omitting it defaults to
// `LOCKED_ARCHETYPE_ID` server-side. A customer who types `achetype` gets
// **201 Created** with the default archetype — for a product whose whole value
// is which device you appear to be, that is a silent identity substitution
// reported as success, and nothing in the response says so.
//
// This file does NOT change that. Making the request schemas strict is a
// breaking change for any client already sending extra fields, and that is a
// product decision, not a test's. What it does is make the current contract
// explicit, and pin the fact that a small number of schemas already behave the
// opposite way, so whichever way the inconsistency is resolved it is resolved
// on purpose.
//
// Deliberately behavioural. An earlier draft also carried a census of how many
// request schemas were strict, scanned out of the source. The scan was wrong —
// it captured only part of a discriminated union, and a `strict >= objects`
// test hid that — so it reported a number that looked like measurement and was
// not. It was removed rather than patched: the assertions below need no scan.
//
// Imported from SOURCE, not from the package entry point. `@driftstack/api-types`
// resolves to `dist/`, which is only rebuilt by `pretest`; a scoped `vitest`
// run would therefore assert against whatever was last built, and a change to
// the schema would not be observable here at all. Verified by mutation: editing
// the source is invisible through the package import and visible through this.

import { describe, expect, it } from 'vitest';

import {
  CreateProfileRequestSchema,
  AccountProxyInputSchema,
} from '../../../../packages/api-types/src/profiles.js';

describe('unknown fields in a request body are silently dropped — the current contract, pinned', () => {
  it('CRITICAL an unrecognised field is DROPPED and the request still validates. A customer who mistypes `archetype` on profile creation is told 201 Created while the server silently substitutes the default archetype — a different device identity than they asked for, reported as success.', () => {
    const parsed = CreateProfileRequestSchema.safeParse({
      name: 'my-profile',
      achetype: 'iphone13_ios16_safari16', // deliberate typo of `archetype`
    });

    expect(parsed.success, 'the typo does not make the request invalid').toBe(true);
    if (parsed.success) {
      expect(parsed.data, 'the mistyped key is discarded, not preserved').not.toHaveProperty(
        'achetype',
      );
      expect(
        parsed.data,
        'and no archetype was selected, so the server default applies',
      ).not.toHaveProperty('archetype');
    }
  });

  it('CRITICAL the schema is genuinely validating, so the acceptance above is a real policy rather than a schema that accepts anything. A missing required field must still be rejected.', () => {
    const parsed = CreateProfileRequestSchema.safeParse({ description: 'no name given' });
    expect(parsed.success, 'a missing required field is still an error').toBe(false);
  });

  it('CRITICAL the proxy input schema is strict and rejects the very field profile creation would silently drop. Two schemas behaving opposite to the rest is the inconsistency worth seeing; this pins it so resolving it either way is a decision.', () => {
    // DIFFERENTIAL. The union discriminates on `scheme`, so a payload missing
    // it is rejected for a reason that has nothing to do with strictness. The
    // accepted arm is what makes the rejection attributable to the extra key.
    const valid = { scheme: 'socks5', label: 'p', host: 'proxy.example.com', port: 1080 };

    expect(
      AccountProxyInputSchema.safeParse(valid).success,
      'the baseline payload is valid, so the rejection below is caused by the extra key alone',
    ).toBe(true);

    expect(
      AccountProxyInputSchema.safeParse({ ...valid, unexpected_field: 'x' }).success,
      'a strict schema REJECTS the unknown field profile creation would silently drop',
    ).toBe(false);
  });
});
